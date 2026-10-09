'use strict';

const crypto = require('crypto');
const { BankError, isAddress, isAmount, amountOf, text } = require('./validate');

/**
 * Обменник 7Pay (https://github.com/icreator/7pay_in): обмен BTC, LTC, DOGE, DASH, ETH и др.
 * на активы Erachain (ERA, COMPU, токены) и обратно. Используется публичное API apipay:
 *   GET apipay/get_currs.json                                            — валюты, лимиты, токены
 *   GET apipay/get_rate.json/{in}/{out}/{vol_in}?get_limits=1            — курс от суммы «отдаю»
 *   GET apipay/get_rate_out.json/{in}/{out}/{vol_out}?get_limits=1       — курс от суммы «получаю»
 *   GET apipay/get_uri_in.json/2/{in}/{out}/{addr_out}/{vol_in}          — заявка: адрес для оплаты
 *   GET apipay/get_uri.json/2/{in}/{out}/{addr_out}/{vol_out}
 *   GET apipay/history.json/{curr_out}/{addr_out}                        — платежи по заявке
 * Сделка 2 — «to COIN» (обмен на криптовалюту/токен).
 */

const DEAL_TO_COIN = 2;
// адрес внешней криптовалюты: как в 7Pay — 25..44 символа, буквы и цифры (bech32 до 62)
const COIN_ADDRESS_RE = /^[0-9A-Za-z]{25,62}$/;

function isErachainToken(c) {
    return !!(c && c.token_key && /era/i.test(c.system || ''));
}

