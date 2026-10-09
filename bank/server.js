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
    // демо: готовые сотрудники и открытая смена, чтобы роли можно было опробовать сразу
    if (options.demoStaff) {
        for (const u of options.demoStaff.users) if (!store.data.staff.some((x) => x.login === u.login)) staff.create(u);
        staff.openShift(options.demoStaff.walletPassword, staff.owner());
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
        if (s.user.role !== 'owner') {
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
            // пароль кошелька для операции: свой у владельца, у сотрудника — открытой смены
            get password() { return staff.walletPassword(s); },
        };
    }

    // права на маршрут: GET — просмотр, остальное — по разделу; список прав — все обязательны
    function permsFor(method, pathname) {
        if (pathname === '/api/logout' || pathname === '/api/me') return [];
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

    // [метод, путь (строка или RegExp), обработчик(ctx) , { public: true } для методов без сессии]
    const routes = [
        ['GET', '/api/status', () => backend.status(), { public: true }],
        ['POST', '/api/login', async ({ req, ip }) => {
            checkThrottle(ip);
            const { login, password } = await readJson(req);
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
            return { token: openSession(password, staff.owner()), user: staff.owner(), shift: staff.shiftInfo() };
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
        })],

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
                throw e.status === 502 ? e : new BankError('Неверный пароль кошелька', 401);
            }
            return staff.openShift(password, session.user);
        }],
        ['POST', '/api/shift/close', () => staff.closeShift()],
        ['GET', '/api/audit', ({ url }) => staff.auditLog(Number(url.searchParams.get('limit')) || 200)],

        // счета и переводы
        ['GET', '/api/accounts', ({ session }) => backend.accounts(session.password)],
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
            if (session) for (const perm of permsFor(req.method, url.pathname)) Staff.require(session.user, perm);
            body = await r.handler({ req, url, m: r.m, session, ip });
        } catch (e) {
            status = e instanceof BankError ? e.status : 500;
            body = { error: e instanceof BankError ? e.message : 'Внутренняя ошибка сервера' };
            if (!(e instanceof BankError)) console.error(e);
        }
        // журнал: все действия, кроме просмотра (GET) и запросов без входа, кроме попыток входа
        if (req.method !== 'GET' && (session || url.pathname === '/api/login')) {
            const user = session ? session.user : (status === 200 && body && body.user) || { login: (req.bankBody && req.bankBody.login) || 'owner?', role: '—' };
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
    const backend = demo ? new DemoBackend() : new NodeBackend(rpc);
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
        console.log(demo ? 'Демо-режим: пароль кошелька demo12345; сотрудники kassir/kassir123, buh/buh12345' : 'RPC ноды: ' + rpc);
        if (host !== '127.0.0.1' && host !== 'localhost' && !tls) {
            console.warn('Внимание: сервер доступен из сети без HTTPS — задайте TLS_CERT и TLS_KEY или поставьте его за HTTPS-прокси.');
        }
    });
}

module.exports = { createApp, createServer, demoGatewaySettings, DEMO_STAFF };
