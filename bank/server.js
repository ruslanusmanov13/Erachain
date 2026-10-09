'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NodeBackend } = require('./lib/nodeBackend');
const { DemoBackend } = require('./lib/demoBackend');
const { JsonStore } = require('./lib/store');
const { Gateway } = require('./lib/bank/gateway');
const { SevenPayClient, SevenPayDemo, SwapService } = require('./lib/sevenpay');
const { Staff, ROLES } = require('./lib/staff');
const { SbpService, TochkaSbpClient, SbpEmulator } = require('./lib/sbp');
const { Invoices } = require('./lib/invoices');
const { Loans } = require('./lib/loans');
const { OwnerKey, generateSeed, formatSeed, normalizeSeed, seedBytes, sameSeed, base58Decode, base58Encode } = require('./lib/seed');
const { deriveAccounts } = require('./lib/erakeys');
const { Clients } = require('./lib/clients');
const { parseRaw, verifySig } = require('./lib/eratx');
const { addressOf } = require('./lib/erakeys');
const formats = require('./lib/bank/formats');
const v = require('./lib/validate');

const { BankError } = v;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024; // выписки банка могут быть большими
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
};

/**
 * options.store — хранилище данных шлюза (JsonStore), options.webhookSecret — секрет вебхука банка,
 * options.corsOrigins — список origin, которым разрешены запросы (для веб-версии на другом домене).
 */