class SevenPayClient {
    constructor(baseUrl, { timeoutMs = 20000 } = {}) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
        this.currsCache = null;
    }

    async call(path, query = {}) {
        const url = new URL(this.baseUrl + '/apipay/' + path);
        for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
        let res;
        try {
            res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (e) {
            throw new BankError('Обменник 7Pay недоступен: ' + this.baseUrl, 502);
        }
        const raw = await res.text();
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            throw new BankError('7Pay: некорректный ответ (HTTP ' + res.status + ')', 502);
        }
        if (data && typeof data === 'object' && data.error) throw new BankError('7Pay: ' + data.error);
        if (!res.ok) throw new BankError('7Pay: HTTP ' + res.status, 502);
        return data;
    }

    async currencies() {
        if (this.currsCache && this.currsCache.expires > Date.now()) return this.currsCache.data;
        const data = await this.call('get_currs.json');
        this.currsCache = { data, expires: Date.now() + 60000 };
        return data;
    }

    rate(from, to, amount, side) {
        return side === 'out'
            ? this.call(`get_rate_out.json/${from}/${to}/${amount}`, { get_limits: 1 })
            : this.call(`get_rate.json/${from}/${to}/${amount}`, { get_limits: 1 });
    }

    order(from, to, address, amount, side) {
        const fn = side === 'out' ? 'get_uri.json' : 'get_uri_in.json';
        return this.call(`${fn}/${DEAL_TO_COIN}/${from}/${to}/${encodeURIComponent(address)}/${amount}`);
    }

    history(currOut, address) {
        return this.call(`history.json/${currOut}/${encodeURIComponent(address)}`);
    }

    // сводные курсы обменника: {btc|usd|rub: [[цена, 'LTC'], ...]} — цена 1 единицы валюты
    async ratesTable() {
        if (this.ratesCache && this.ratesCache.expires > Date.now()) return this.ratesCache.data;
        let res;
        try {
            res = await fetch(this.baseUrl + '/api/rates3.json', { signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (e) {
            throw new BankError('Обменник 7Pay недоступен: ' + this.baseUrl, 502);
        }
        const data = await res.json().catch(() => null);
        if (!data || typeof data !== 'object' || data.error) throw new BankError('7Pay: курсы недоступны');
        this.ratesCache = { data, expires: Date.now() + 60000 };
        return data;
    }
}

/**
 * Демо-обменник для режима без сети: курсы фиксированы, заявки исполняются сразу после оплаты.
 */
class SevenPayDemo {
    constructor() {
        // цена в BTC за единицу
        this.prices = { BTC: 1, LTC: 0.00105, DOGE: 0.0000021, DASH: 0.00041, ETH: 0.038, ERA: 0.0000052, COMPU: 0.00031 };
        this.list = {
            BTC: { id: 3, name: 'Bitcoin', name2: 'bitcoin' },
            LTC: { id: 4, name: 'Litecoin', name2: 'litecoin' },
            DOGE: { id: 5, name: 'Dogecoin', name2: 'dogecoin' },
            DASH: { id: 6, name: 'Dash', name2: 'dash' },
            ETH: { id: 11, name: 'Ethereum', name2: 'ethereum' },
            ERA: { id: 9, name: 'ERA', name2: 'erachain', system: 'erachain', token_key: 1 },
            COMPU: { id: 10, name: 'COMPU', name2: 'erachain', system: 'erachain', token_key: 2 },
        };
        this.exchangeAccount = '7' + crypto.randomBytes(24).toString('hex').replace(/[0OIl]/g, 'x').slice(0, 33);
        this.payments = []; // { currOut, address, amount_in, curr_in, done, created }
        this.fee = 0.005; // 0,5 % комиссия обменника
    }

    async currencies() {
        const out = { icon_url: '', in: {}, out: {} };
        for (const [abbrev, c] of Object.entries(this.list)) {
            out.in[abbrev] = { ...c, min: abbrev === 'BTC' ? 0.0001 : 0.01, icon: abbrev + '.png' };
            out.out[abbrev] = { ...c, min: abbrev === 'BTC' ? 0.0001 : 0.01, bal: Number((5 / this.prices[abbrev]).toFixed(8)), icon: abbrev + '.png' };
        }
        return out;
    }

    abbrevOf(idOrAbbrev) {
        const key = String(idOrAbbrev).toUpperCase();
        if (this.list[key]) return key;
        const found = Object.entries(this.list).find(([, c]) => String(c.id) === String(idOrAbbrev));
        if (!found) throw new BankError('7Pay: curr id...');
        return found[0];
    }

    quote(from, to, amount, side) {
        const a = this.abbrevOf(from);
        const b = this.abbrevOf(to);
        const rate = (this.prices[a] / this.prices[b]) * (1 - this.fee);
        const volIn = side === 'out' ? Number(amount) / rate : Number(amount);
        const volOut = side === 'out' ? Number(amount) : Number(amount) * rate;
        return {
            curr_in_abbrev: a, curr_out_abbrev: b,
            volume_in: Number(volIn.toFixed(8)), volume_out: Number(volOut.toFixed(8)),
            rate: Number(rate.toFixed(10)), base_rate: Number((this.prices[a] / this.prices[b]).toFixed(10)),
            bal: Number((5 / this.prices[b]).toFixed(8)),
        };
    }

    async rate(from, to, amount, side) {
        return this.quote(from, to, amount, side);
    }

    async order(from, to, address, amount, side) {
        const q = this.quote(from, to, amount, side);
        const inCurr = this.list[q.curr_in_abbrev];
        const outCurr = this.list[q.curr_out_abbrev];
        let addrIn;
        if (inCurr.token_key) {
            addrIn = this.exchangeAccount;
        } else {
            addrIn = (q.curr_in_abbrev === 'BTC' ? 'bc1q' : q.curr_in_abbrev[0]) + crypto.randomBytes(16).toString('hex');
        }
        const res = {
            ...q, addr_out: address, addr_in: addrIn, curr_in_name: inCurr.name,
            uri: `${inCurr.name2}:${addrIn}?amount=${q.volume_in}`,
        };
        if (inCurr.token_key) res.addr_out_full = (outCurr.token_key ? String(outCurr.token_key) : q.curr_out_abbrev) + ':' + address;
        return res;
    }

    // демо: оплата токеном фиксируется сразу (в реальности 7Pay видит перевод в блоке)
    registerPayment(order, amountIn, txid) {
        this.payments.unshift({
            currOut: order.out, address: order.addr_out, curr_in: order.in, amount_in: Number(amountIn),
            amount_out: order.volume_out, txid, created: new Date().toISOString(),
        });
    }

    async history(currOut, address) {
        const mine = this.payments.filter((p) => p.currOut === currOut && p.address === address);
        if (!mine.length) throw new BankError('7Pay: Deal ACCOUNT not found. Use ABBREV/ACCOUNT');
        const done = mine.map((p) => ({
            curr_in: { abbrev: p.curr_in }, curr_out: { abbrev: p.currOut }, acc: p.address,
            amount_in: p.amount_in, txid: p.txid, created: p.created, stasus: 'ok', status_mess: String(p.amount_out),
            pay_out: {
                amount: p.amount_out, amo_taken: Number((p.amount_out * this.fee).toFixed(8)), amo_gift: 0, amo_partner: 0,
                amo_to_pay: p.amount_out, txid: crypto.randomBytes(32).toString('hex'), status: 'success', vars: { status: 'success' },
            },
        }));
        return { unconfirmed: [], in_process: [], done };
    }

    async ratesTable() {
        const line = (base) => Object.keys(this.prices).filter((k) => k !== 'ETH').map((k) => [Number((this.prices[k] / base).toPrecision(6)), k]);
        // 1 BTC ≈ 61 000 USD ≈ 5 600 000 RUB (демо)
        return { btc: line(1), usd: line(1 / 61000), rub: line(1 / 5600000) };
    }
}

/**
 * Сервис обмена для сервера банка: проверки, заявки, оплата активами Erachain с кошелька ноды.
 */
class SwapService {
    constructor(client, backend, store) {
        this.client = client;
        this.backend = backend;
        this.store = store;
        store.data.swaps = store.data.swaps || [];
    }

    async currencies() {
        const raw = await this.client.currencies();
        const conv = (side) => Object.entries(raw[side] || {}).map(([abbrev, c]) => ({
            abbrev, id: c.id, name: c.name, min: c.min ?? null, bal: c.bal ?? null, mayPay: c.may_pay ?? null,
            erachain: isErachainToken(c), asset: isErachainToken(c) ? Number(c.token_key) : null,
        })).sort((x, y) => x.abbrev.localeCompare(y.abbrev));
        return { in: conv('in'), out: conv('out') };
    }

    async check(body) {
        const from = text(body.from, 10).toUpperCase();
        const to = text(body.to, 10).toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(from) || !/^[A-Z0-9]{2,10}$/.test(to)) throw new BankError('Выберите валюты обмена');
        if (from === to) throw new BankError('Валюты должны различаться');
        const amount = amountOf(body.amount);
        if (!isAmount(amount)) throw new BankError('Неверная сумма');
        const side = body.side === 'out' ? 'out' : 'in';
        const currs = await this.currencies();
        const cin = currs.in.find((c) => c.abbrev === from);
        const cout = currs.out.find((c) => c.abbrev === to);
        if (!cin) throw new BankError(`7Pay не принимает ${from}`);
        if (!cout) throw new BankError(`7Pay не выдаёт ${to}`);
        return { from, to, amount, side, cin, cout };
    }

    async quote(body) {
        const { from, to, amount, side, cin, cout } = await this.check(body);
        const r = await this.client.rate(from, to, amount, side);
        if (r.wrong) throw new BankError('7Pay: курс не найден — ' + r.wrong);
        const q = {
            from, to, side, volumeIn: r.volume_in, volumeOut: r.volume_out, rate: r.rate, baseRate: r.base_rate ?? null,
            available: r.bal ?? null, mayPay: r.may_pay ?? cin.mayPay ?? null, minIn: cin.min, minOut: cout.min,
            payFromWallet: cin.erachain, receiveToWallet: cout.erachain,
        };
        q.problems = limitProblems(q);
        return q;
    }

    async createOrder(body) {
        const { from, to, amount, side, cin, cout } = await this.check(body);
        const address = text(body.address, 80);
        if (cout.erachain ? !isAddress(address) : !COIN_ADDRESS_RE.test(address)) {
            throw new BankError(`Неверный адрес ${to} для получения`);
        }
        const problems = limitProblems(await this.quote(body));
        if (problems.length) throw new BankError(problems[0]);
        const r = await this.client.order(from, to, address, amount, side);
        if (r.wrong) throw new BankError('7Pay: ' + (r.wrong === 'rate not found' ? 'курс не найден, попробуйте позже' : r.wrong));
        const order = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            in: from, out: to,
            volume_in: r.volume_in, volume_out: r.volume_out, rate: r.rate,
            addr_in: r.addr_in, uri: r.uri || null,
            addr_out: address, addr_out_full: r.addr_out_full || null,
            payAsset: cin.erachain ? cin.asset : null, // оплата активом Erachain — с кошелька ноды
            status: 'awaiting_payment',
        };
        this.store.data.swaps.unshift(order);
        this.store.save();
        return order;
    }

    orders() {
        return this.store.data.swaps;
    }

    async pay(id, body, password) {
        const order = this.store.data.swaps.find((o) => o.id === id);
        if (!order) throw new BankError('Заявка не найдена', 404);
        if (!order.payAsset) throw new BankError(`${order.in} оплачивается из внешнего кошелька по адресу заявки`);
        if (order.status !== 'awaiting_payment') throw new BankError('Заявка уже оплачена');
        if (!isAddress(body.from)) throw new BankError('Выберите счёт для оплаты');
        if (!order.addr_out_full) throw new BankError('7Pay не вернул назначение платежа для заявки');
        order.status = 'paying';
        this.store.save();
        try {
            // 7Pay находит получателя по заголовку перевода: «<валюта или номер актива>:<адрес>»
            const tx = await this.backend.transfer({
                from: body.from, to: order.addr_in, asset: order.payAsset, amount: String(order.volume_in),
                title: order.addr_out_full, message: '', encrypt: false,
            }, password);
            Object.assign(order, { status: 'paid', paidFrom: body.from, paySignature: tx.signature, paidAt: Date.now() });
            if (typeof this.client.registerPayment === 'function') this.client.registerPayment(order, order.volume_in, tx.signature);
        } catch (e) {
            order.status = 'awaiting_payment';
            throw e;
        } finally {
            this.store.save();
        }
        return order;
    }

    // платежи по адресу получения: можно отследить и заявку, созданную не в этом приложении
    async track(currOut, address) {
        currOut = text(currOut, 10).toUpperCase();
        address = text(address, 80);
        if (!/^[A-Z0-9]{2,10}$/.test(currOut) || !/^[0-9A-Za-z]{25,62}$/.test(address)) {
            throw new BankError('Укажите валюту получения и адрес, например ERA:7Az8…');
        }
        let h;
        try {
            h = await this.client.history(currOut, address);
        } catch (e) {
            // 7Pay отвечает ошибкой, пока по адресу не было ни одного платежа
            if (/not found/i.test(e.message)) return { payments: [] };
            throw e;
        }
        return { payments: parseHistory(h, currOut) };
    }

    async history(id) {
        const order = this.store.data.swaps.find((o) => o.id === id);
        if (!order) throw new BankError('Заявка не найдена', 404);
        const result = await this.track(order.out, order.addr_out);
        if (result.payments.some((p) => p.stage === 'paid_out') && order.status !== 'done') {
            order.status = 'done';
            this.store.save();
        }
        return result;
    }

    async rates() {
        const t = await this.client.ratesTable();
        const conv = (list) => (Array.isArray(list) ? list : []).map(([rate, abbrev]) => ({ abbrev, rate: Number(rate) }));
        return { BTC: conv(t.btc), USD: conv(t.usd), RUB: conv(t.rub) };
    }
}

// Проверка лимитов обменника (как в Face2Face): минимум, остаток обменника, сколько он готов принять
function limitProblems(q) {
    const p = [];
    if (q.minIn && q.volumeIn < q.minIn) p.push(`Слишком мало: минимум ${q.minIn} ${q.from}`);
    if (q.minOut && q.volumeOut < q.minOut) p.push(`Слишком мало к получению: минимум ${q.minOut} ${q.to}`);
    if (q.available !== null && q.volumeOut > q.available) p.push(`В обменнике сейчас только ${q.available} ${q.to}`);
    if (q.mayPay !== null && q.volumeIn > q.mayPay) p.push(`Обменник примет не больше ${q.mayPay} ${q.from}`);
    return p;
}

// История 7Pay: unconfirmed — массивы [валюта, сумма, txid, …, дата], in_process и done — объекты,
// в done есть pay_out — исходящая выплата (формат как в клиенте Face2Face)
function parseHistory(h, currOut) {
    const out = [];
    for (const row of Array.isArray(h.unconfirmed) ? h.unconfirmed : []) {
        const arr = Array.isArray(row) ? row : [];
        out.push({
            stage: 'unconfirmed', currIn: (arr[0] && arr[0].abbrev) || null, amountIn: arr[1] ?? null, txidIn: arr[2] || null,
            created: arr[6] || null, currOut, amountOut: null, txidOut: null, fee: null, note: 'ждёт подтверждений в сети',
        });
    }
    const status = (row) => (row.stasus === 'ok' || row.stasus === 'added' ? 'получен' : row.stasus || '');
    for (const row of Array.isArray(h.in_process) ? h.in_process : []) {
        out.push({
            stage: 'in_process', currIn: row.curr_in && row.curr_in.abbrev, amountIn: row.amount_in ?? null, txidIn: row.txid || null,
            created: row.created || null, currOut, amountOut: null, txidOut: null, fee: null,
            note: [status(row), row.status_mess].filter(Boolean).join(': ') || 'обрабатывается',
        });
    }
    for (const row of Array.isArray(h.done) ? h.done : []) {
        const po = row.pay_out;
        const paid = po ? (po.vars && po.vars.status === 'success') || po.status === 'success' : false;
        out.push({
            stage: paid || !po ? 'paid_out' : 'paying_out',
            currIn: row.curr_in && row.curr_in.abbrev, amountIn: row.amount_in ?? null, txidIn: row.txid || null,
            created: row.created || null, currOut: (row.curr_out && row.curr_out.abbrev) || currOut,
            amountOut: po ? po.amount : Number.parseFloat(row.status_mess) || null, txidOut: po ? po.txid || null : null,
            fee: po && po.amo_taken ? po.amo_taken : null,
            note: po ? (paid ? 'выплачено' : 'выплата отправляется') : (row.status_mess || 'выплачено'),
        });
    }
    return out;
}

module.exports = { SevenPayClient, SevenPayDemo, SwapService, isErachainToken, parseHistory, limitProblems, DEAL_TO_COIN };