function createApp(backend, options = {}) {
    const sessions = new Map(); // token -> { password, user, expires }; пароль только в памяти сервера
    const failures = new Map(); // ip -> { count, until } — защита от подбора пароля
    const store = options.store || new JsonStore(null, {});
    const gateway = new Gateway(backend, store);
    const staff = new Staff(store);
    const invoices = new Invoices(backend, store);
    const loans = new Loans(backend, store);
    const ownerKey = new OwnerKey(store);
    const clients = new Clients(store);
    // порт сети для подписи транзакций на устройстве: 9046 — основная, 9066 — тестовая (RPC-порт ноды − 2)
    const networkPort = options.networkPort || backend.networkPort || 9046;
    const walletNonces = new Map(); // одноразовые коды входа кошелька на устройстве
    // код первого запуска: без него чужой не создаст кошелёк, если сервер виден из сети раньше владельца
    const setupCode = options.setupCode || null;
    // демо: готовые сотрудники, открытая смена и привязанная сид-фраза, чтобы всё можно было опробовать сразу
    if (options.demoStaff) {
        for (const u of options.demoStaff.users) if (!store.data.staff.some((x) => x.login === u.login)) staff.create(u);
        if (backend.walletExists !== false) {
            staff.openShift(options.demoStaff.walletPassword, staff.owner());
            if (backend.seed && !ownerKey.bound()) ownerKey.bind(backend.seed, options.demoStaff.walletPassword);
        }
    }
    // обменник 7Pay: options.sevenpay — клиент API (SevenPayClient или SevenPayDemo); без него раздел выключен
    const swap = options.sevenpay ? new SwapService(options.sevenpay, backend, store) : null;
    const requireSwap = () => {
        if (!swap) throw new BankError('Обменник 7Pay не подключён: задайте SEVENPAY_URL на сервере банка', 503);
        return swap;
    };
    const corsOrigins = new Set(options.corsOrigins || []);
    // СБП: начисление идёт паролем открытой смены (у сервера нет пароля кошелька, пока смена закрыта)
    const sbp = options.sbpClient ? new SbpService(options.sbpClient, backend, store, () => staff.walletPassword({ password: null })) : null;
    const requireSbp = () => {
        if (!sbp) throw new BankError('Приём платежей по СБП не подключён: задайте TOCHKA_SBP_TOKEN и реквизиты на сервере', 503);
        return sbp;
    };
    if (sbp && options.sbpIntervalMs !== 0) {
        const timer = setInterval(() => sbp.tick().catch((e) => console.error('sbp:', e.message)), options.sbpIntervalMs || 4000);
        if (timer.unref) timer.unref();
    }
    // счета на оплату: подтверждение своих оплат и обратные вызовы магазинам; входящие оплаты — при открытой смене
    if (options.jobsIntervalMs !== 0) {
        const timer = setInterval(async () => {
            try {
                await invoices.tick();
                if (staff.shift && store.data.invoicesIssued.some((i) => !['paid'].includes(i.status))) {
                    await invoices.checkIssued(staff.walletPassword({ password: null }));
                }
            } catch (e) {
                if (e.status !== 502) console.error('invoices:', e.message);
            }
        }, options.jobsIntervalMs || 20000);
        if (timer.unref) timer.unref();
    }

    // ограничение публичного создания QR: не больше 10 заказов за 10 минут с одного адреса
    const publicHits = new Map();
    function publicLimit(ip) {
        const now = Date.now();
        const list = (publicHits.get(ip) || []).filter((t) => now - t < 600000);
        if (list.length >= 10) throw new BankError('Слишком много запросов, попробуйте через несколько минут', 429);
        list.push(now);
        publicHits.set(ip, list);
    }

    // password — пароль кошелька (только у владельца), у сотрудника null: подпись идёт по открытой смене
    function openSession(password, user) {
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, { password, user, expires: Date.now() + SESSION_TTL_MS });
        return token;
    }

    function requireSession(req) {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const s = sessions.get(token);
        if (!s || s.expires < Date.now()) {
            sessions.delete(token);
            throw new BankError('Сессия истекла, войдите снова', 401);
        }
        if (s.user.clientId) {
            // клиент (или кабинет счёта клиента): доступ, пока клиент не приостановлен банком
            const c = store.data.clients.find((x) => x.id === s.user.clientId);
            if (!c || c.disabled) {
                sessions.delete(token);
                throw new BankError('Доступ клиента приостановлен банком', 401);
            }
            s.scope = s.user.role === 'account' ? [s.user.address] : clients.addresses(c);
        } else if (s.user.role === 'wallet') {
            s.scope = s.user.addresses;
        } else if (s.user.role === 'account') {
            // кабинет по ключу счёта владельца живёт, пока включён вход по сид-фразе
            if (!ownerKey.hasAccount(s.user.address)) {
                sessions.delete(token);
                throw new BankError('Вход по ключу счёта отключён владельцем', 401);
            }
            s.scope = [s.user.address];
        } else if (s.user.role !== 'owner') {
            // отключённый или удалённый сотрудник теряет доступ сразу
            const u = store.data.staff.find((x) => x.id === s.user.id);
            if (!u || u.disabled) {
                sessions.delete(token);
                throw new BankError('Доступ отозван администратором', 401);
            }
            s.user = staff.public(u);
        }
        s.expires = Date.now() + SESSION_TTL_MS;
        return {
            token,
            user: s.user,
            raw: s,
            scope: s.scope || null, // счета клиента или кабинета по ключу; null — счета банка
            // пароль кошелька для операции: свой у владельца, у сотрудника — открытой смены;
            // у кошелька на устройстве пароля нет — он подписывает сам, сервер только читает и отправляет
            get password() { return s.user.role === 'wallet' ? null : staff.walletPassword(s); },
        };
    }

    // права на маршрут: GET — просмотр, остальное — по разделу; список прав — все обязательны
    function permsFor(method, pathname) {
        if (pathname === '/api/logout' || pathname === '/api/me' || pathname === '/api/session/account') return [];
        if (pathname === '/api/keys') return []; // ключи есть только у сессии, вошедшей фразой
        if (pathname.startsWith('/api/wallet/') || pathname.startsWith('/api/pubkey/') || pathname.startsWith('/api/tx/')) return ['read'];
        if (pathname.startsWith('/api/clients')) return ['staff'];
        if (pathname.startsWith('/api/security')) return ['wallet'];
        if (pathname.startsWith('/api/loans')) {
            if (method === 'GET' || pathname === '/api/loans/preview') return ['read'];
            if (/\/(sign|vouch|issue|repay|confiscate)$/.test(pathname)) return ['sign'];
            return ['gateway']; // черновик договора, проверка погашений, отмена
        }
        if (pathname.startsWith('/api/invoices/')) {
            if (method === 'GET' || pathname === '/api/invoices/find' || pathname === '/api/invoices/check') return ['read'];
            return pathname === '/api/invoices/settings' ? ['settings'] : ['sign'];
        }
        if (pathname.startsWith('/api/sbp/')) {
            if (method === 'GET') return ['read'];
            return pathname === '/api/sbp/settings' ? ['settings'] : ['gateway'];
        }
        if (pathname.startsWith('/api/staff') || pathname.startsWith('/api/shift') || pathname === '/api/audit') return ['staff'];
        if (pathname === '/api/bank/statement') return ['statements'];
        if (pathname === '/api/bank/settings') return method === 'GET' ? ['gateway'] : ['settings'];
        if (pathname.startsWith('/api/bank/')) {
            if (/\/(credit|refund)$/.test(pathname)) return ['gateway', 'sign'];
            return ['gateway'];
        }
        if (method === 'GET' || pathname === '/api/swap/quote') return ['read'];
        return ['sign'];
    }

    function checkThrottle(ip) {
        const f = failures.get(ip);
        if (f && f.until > Date.now()) {
            throw new BankError(`Слишком много попыток входа. Повторите через ${Math.ceil((f.until - Date.now()) / 1000)} с`, 429);
        }
    }

    function loginFailed(ip) {
        const f = failures.get(ip) || { count: 0, until: 0 };
        f.count += 1;
        if (f.count >= 5) f.until = Date.now() + Math.min(2 ** (f.count - 5) * 30000, 3600000);
        failures.set(ip, f);
    }

    async function readRaw(req) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY) throw new BankError('Слишком большой запрос', 413);
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    async function readJson(req) {
        if (req.bankBody !== undefined) return req.bankBody; // тело уже прочитано (проверка кабинета)
        const raw = await readRaw(req);
        if (!raw.length) return {};
        try {
            req.bankBody = JSON.parse(raw.toString('utf8')); // для журнала действий
            return req.bankBody;
        } catch (e) {
            throw new BankError('Некорректный JSON');
        }
    }

    function file(filename, mime, content) {
        return { file: true, filename, mime, content };
    }

    async function statement(url, session) {
        const address = url.searchParams.get('address');
        if (!v.isAddress(address)) throw new BankError('Неверный адрес');
        const asset = url.searchParams.get('asset') ? Number(url.searchParams.get('asset')) : null;
        const from = url.searchParams.get('from') ? Date.parse(url.searchParams.get('from')) : 0;
        const toRaw = url.searchParams.get('to') ? Date.parse(url.searchParams.get('to')) : Date.now();
        const to = toRaw + (url.searchParams.get('to') ? 86400000 - 1 : 0); // до конца дня
        if (!Number.isFinite(from) || !Number.isFinite(to)) throw new BankError('Неверный период');
        const format = url.searchParams.get('format') || 'csv';
        const ops = (await backend.history(address, 200, session.password))
            .filter((o) => (o.timestamp || 0) >= from && (o.timestamp || 0) <= to)
            .filter((o) => asset === null || Number(o.asset) === asset);
        const assetName = asset === null ? '' : (ops.find((o) => o.assetName) || {}).assetName || '#' + asset;
        const s = gateway.settings();
        const meta = {
            address, assetName, from: from || (ops.length ? ops[ops.length - 1].timestamp : Date.now()), to: Math.min(to, Date.now()),
            organization: s.organization, currency: asset !== null && asset === s.tokenAsset ? s.currency : (assetName || 'XXX').slice(0, 3).toUpperCase(),
            scale: asset !== null && asset === s.tokenAsset ? 2 : 8,
        };
        const base = `statement-${address.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`;
        if (format === '1c') return file(base + '.1c.txt', 'text/plain; charset=windows-1251', formats.statement1C(ops, meta));
        if (format === 'camt053') return file(base + '.camt053.xml', 'application/xml', formats.camt053(ops, meta));
        if (format === 'csv') return file(base + '.csv', 'text/csv; charset=utf-8', formats.statementCsv(ops, meta));
        throw new BankError('Формат: csv, 1c или camt053');
    }

    // кабинет одного счёта: какие маршруты доступны и какое поле запроса — счёт, от имени которого подпись
    const CABINET_SIGNER = [
        ['/api/transfer', 'from'], ['/api/transfer/batch', 'from'], ['/api/messages', 'from'],
        ['/api/assets', 'creator'], ['/api/polls', 'creator'], [/^\/api\/polls\/\d+\/vote$/, 'voter'],
        ['/api/exchange/orders', 'creator'], ['/api/exchange/cancel', 'creator'],
        ['/api/documents', 'creator'], ['/api/documents/vouch', 'creator'],
        ['/api/persons', 'creator'], ['/api/persons/certify', 'creator'],
    ];
    const CABINET_GET = /^\/api\/(me|network|accounts|assets(\/\d+|\/types)?|polls(\/\d+)?|persons(\/\d+)?|catalog\/(statuses|templates)|exchange\/\d+\/\d+|documents\/verify\/\w+)$/;
    const CABINET_GET_OWN = /^\/api\/(?:accounts\/([^/]+)\/history|exchange\/orders\/([^/]+)|messages\/([^/]+))$/;

    // клиент и кабинет по ключу: только свои счета (scope)
    async function checkCabinet(req, url, session) {
        const p = url.pathname;
        const own = new Set(session.scope);
        const denied = () => new BankError('Здесь доступны только операции ваших счетов', 403);
        const isClient = session.user.role === 'client';
        const isWallet = session.user.role === 'wallet';
        if (req.method === 'GET') {
            if (CABINET_GET.test(p) || (isClient && p === '/api/keys') || /^\/api\/(pubkey|tx)\/[1-9A-HJ-NP-Za-km-z]+(\/data)?$/.test(p) || p === '/api/wallet/params') return;
            const m = p.match(CABINET_GET_OWN);
            if (m && own.has(decodeURIComponent(m[1] || m[2] || m[3]))) return;
            if (p === '/api/bank/statement' && own.has(url.searchParams.get('address'))) return;
            throw denied();
        }
        if (p === '/api/logout' || ((isClient || isWallet) && p === '/api/session/account')) return;
        if (isWallet && p === '/api/wallet/broadcast') return; // отправитель проверяется в обработчике по подписи
        if (isWallet) throw new BankError('В кошельке на устройстве операции подписываются на телефоне — обновите приложение', 403);
        const rule = CABINET_SIGNER.find(([r]) => (typeof r === 'string' ? r === p : r.test(p)));
        if (!rule || req.method !== 'POST') throw denied();
        const body = await readJson(req);
        if (!own.has(body[rule[1]])) throw denied();
    }

    // в кошельке ноды должны быть все 21 счёт сид-фразы: недостающие импортируем по их приватным ключам
    async function ensureAccounts(password, derived) {
        const have = new Set(await backend.walletAddresses(password));
        for (const a of derived) if (!have.has(a.address)) await backend.importKey(a.privateKey, password);
        return derived.length;
    }

    // счета для списка: у клиента и кабинета — свои; у банка — кошелёк без счетов клиентов
    async function accountsFor(session) {
        const active = session.raw.active;
        let list;
        if (session.scope) {
            const addrs = active ? [active] : session.scope;
            list = backend.balances
                ? await Promise.all(addrs.map(async (address) => ({ address, balances: await backend.balances(address) })))
                : (await backend.accounts(session.password)).filter((a) => addrs.includes(a.address))
                    .sort((x, y) => addrs.indexOf(x.address) - addrs.indexOf(y.address));
        } else {
            const foreign = new Set(store.data.clients.flatMap((c) => clients.addresses(c)));
            list = (await backend.accounts(session.password)).filter((a) => !foreign.has(a.address) && (!active || a.address === active));
        }
        const nums = new Map();
        const ids = [ownerKey.identity(), ...store.data.clients].filter(Boolean);
        for (const id of ids) for (const a of id.accounts || []) nums.set(a.address, a.n);
        return list.map((a) => ({ ...a, n: nums.get(a.address) || null }));
    }

    function clientSession(c, walletPassword, keys = null, account = null) {
        const user = account
            ? { id: `key:${account.address}`, clientId: c.id, login: 'счёт №' + account.n, name: `Счёт №${account.n}`, role: 'account', address: account.address }
            : { id: 'client:' + c.id, clientId: c.id, login: c.hint, name: c.name || 'Клиент ' + c.hint, role: 'client' };
        const token = openSession(walletPassword, user);
        if (keys) sessions.get(token).keys = keys;
        if (account) sessions.get(token).active = account.address;
        return { token, user, shift: staff.shiftInfo(), keys: keys ? keys.length : 0 };
    }

    async function checkWalletOpen(walletPassword, ownerMessage) {
        try {
            await backend.login(walletPassword);
        } catch (e) {
            if (e.status === 502) throw e;
            throw new BankError(ownerMessage || 'Пароль кошелька на ноде изменился: обратитесь в банк', 409);
        }
    }

    async function requireNoWallet() {
        const w = await backend.walletInfo();
        if (w.exists) throw new BankError('Кошелёк на ноде уже создан — войдите сид-фразой или паролем', 409);
    }

    // keys — 21 счёт сид-фразы с приватными ключами: только в памяти сессии владельца, вошедшего фразой
    function ownerSession(password, keys = null) {
        const user = staff.owner();
        const token = openSession(password, user);
        if (keys) sessions.get(token).keys = keys;
        return { token, user, shift: staff.shiftInfo(), keys: keys ? keys.length : 0 };
    }

    // неверный пароль кошелька внутри сессии — 403, а не 401: иначе приложение решит, что сессия закончилась
    async function walletCheck(promise) {
        try {
            return await promise;
        } catch (e) {
            throw e.status === 401 ? new BankError('Неверный пароль кошелька', 403) : e;
        }
    }

    function checkWalletPassword(password) {
        if (typeof password !== 'string' || password.length < 8) throw new BankError('Пароль кошелька — не короче 8 символов');
        return password;
    }

    // [метод, путь (строка или RegExp), обработчик(ctx) , { public: true } для методов без сессии]
    const routes = [
        ['GET', '/api/status', () => backend.status(), { public: true }],

        // первый запуск: на ноде ещё нет кошелька — создаём новый банк или восстанавливаем по сид-фразе
        ['GET', '/api/setup', async () => {
            const w = await backend.walletInfo();
            return { walletExists: w.exists, seedLogin: ownerKey.bound(), needCode: !w.exists && !!setupCode };
        }, { public: true }],
        ['POST', '/api/setup/seed', async () => {
            await requireNoWallet();
            const seed = generateSeed();
            return { seed: formatSeed(seed), keys: deriveAccounts(seed) };
        }, { public: true }],
        ['POST', '/api/setup/create', async ({ req, ip }) => {
            checkThrottle(ip);
            const { seed, password, code } = await readJson(req);
            await requireNoWallet();
            if (setupCode && String(code || '').trim().toLowerCase() !== setupCode) {
                loginFailed(ip);
                throw new BankError('Неверный код первого запуска — он напечатан в консоли сервера банка при старте', 403);
            }
            seedBytes(seed); // проверка формата до обращения к ноде
            checkWalletPassword(password);
            const norm = normalizeSeed(seed);
            await backend.createWallet(norm, password);
            const keys = deriveAccounts(norm);
            await ensureAccounts(password, keys);
            ownerKey.bind(norm, password);
            failures.delete(ip);
            return ownerSession(password, keys);
        }, { public: true }],

        // регистрация клиента: новая сид-фраза (или своя) → 21 счёт в кошельке банка → вход
        ['POST', '/api/register/new', ({ ip }) => {
            publicLimit(ip);
            const seed = generateSeed();
            return { seed, keys: deriveAccounts(seed) };
        }, { public: true }],
        ['POST', '/api/register', async ({ req, ip }) => {
            checkThrottle(ip);
            publicLimit(ip);
            const body = await readJson(req);
            const prep = clients.prepare(body);
            if (ownerKey.isOwnerSeed(prep.seed)) throw new BankError('Это сид-фраза владельца банка — войдите по ней', 409);
            let walletPassword;
            try {
                walletPassword = staff.walletPassword({ password: null });
            } catch (e) {
                throw new BankError('Регистрация доступна, когда банк работает (открыта смена). Попробуйте позже', 423);
            }
            await ensureAccounts(walletPassword, prep.keys);
            const c = clients.add(prep, walletPassword);
            // приветственные COMPU на комиссии сети — с первого счёта банка (если задано)
            const bankMain = ownerKey.addresses()[0];
            if (options.welcomeCompu && bankMain) {
                await backend.transfer({ from: bankMain, to: prep.keys[0].address, asset: 2, amount: String(options.welcomeCompu), title: 'Добро пожаловать в банк' }, walletPassword)
                    .catch((e) => console.warn('приветственные COMPU:', e.message));
            }
            return clientSession(c, walletPassword, prep.keys);
        }, { public: true }],

        // ---------- кошелёк на устройстве: ключи только на телефоне, сервер проверяет подпись и отправляет ----------
        ['POST', '/api/wallet/challenge', ({ ip }) => {
            publicLimit(ip);
            const nonce = crypto.randomBytes(24).toString('hex');
            walletNonces.set(nonce, Date.now() + 120000);
            for (const [k, exp] of walletNonces) if (exp < Date.now()) walletNonces.delete(k);
            return { nonce, message: 'Erachain Bank login ' + nonce, serverTime: Date.now(), port: networkPort };
        }, { public: true }],
        ['POST', '/api/wallet/login', async ({ req, ip }) => {
            checkThrottle(ip);
            const { publicKeys, nonce, signature } = await readJson(req);
            const exp = walletNonces.get(String(nonce));
            walletNonces.delete(String(nonce));
            if (!exp || exp < Date.now()) throw new BankError('Код входа устарел — попробуйте ещё раз', 401);
            if (!Array.isArray(publicKeys) || !publicKeys.length || publicKeys.length > 21) throw new BankError('Нужны публичные ключи счетов (1–21)');
            let keys;
            try {
                keys = publicKeys.map((k) => {
                    const b = base58Decode(String(k));
                    if (!b || b.length !== 32) throw new Error();
                    return b;
                });
            } catch (e) {
                throw new BankError('Неверный публичный ключ');
            }
            // подпись первым ключом доказывает владение кошельком; ключ на сервер не передаётся
            const sig = base58Decode(String(signature || ''));
            if (!sig || sig.length !== 64 || !verifySig(keys[0], Buffer.from('Erachain Bank login ' + nonce, 'utf8'), sig)) {
                loginFailed(ip);
                throw new BankError('Подпись не прошла проверку', 401);
            }
            failures.delete(ip);
            const addresses = [...new Set(keys.map((k) => addressOf(k)))];
            // публичные ключи кошельков известны банку с первого входа — им можно писать зашифрованно,
            // даже если в сети у счёта ещё нет операций
            store.data.walletKeys = store.data.walletKeys || {};
            keys.forEach((k) => { store.data.walletKeys[addressOf(k)] = base58Encode(k); });
            if (backend.demoWallet) backend.demoWallet(addresses, keys);
            const w = (store.data.walletUsers = store.data.walletUsers || []);
            const known = w.find((x) => x.address === addresses[0]);
            if (known) known.lastAt = Date.now();
            else w.push({ address: addresses[0], accounts: addresses.length, firstAt: Date.now(), lastAt: Date.now() });
            store.save();
            const user = { id: 'wallet:' + addresses[0], login: addresses[0].slice(0, 8), name: 'Кошелёк ' + addresses[0].slice(0, 6) + '…', role: 'wallet', addresses };
            const token = openSession(null, user);
            return { token, user, shift: staff.shiftInfo(), port: networkPort };
        }, { public: true }],
        ['GET', '/api/wallet/params', () => ({ serverTime: Date.now(), port: networkPort })],
        ['POST', '/api/wallet/broadcast', async ({ req, session }) => {
            const { raw } = await readJson(req);
            const tx = parseRaw(String(raw || ''));
            if (session.scope && !session.scope.includes(tx.creator)) throw new BankError('Транзакция подписана не вашим счётом', 403);
            await backend.broadcast(String(raw).trim());
            return { signature: tx.signatureB58, creator: tx.creator, recipient: tx.recipient || null, amount: tx.amount ?? null, asset: tx.asset ?? null };
        }],
        ['GET', /^\/api\/pubkey\/([1-9A-HJ-NP-Za-km-z]{30,40})$/, async ({ m }) => ({
            address: m[1], publicKey: (await backend.publicKey(m[1])) || (store.data.walletKeys || {})[m[1]] || null,
        })],
        ['GET', /^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{60,100})\/data$/, async ({ m, session }) => {
            const d = await backend.txData(m[1]);
            if (session.scope && !session.scope.includes(d.from) && !session.scope.includes(d.to)) throw new BankError('Это не ваша транзакция', 403);
            return d;
        }],
        // расшифровка нодой — для счетов в кошельке ноды (банк, клиенты банка)
        ['POST', /^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{60,100})\/decrypt$/, async ({ m, session }) => {
            const d = await backend.txData(m[1]);
            if (session.scope && !session.scope.includes(d.from) && !session.scope.includes(d.to)) throw new BankError('Это не ваша транзакция', 403);
            return { message: await backend.decrypt(m[1], session.password) };
        }],

        ['POST', '/api/login', async ({ req, ip }) => {
            checkThrottle(ip);
            const { login, password, seed, key } = await readJson(req);
            if (key !== undefined) {
                // кабинет одного счёта по его приватному ключу
                let r;
                try {
                    r = clients.unlockAccount(key) || (ownerKey.bound() ? ownerKey.unlockAccount(key) : null);
                } catch (e) {
                    if (e.status !== 409) loginFailed(ip);
                    throw e;
                }
                if (!r) {
                    loginFailed(ip);
                    throw new BankError('Ключ не подходит ни к одному счёту этого банка', 401);
                }
                await checkWalletOpen(r.walletPassword);
                failures.delete(ip);
                if (r.client) return clientSession(r.client, r.walletPassword, null, r.account);
                const user = { id: 'key:' + r.account.address, login: 'счёт №' + r.account.n, name: `Счёт №${r.account.n}`, role: 'account', address: r.account.address };
                const token = openSession(r.walletPassword, user);
                sessions.get(token).active = r.account.address;
                return { token, user, shift: staff.shiftInfo() };
            }
            if (seed !== undefined) {
                // по сид-фразе входят владелец и клиенты: из неё расшифровывается пароль кошелька
                seedBytes(seed);
                if (!ownerKey.isOwnerSeed(seed)) {
                    const c = clients.unlock(seed);
                    if (c) {
                        await checkWalletOpen(c.walletPassword);
                        failures.delete(ip);
                        return clientSession(c.client, c.walletPassword, deriveAccounts(seed));
                    }
                    if (ownerKey.bound()) {
                        loginFailed(ip);
                        throw new BankError('Сид-фраза не найдена в банке: проверьте её или зарегистрируйтесь', 401);
                    }
                }
                let walletPassword;
                try {
                    walletPassword = ownerKey.unlock(seed);
                } catch (e) {
                    if (e.status !== 409) loginFailed(ip);
                    throw e;
                }
                if (!walletPassword) {
                    loginFailed(ip);
                    throw new BankError('Сид-фраза не подходит к кошельку этого банка', 401);
                }
                try {
                    await backend.login(walletPassword);
                } catch (e) {
                    if (e.status === 502) throw e;
                    throw new BankError('Пароль кошелька на ноде изменился: войдите паролем кошелька и привяжите сид-фразу заново', 409);
                }
                failures.delete(ip);
                const keys = deriveAccounts(seed);
                await ensureAccounts(walletPassword, keys).catch((e) => console.warn('счета сид-фразы:', e.message));
                return ownerSession(walletPassword, keys);
            }
            if (typeof password !== 'string' || !password) throw new BankError('Введите пароль');
            if (login && String(login).trim()) {
                // вход сотрудника: свой логин и пароль, пароль кошелька не нужен
                let user;
                try {
                    user = staff.authenticate(login, password);
                } catch (e) {
                    loginFailed(ip);
                    throw e;
                }
                failures.delete(ip);
                return { token: openSession(null, user), user, shift: staff.shiftInfo() };
            }
            try {
                await backend.login(password);
            } catch (e) {
                loginFailed(ip);
                throw e.status === 502 ? e : new BankError('Неверный пароль кошелька', 401);
            }
            failures.delete(ip);
            return ownerSession(password);
        }, { public: true }],
        ['POST', '/api/bank/webhook', async ({ req }) => {
            const raw = await readRaw(req);
            return gateway.webhook(raw, req.headers['x-signature'], options.webhookSecret);
        }, { public: true }],

        ['POST', '/api/logout', ({ session }) => {
            sessions.delete(session.token);
            return { ok: true };
        }],
        ['GET', '/api/network', () => backend.network()],
        ['GET', '/api/me', ({ session }) => ({
            user: session.user, role: ROLES[session.user.role].name, perms: ROLES[session.user.role].perms, shift: staff.shiftInfo(),
            active: session.raw.active || null, keys: session.raw.keys ? session.raw.keys.length : 0,
        })],
        // 21 счёт сид-фразы с приватными ключами (только после входа фразой)
        ['GET', '/api/keys', ({ session }) => {
            if (!session.raw.keys) throw new BankError('Ключи показываются после входа по сид-фразе', 409);
            return session.raw.keys;
        }],
        // кабинет: выбранный счёт; null — все счета банка
        ['POST', '/api/session/account', async ({ req, session }) => {
            const { address } = await readJson(req);
            if (address === null || address === undefined || address === '') {
                session.raw.active = null;
                return { active: null };
            }
            const own = session.scope || (await backend.walletAddresses(session.password)).filter((a) => !clients.owns(a));
            if (!own.includes(address)) throw new BankError('Такого счёта нет среди ваших счетов', 404);
            session.raw.active = address;
            return { active: address };
        }],

        // клиенты банка (для сотрудников с правом «сотрудники»)
        ['GET', '/api/clients', () => clients.list()],
        ['PATCH', /^\/api\/clients\/([\w-]+)$/, async ({ req, m }) => clients.setDisabled(m[1], (await readJson(req)).disabled)],

        // сотрудники, смена, журнал
        ['GET', '/api/staff', () => ({ staff: staff.list(), roles: Staff.roles() })],
        ['POST', '/api/staff', async ({ req }) => staff.create(await readJson(req))],
        ['PATCH', /^\/api\/staff\/([\w-]+)$/, async ({ req, m }) => staff.update(m[1], await readJson(req))],
        ['DELETE', /^\/api\/staff\/([\w-]+)$/, ({ m }) => staff.remove(m[1])],
        ['POST', '/api/shift/open', async ({ req, session }) => {
            const body = await readJson(req);
            // владелец открывает смену своим паролем; администратор — вводит пароль кошелька
            const password = session.raw.password || body.password;
            if (typeof password !== 'string' || !password) throw new BankError('Введите пароль кошелька ноды');
            try {
                await backend.login(password);
            } catch (e) {
                throw e.status === 502 ? e : new BankError('Неверный пароль кошелька', 403);
            }
            return staff.openShift(password, session.user);
        }],
        ['POST', '/api/shift/close', () => staff.closeShift()],
        ['GET', '/api/audit', ({ url }) => staff.auditLog(Number(url.searchParams.get('limit')) || 200)],

        // сид-фраза (только владелец); каждое действие требует повторного ввода пароля кошелька
        ['GET', '/api/security', () => ({ seed: ownerKey.info() })],
        ['POST', '/api/security/seed/show', async ({ req }) => {
            const { password } = await readJson(req);
            return { seed: formatSeed(await walletCheck(backend.exportSeed(checkWalletPassword(password)))) };
        }],
        ['POST', '/api/security/seed/bind', async ({ req, session }) => {
            const { password, seed } = await readJson(req);
            const actual = await walletCheck(backend.exportSeed(checkWalletPassword(password)));
            seedBytes(seed);
            if (!sameSeed(actual, seed)) throw new BankError('Фраза не совпадает с кошельком ноды — проверьте запись');
            const keys = deriveAccounts(actual);
            await ensureAccounts(password, keys);
            session.raw.keys = keys;
            return ownerKey.bind(normalizeSeed(actual), password);
        }],
        ['POST', '/api/security/seed/unbind', async ({ req }) => {
            const { password } = await readJson(req);
            await backend.login(checkWalletPassword(password)).catch((e) => {
                throw e.status === 502 ? e : new BankError('Неверный пароль кошелька', 403);
            });
            return ownerKey.unbind();
        }],

        // счета и переводы
        ['GET', '/api/accounts', ({ session }) => accountsFor(session)],
        ['POST', '/api/accounts', ({ session }) => backend.openAccount(session.password)],
        ['GET', /^\/api\/accounts\/([^/]+)\/history$/, ({ m, url, session }) => {
            const address = decodeURIComponent(m[1]);
            if (!v.isAddress(address)) throw new BankError('Неверный адрес');
            const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 50, 1), 200);
            return backend.history(address, limit, session.password);
        }],
        ['POST', '/api/transfer', async ({ req, session }) => backend.transfer(v.validateTransfer(await readJson(req)), session.password)],
        ['POST', '/api/transfer/batch', async ({ req, session }) => backend.multiTransfer(v.validateMultiTransfer(await readJson(req)), session.password)],

        // активы
        ['GET', '/api/assets/types', () => backend.assetTypes()],
        ['GET', '/api/assets', ({ url }) => backend.assets(Number(url.searchParams.get('from')) || 0)],
        ['GET', /^\/api\/assets\/(\d+)$/, ({ m }) => backend.asset(Number(m[1]))],
        ['POST', '/api/assets', async ({ req, session }) => backend.issueAsset(v.validateAssetIssue(await readJson(req)), session.password)],

        // голосования
        ['GET', '/api/polls', ({ url }) => backend.polls(Number(url.searchParams.get('from')) || 0)],
        ['GET', /^\/api\/polls\/(\d+)$/, ({ m, url }) => backend.poll(Number(m[1]), Number(url.searchParams.get('asset')) || 1)],
        ['POST', '/api/polls', async ({ req, session }) => backend.createPoll(v.validatePoll(await readJson(req)), session.password)],
        ['POST', /^\/api\/polls\/(\d+)\/vote$/, async ({ req, m, session }) => backend.vote(v.validateVote(await readJson(req), m[1]), session.password)],

        // биржа
        ['GET', /^\/api\/exchange\/(\d+)\/(\d+)$/, async ({ m }) => {
            const [book, trades] = await Promise.all([backend.orderBook(+m[1], +m[2]), backend.trades(+m[1], +m[2])]);
            return { ...book, trades };
        }],
        ['GET', /^\/api\/exchange\/orders\/([^/]+)$/, ({ m }) => {
            const address = decodeURIComponent(m[1]);
            if (!v.isAddress(address)) throw new BankError('Неверный адрес');
            return backend.myOrders(address);
        }],
        ['POST', '/api/exchange/orders', async ({ req, session }) => backend.createOrder(v.validateOrder(await readJson(req)), session.password)],
        ['POST', '/api/exchange/cancel', async ({ req, session }) => backend.cancelOrder(v.validateCancel(await readJson(req)), session.password)],

        // сообщения
        ['GET', /^\/api\/messages\/([^/]+)$/, ({ m }) => {
            const address = decodeURIComponent(m[1]);
            if (!v.isAddress(address)) throw new BankError('Неверный адрес');
            return backend.messages(address);
        }],
        ['POST', '/api/messages', async ({ req, session }) => backend.sendMessage(v.validateMessage(await readJson(req)), session.password)],

        // документы
        ['POST', '/api/documents', async ({ req, session }) => backend.signDocument(v.validateDocument(await readJson(req)), session.password)],
        ['GET', /^\/api\/documents\/verify\/([1-9A-HJ-NP-Za-km-z]{40,46})$/, ({ m }) => backend.verifyDocument(m[1])],
        ['POST', '/api/documents/vouch', async ({ req, session }) => {
            const body = await readJson(req);
            if (!v.isAddress(body.creator)) throw new BankError('Выберите счёт, которым заверить');
            if (!/^\d+-\d+$/.test(String(body.seqNo || '').trim())) throw new BankError('Номер транзакции: например 123456-1');
            return backend.vouch(body.creator, String(body.seqNo).trim(), session.password);
        }],

        // персоны и справочники
        ['GET', '/api/persons', ({ url }) => backend.persons(Number(url.searchParams.get('from')) || 0)],
        ['GET', /^\/api\/persons\/(\d+)$/, ({ m }) => backend.person(Number(m[1]))],
        ['POST', '/api/persons', async ({ req, session }) => backend.issuePerson(v.validatePersonIssue(await readJson(req)), session.password)],
        ['POST', '/api/persons/certify', async ({ req, session }) => backend.certifyPerson(v.validateCertify(await readJson(req)), session.password)],
        ['GET', /^\/api\/catalog\/(statuses|templates)$/, ({ m, url }) => backend.catalog(m[1], Number(url.searchParams.get('from')) || 0)],

        // обменник 7Pay
        ['GET', '/api/swap/currencies', () => requireSwap().currencies()],
        ['POST', '/api/swap/quote', async ({ req }) => requireSwap().quote(await readJson(req))],
        ['GET', '/api/swap/orders', () => requireSwap().orders()],
        ['POST', '/api/swap/orders', async ({ req }) => requireSwap().createOrder(await readJson(req))],
        ['POST', /^\/api\/swap\/orders\/([\w-]+)\/pay$/, async ({ req, m, session }) => requireSwap().pay(m[1], await readJson(req), session.password)],
        ['GET', /^\/api\/swap\/orders\/([\w-]+)\/history$/, ({ m }) => requireSwap().history(m[1])],
        ['GET', '/api/swap/rates', () => requireSwap().rates()],
        ['GET', '/api/swap/track', ({ url }) => requireSwap().track(url.searchParams.get('curr'), url.searchParams.get('address'))],

        // кредиты
        ['GET', '/api/loans', () => loans.list()],
        ['POST', '/api/loans/preview', async ({ req }) => Loans.preview(await readJson(req))],
        ['POST', '/api/loans', async ({ req }) => loans.create(await readJson(req))],
        ['GET', /^\/api\/loans\/([\w-]+)$/, ({ m }) => loans.view(loans.get(m[1]))],
        ['POST', /^\/api\/loans\/([\w-]+)\/sign$/, ({ m, session }) => loans.sign(m[1], session.password)],
        ['POST', /^\/api\/loans\/([\w-]+)\/vouch$/, ({ m, session }) => loans.vouch(m[1], session.password)],
        ['POST', /^\/api\/loans\/([\w-]+)\/issue$/, ({ m, session }) => loans.issue(m[1], session.password)],
        ['POST', /^\/api\/loans\/([\w-]+)\/repay$/, async ({ req, m, session }) => loans.repay(m[1], await readJson(req), session.password)],
        ['POST', /^\/api\/loans\/([\w-]+)\/scan$/, ({ m, session }) => loans.scan(m[1], session.password)],
        ['POST', /^\/api\/loans\/([\w-]+)\/confiscate$/, async ({ req, m, session }) => loans.confiscate(m[1], await readJson(req), session.password)],
        ['POST', /^\/api\/loans\/([\w-]+)\/cancel$/, ({ m }) => loans.cancel(m[1])],

        // счета на оплату («Безопасный платёж»)
        ['GET', '/api/invoices/settings', () => invoices.settings()],
        ['PUT', '/api/invoices/settings', async ({ req }) => invoices.updateSettings(await readJson(req))],
        ['POST', '/api/invoices/issue', async ({ req, session }) => invoices.issue(await readJson(req), session.password)],
        ['GET', '/api/invoices/issued', () => invoices.issued()],
        ['POST', '/api/invoices/check', ({ session }) => invoices.checkIssued(session.password)],
        ['POST', '/api/invoices/find', async ({ req }) => invoices.find(await readJson(req))],
        ['POST', '/api/invoices/pay', async ({ req, session }) => invoices.pay(await readJson(req), session.password, session.user)],
        ['GET', '/api/invoices/paid', () => invoices.paidList()],

        // СБП: публичная страница оплаты (без входа)
        ['GET', '/api/public/sbp/config', () => requireSbp().publicConfig(), { public: true }],
        ['POST', '/api/public/sbp/orders', async ({ req, ip }) => {
            publicLimit(ip);
            return requireSbp().createOrder(await readJson(req), 'public');
        }, { public: true }],
        ['GET', /^\/api\/public\/sbp\/orders\/([\w-]{36})$/, ({ m }) => requireSbp().view(requireSbp().get(m[1])), { public: true }],
        ['POST', /^\/api\/public\/sbp\/orders\/([\w-]{36})\/emulate$/, ({ m }) => requireSbp().emulatePay(m[1]), { public: true }],

        // СБП: раздел сотрудников
        ['GET', '/api/sbp/orders', () => ({ orders: requireSbp().list(), stats: requireSbp().stats() })],
        ['GET', '/api/sbp/settings', () => requireSbp().settings()],
        ['PUT', '/api/sbp/settings', async ({ req }) => requireSbp().updateSettings(await readJson(req))],
        ['POST', '/api/sbp/orders', async ({ req, session }) => requireSbp().createOrder(await readJson(req), 'office', session.user.login)],
        ['POST', /^\/api\/sbp\/orders\/([\w-]+)\/retry$/, ({ m }) => requireSbp().retry(m[1])],
        ['POST', /^\/api\/sbp\/orders\/([\w-]+)\/emulate$/, ({ m }) => requireSbp().emulatePay(m[1])],
        ['POST', '/api/sbp/check', async () => {
            await requireSbp().tick();
            return { ok: true };
        }],

        // банковская интеграция
        ['GET', '/api/bank/statement', ({ url, session }) => statement(url, session)],
        ['GET', '/api/bank/settings', () => gateway.settings()],
        ['PUT', '/api/bank/settings', async ({ req }) => gateway.updateSettings(await readJson(req))],
        ['GET', '/api/bank/deposits', () => gateway.deposits()],
        ['POST', '/api/bank/import', async ({ req }) => {
            const body = await readJson(req);
            if (typeof body.content !== 'string') throw new BankError('Файл не передан');
            return gateway.importStatement(Buffer.from(body.content, 'base64'));
        }],
        ['PATCH', /^\/api\/bank\/deposits\/([\w-]+)$/, async ({ req, m }) => gateway.updateDeposit(m[1], await readJson(req))],
        ['POST', /^\/api\/bank\/deposits\/([\w-]+)\/credit$/, ({ m, session }) => gateway.creditDeposit(m[1], session.password)],
        ['GET', '/api/bank/withdrawals', () => gateway.withdrawals()],
        ['POST', '/api/bank/withdrawals/scan', () => gateway.scanWithdrawals()],
        ['POST', '/api/bank/withdrawals/export', async ({ req }) => {
            const body = await readJson(req);
            const r = gateway.exportPayments(Array.isArray(body.ids) ? body.ids : null, body.format === 'pain001' ? 'pain001' : '1c');
            return file(r.filename, r.mime, r.content);
        }],
        ['POST', /^\/api\/bank\/withdrawals\/([\w-]+)\/paid$/, ({ m }) => gateway.markPaid(m[1])],
        ['POST', /^\/api\/bank\/withdrawals\/([\w-]+)\/refund$/, ({ m, session }) => gateway.refund(m[1], session.password)],
    ];

    function route(method, pathname) {
        for (const [meth, pattern, handler, opts = {}] of routes) {
            if (meth !== method) continue;
            if (typeof pattern === 'string' ? pattern === pathname : pattern.test(pathname)) {
                return { handler, opts, m: typeof pattern === 'string' ? null : pathname.match(pattern) };
            }
        }
        return null;
    }

    function serveStatic(req, res, url) {
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const file = path.normalize(path.join(PUBLIC_DIR, rel));
        if (!file.startsWith(PUBLIC_DIR + path.sep)) {
            res.writeHead(403).end();
            return;
        }
        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
            }).end(data);
        });
    }

    function corsHeaders(req) {
        const origin = req.headers.origin;
        if (!origin || !corsOrigins.has(origin)) return {};
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-As',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Expose-Headers': 'Content-Disposition',
            Vary: 'Origin',
        };
    }

    return async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith('/api/')) {
            serveStatic(req, res, url);
            return;
        }
        const cors = corsHeaders(req);
        if (req.method === 'OPTIONS') {
            res.writeHead(204, cors).end();
            return;
        }
        let status = 200;
        let body;
        let session = null;
        const ip = req.socket.remoteAddress || '';
        try {
            const r = route(req.method, url.pathname);
            if (!r) throw new BankError('Метод не найден', 404);
            session = r.opts.public ? null : requireSession(req);
            if (session && session.scope) await checkCabinet(req, url, session);
            if (session) for (const perm of permsFor(req.method, url.pathname)) Staff.require(session.user, perm);
            body = await r.handler({ req, url, m: r.m, session, ip });
        } catch (e) {
            status = e instanceof BankError ? e.status : 500;
            body = { error: e instanceof BankError ? e.message : 'Внутренняя ошибка сервера' };
            if (!(e instanceof BankError)) console.error(e);
        }
        // журнал: все действия, кроме просмотра (GET) и запросов без входа, кроме попыток входа
        if (req.method !== 'GET' && (session || ['/api/login', '/api/setup/create', '/api/register'].includes(url.pathname))) {
            const user = session ? session.user : (status === 200 && body && body.user)
                || { login: (req.bankBody && req.bankBody.login) || (req.bankBody && req.bankBody.seed !== undefined ? 'сид-фраза'
                    : req.bankBody && req.bankBody.key !== undefined ? 'ключ счёта' : 'owner?'), role: '—' };
            try {
                staff.audit({ user, ip, action: `${req.method} ${url.pathname}`, body: req.bankBody, ok: status < 400, error: status < 400 ? null : body.error });
            } catch (e) {
                console.error('audit:', e.message);
            }
        }
        if (body && body.file && req.headers['x-file-as'] === 'json') {
            // для мобильного приложения: файл в base64 внутри JSON (нативный HTTP не искажает двоичные данные)
            body = { filename: body.filename, mime: body.mime, base64: body.content.toString('base64') };
        }
        if (body && body.file) {
            res.writeHead(200, {
                ...cors,
                'Content-Type': body.mime,
                'Content-Disposition': `attachment; filename="${body.filename}"`,
                'Cache-Control': 'no-store',
            });
            res.end(body.content);
            return;
        }
        res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
}

function demoGatewaySettings(backend) {
    return {
        tokenAsset: 1048,
        gatewayAccount: backend.gatewayAccount,
        currency: 'RUB',
        organization: {
            name: 'ООО «Демо Шлюз»', inn: '7701234567', kpp: '770101001', account: '40702810900000012345',
            bank: 'ПАО Демобанк', bic: '044525999', corr: '30101810400000000999', account1C: '',
        },
    };
}

// демо-сид фиксированный, чтобы вход по сид-фразе можно было опробовать по README
const DEMO_SEED = 'Ez6JELocs3iRRn5NvPo1CBh7zdtYNRUnmjokNHk66wLy';

const DEMO_STAFF = {
    walletPassword: 'demo12345',
    users: [
        { login: 'kassir', name: 'Кассир Анна', role: 'operator', password: 'kassir123' },
        { login: 'buh', name: 'Бухгалтер Олег', role: 'accountant', password: 'buh12345' },
    ],
};

function createServer(backend, options = {}) {
    const handler = createApp(backend, options);
    if (options.tls) return https.createServer(options.tls, handler);
    return http.createServer(handler);
}

if (require.main === module) {
    const demo = process.argv.includes('--demo') || process.env.BANK_DEMO === '1';
    const port = Number(process.env.PORT || 8080);
    const host = process.env.HOST || '127.0.0.1';
    const rpc = process.env.ERA_RPC || 'http://127.0.0.1:9048';
    const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
    const backend = demo ? new DemoBackend({ seed: DEMO_SEED, fresh: process.argv.includes('--fresh') }) : new NodeBackend(rpc);
    // порт сети для подписи на устройстве: явно или по RPC-порту ноды (9048 → 9046, 9068 → 9066)
    const rpcPort = Number(new URL(rpc).port) || 9048;
    const networkPort = Number(process.env.ERA_NETWORK_PORT) || (demo ? 9066 : rpcPort - 2);
    const setupCode = demo ? null : (process.env.BANK_SETUP_CODE || crypto.randomBytes(4).toString('hex')).toLowerCase();
    const tls = process.env.TLS_CERT && process.env.TLS_KEY
        ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
        : null;
    const server = createServer(backend, {
        tls,
        // в демо адреса случайные при каждом запуске, поэтому данные шлюза хранятся только в памяти
        store: demo
            ? new JsonStore(null, {
                settings: demoGatewaySettings(backend), sbpSettings: { payoutAccount: backend.mainAccount },
                invoiceSettings: { channel: backend.invoiceChannel, trustedBanks: [backend.mainAccount] },
            })
            : new JsonStore(path.join(dataDir, 'gateway.json'), {}),
        webhookSecret: process.env.BANK_WEBHOOK_SECRET || '',
        setupCode,
        welcomeCompu: demo ? '0.01' : process.env.BANK_WELCOME_COMPU || null,
        networkPort,
        demoStaff: demo ? DEMO_STAFF : null,
        sbpClient: demo ? new SbpEmulator()
            : process.env.TOCHKA_SBP_TOKEN ? new TochkaSbpClient({
                token: process.env.TOCHKA_SBP_TOKEN, merchantId: process.env.TOCHKA_MERCHANT, account: process.env.TOCHKA_ACCOUNT,
                bik: process.env.TOCHKA_BIK, mode: process.env.TOCHKA_MODE === 'prod' ? 'prod' : 'test',
            }) : null,
        sevenpay: demo ? new SevenPayDemo()
            : process.env.SEVENPAY_URL === 'off' ? null : new SevenPayClient(process.env.SEVENPAY_URL || 'https://7pay.in'),
        corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    server.listen(port, host, () => {
        console.log(`Банк Erachain: ${tls ? 'https' : 'http'}://${host}:${port}`);
        console.log(demo ? `Демо-режим: сид-фраза ${DEMO_SEED}; пароль кошелька demo12345; сотрудники kassir/kassir123, buh/buh12345` : 'RPC ноды: ' + rpc);
        if (!demo) {
            backend.walletInfo().then((w) => {
                if (!w.exists) console.log(`На ноде нет кошелька. Откройте приложение и создайте банк. Код первого запуска: ${setupCode}`);
            }).catch((e) => console.warn('Нода недоступна:', e.message));
        }
        if (host !== '127.0.0.1' && host !== 'localhost' && !tls) {
            console.warn('Внимание: сервер доступен из сети без HTTPS — задайте TLS_CERT и TLS_KEY или поставьте его за HTTPS-прокси.');
        }
    });
}

module.exports = { createApp, createServer, demoGatewaySettings, DEMO_STAFF, DEMO_SEED };
