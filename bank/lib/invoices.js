'use strict';

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { BankError, isAddress, isAmount, amountOf, text } = require('./validate');

/**
 * Счета на оплату («Безопасный платёж») по протоколу gitlab.com/erachain/erachain-rpc.
 *
 * Магазин отправляет счёт телеграммой на счёт-канал: заголовок — ID покупателя (телефон, e-mail
 * или адрес Erachain), сообщение — JSON {date, order, user, curr, sum, expire, title, description,
 * details, callback}. Банк находит счета клиента по ID, клиент оплачивает, банк записывает в блокчейн
 * перевод с уведомлением {"orderSignature", "curr", "sum"} и вызывает callback магазина с подписью
 * своей транзакции. Магазин принимает уведомления только от доверенных счетов банков.
 */

const DEFAULT_SETTINGS = {
    channel: '',              // счёт, на который магазины присылают счета для клиентов этого банка
    currencies: { 643: 1048 }, // ISO-код валюты → актив Erachain (643 — рубль → «цифровой рубль»)
    trustedBanks: [],         // счета банков, чьим уведомлениям об оплате магазин доверяет
    minConfirmations: 1,      // сколько подтверждений сети нужно, чтобы считать оплату состоявшейся
};

// повторы обратного вызова магазину: через 1, 5, 15, 60, 180 минут
const CALLBACK_BACKOFF_MIN = [1, 5, 15, 60, 180];
// транзакция Erachain живёт ~9 минут; не найдена позже — уже не пройдёт
const TX_LIFETIME_MS = 15 * 60000;

const ISO_NAMES = { 643: 'RUB', 840: 'USD', 978: 'EUR', 156: 'CNY' };

// адрес обратного вызова: только https и только публичные адреса (защита от запросов во внутреннюю сеть)
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

async function safeCallback(url, signature) {
    let u;
    try {
        u = new URL(url);
    } catch (e) {
        return { ok: false, error: 'неверный адрес' };
    }
    if (u.protocol !== 'https:') return { ok: false, error: 'адрес обратного вызова должен быть https' };
    try {
        const { address } = await dns.promises.lookup(u.hostname);
        if (isPrivateIp(address)) return { ok: false, error: 'адрес во внутренней сети запрещён' };
    } catch (e) {
        return { ok: false, error: 'домен не найден' };
    }
    // подпись транзакции добавляется к ссылке, как в протоколе: …/callback/ПОДПИСЬ или …?signature=ПОДПИСЬ
    const target = /[?&]signature=$/.test(url) || url.endsWith('=') ? url + signature
        : url.endsWith('/') ? url + signature : url + (u.search ? '&' : '?') + 'signature=' + signature;
    try {
        const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        return { ok: res.status >= 200 && res.status < 300, status: res.status };
    } catch (e) {
        return { ok: false, error: 'магазин не ответил' };
    }
}

function parseInvoice(tg) {
    let m;
    try {
        m = JSON.parse(tg.message);
    } catch (e) {
        return null;
    }
    if (!m || typeof m !== 'object' || m.orderSignature || m.operation) return null; // уведомление или отмена, не счёт
    const date = Number(m.date) || tg.timestamp || Date.now();
    const expire = Number(m.expire) > 0 ? Number(m.expire) : 60;
    return {
        signature: tg.signature, shop: tg.from, channel: tg.to, user: String(m.user ?? tg.title ?? ''),
        order: text(String(m.order ?? ''), 64), curr: Number(m.curr) || 643,
        sum: m.sum !== undefined && m.sum !== null && m.sum !== '' ? Number(m.sum) : null,
        title: text(String(m.title ?? ''), 200), description: text(String(m.description ?? ''), 400),
        details: text(String(m.details ?? m.paymentDetails ?? ''), 400), callback: typeof m.callback === 'string' ? m.callback.slice(0, 300) : '',
        date, expiresAt: date + expire * 60000, timestamp: tg.timestamp,
    };
}

// отмена счёта магазином (протокол «Безопасный платёж»): {"operation": "delete,<подпись счёта>"}
function parseCancel(tg) {
    try {
        const m = JSON.parse(tg.message);
        const op = m && typeof m.operation === 'string' ? m.operation.split(',') : [];
        return op[0] === 'delete' && op[1] ? { invoice: op[1].trim(), shop: tg.from, signature: tg.signature, timestamp: tg.timestamp } : null;
    } catch (e) {
        return null;
    }
}

// все написания ID клиента: телефон с 7, 8, +7 и без кода; e-mail без учёта регистра; адреса как есть
function idVariants(input) {
    const out = new Set();
    // телефоны с пробелами, скобками и дефисами склеиваем до разбиения на слова
    const src = String(input || '').replace(/(?<![A-Za-z0-9])(?:\+7|8|7)?[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g, (m) => ' ' + m.replace(/[^\d+]/g, '') + ' ');
    for (const raw of src.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
        const digits = raw.replace(/[^\d]/g, '');
        if (/^\+?[\d\s()-]{10,18}$/.test(raw) && (digits.length === 10 || (digits.length === 11 && /^[78]/.test(digits)))) {
            const d = digits.slice(-10);
            ['7' + d, '8' + d, '+7' + d, d].forEach((x) => out.add(x));
        } else if (raw.includes('@')) {
            out.add(raw.toLowerCase());
        } else {
            out.add(raw);
        }
    }
    return [...out].slice(0, 30);
}

// единый вид ID: телефон — 7XXXXXXXXXX, e-mail — строчными, адрес — как есть
function canonicalIds(input) {
    const out = [];
    for (const v of idVariants(input)) {
        const d = /^\+?\d{10,11}$/.test(v) ? v.replace(/\D/g, '').slice(-10) : null;
        const c = d ? '7' + d : v;
        if (!out.includes(c)) out.push(c);
    }
    return out;
}

const userTokens = (user) => canonicalIds(user);

class Invoices {
    constructor(backend, store) {
        this.backend = backend;
        this.store = store;
        const d = store.data;
        d.invoiceSettings = { ...structuredClone(DEFAULT_SETTINGS), ...(d.invoiceSettings || {}) };
        d.invoicesIssued = d.invoicesIssued || [];
        d.invoicesPaid = d.invoicesPaid || [];
    }

    settings() {
        return this.store.data.invoiceSettings;
    }

    updateSettings(body) {
        const s = this.store.data.invoiceSettings;
        if (body.channel !== undefined) {
            const c = text(body.channel, 40);
            if (c && !isAddress(c)) throw new BankError('Неверный счёт-канал');
            s.channel = c;
        }
        if (body.currencies && typeof body.currencies === 'object') {
            const map = {};
            for (const [iso, asset] of Object.entries(body.currencies)) {
                if (!/^\d{1,4}$/.test(iso) || !Number.isSafeInteger(Number(asset)) || Number(asset) <= 0) throw new BankError('Валюта: ISO-код → номер актива');
                map[iso] = Number(asset);
            }
            s.currencies = map;
        }
        if (body.minConfirmations !== undefined) {
            const n = Number(body.minConfirmations);
            if (!Number.isInteger(n) || n < 0 || n > 100) throw new BankError('Подтверждений: целое число от 0 до 100');
            s.minConfirmations = n;
        }
        if (Array.isArray(body.trustedBanks)) {
            const list = body.trustedBanks.map((x) => text(x, 40)).filter(Boolean);
            for (const a of list) if (!isAddress(a)) throw new BankError('Неверный счёт банка: ' + a);
            s.trustedBanks = [...new Set(list)];
        }
        this.store.save();
        return s;
    }

    // валюта счёта → актив Erachain: ISO-код по таблице, иначе число считается номером актива (как в примерах протокола)
    assetFor(curr) {
        const map = this.store.data.invoiceSettings.currencies;
        if (map[curr]) return Number(map[curr]);
        if (ISO_NAMES[curr]) throw new BankError(`Для валюты ${ISO_NAMES[curr]} (${curr}) не задан актив Erachain`);
        return Number(curr);
    }

    currName(curr) {
        return ISO_NAMES[curr] || { 1: 'ERA', 2: 'COMPU' }[Number(curr)] || '#' + curr;
    }

    // ---------- магазин: выставить счёт ----------

    async issue(body, password, extra = null) {
        const from = text(body.from, 40);
        const channel = text(body.channel, 40) || this.store.data.invoiceSettings.channel;
        if (!isAddress(from)) throw new BankError('Выберите счёт магазина');
        if (!isAddress(channel)) throw new BankError('Укажите счёт банка, куда отправить счёт (канал)');
        // ID покупателя — в едином виде (несколько через пробел), чтобы банк нашёл счёт при любом написании
        const user = canonicalIds(text(body.user, 300)).join(' ').slice(0, 120);
        if (!user) throw new BankError('Укажите ID покупателя: телефон, e-mail или адрес Erachain');
        const curr = Number(body.curr || 643);
        if (!Number.isSafeInteger(curr) || curr <= 0) throw new BankError('Неверная валюта');
        let sum = null;
        if (body.sum !== undefined && body.sum !== '' && body.sum !== null) {
            const a = amountOf(body.sum);
            if (!isAmount(a)) throw new BankError('Неверная сумма');
            sum = Number(a);
        }
        const expire = Math.min(Math.max(parseInt(body.expire, 10) || 60, 1), 60 * 24 * 30);
        const callback = text(body.callback, 300);
        if (callback && !/^https:\/\//.test(callback)) throw new BankError('Адрес обратного вызова должен начинаться с https://');
        const order = text(body.order, 64) || 'INV-' + Date.now().toString(36).toUpperCase();
        const msg = {
            date: Date.now(), order, user, curr, ...(sum !== null ? { sum } : {}), expire,
            title: text(body.title, 120) || 'Оплата заказа ' + order,
            description: text(body.description, 300) || 'Без НДС',
            ...(body.details ? { details: text(body.details, 300) } : {}),
            ...(callback ? { callback } : {}),
        };
        const res = await this.backend.sendMessage({ from, to: channel, title: user, message: JSON.stringify(msg), encrypt: false }, password);
        const inv = { signature: res.signature, shop: from, channel, ...msg, sum, status: 'issued', paidSum: 0, notices: [], createdAt: Date.now(), ...(extra || {}) };
        this.store.data.invoicesIssued.unshift(inv);
        this.store.save();
        return inv;
    }

    issued() {
        return this.store.data.invoicesIssued;
    }

    /**
     * Магазин проверяет оплаты в истории своего счёта. Засчитывается только фактический перевод:
     * сумма — из перевода (не из текста уведомления), актив — валюта счёта, до истечения срока,
     * от доверенного банка и с нужным числом подтверждений сети.
     */
    async checkIssued(password) {
        const settings = this.store.data.invoiceSettings;
        const trusted = new Set(settings.trustedBanks);
        const minConf = settings.minConfirmations ?? 1;
        const byShop = new Map();
        for (const inv of this.store.data.invoicesIssued) {
            if (!byShop.has(inv.shop)) byShop.set(inv.shop, []);
            byShop.get(inv.shop).push(inv);
        }
        let updated = 0;
        for (const [shop, list] of byShop) {
            const history = await this.backend.history(shop, 500, password);
            for (const tx of history) {
                if (tx.direction !== 'in' || !tx.message) continue;
                let n;
                try {
                    n = JSON.parse(tx.message);
                } catch (e) {
                    continue;
                }
                const inv = n && list.find((i) => i.signature === n.orderSignature);
                if (!inv) continue;
                let asset = null;
                try {
                    asset = this.assetFor(inv.curr);
                } catch (e) { /* валюта без актива — оплата не засчитается */ }
                const notice = {
                    signature: tx.signature, from: tx.from, trusted: trusted.has(tx.from), timestamp: tx.timestamp,
                    amount: Number(tx.amount) || 0, noticeSum: n.sum !== undefined ? Number(n.sum) : null,
                    asset: Number(tx.asset), assetOk: asset !== null && Number(tx.asset) === asset,
                    late: Boolean(tx.timestamp && inv.expiresAt && tx.timestamp > inv.expiresAt),
                    confirmations: Number(tx.confirmations) || 0,
                };
                const i = inv.notices.findIndex((x) => x.signature === tx.signature);
                if (i < 0) {
                    inv.notices.push(notice);
                    updated += 1;
                } else if (inv.notices[i].confirmations !== notice.confirmations) {
                    inv.notices[i] = notice;
                    updated += 1;
                }
            }
            for (const inv of list) this.recompute(inv, minConf);
        }
        this.store.save();
        return { updated, invoices: this.store.data.invoicesIssued };
    }

    recompute(inv, minConf) {
        // счёт магазина нашего банка (acceptAny): засчитывается любой фактический перевод нужного актива —
        // сумма берётся из самого перевода, так что доверие к банку-отправителю не требуется
        const valid = inv.notices.filter((x) => (x.trusted || inv.acceptAny) && x.assetOk !== false && !x.late);
        const confirmed = valid.filter((x) => (x.confirmations ?? 1) >= minConf);
        inv.paidSum = Number(confirmed.reduce((s, x) => s + (x.amount ?? x.sum ?? 0), 0).toFixed(8));
        inv.pendingSum = Number(valid.filter((x) => !confirmed.includes(x)).reduce((s, x) => s + (x.amount || 0), 0).toFixed(8));
        const full = inv.sum === null || inv.sum === undefined ? inv.paidSum > 0 : inv.paidSum >= inv.sum;
        if (inv.cancelledAt && !inv.paidSum && !inv.pendingSum) inv.status = 'cancelled';
        else if (full) inv.status = 'paid';
        else if (inv.pendingSum > 0) inv.status = 'pending';
        else if (inv.paidSum > 0) inv.status = 'partial';
        else if (inv.notices.some((x) => x.trusted && x.assetOk === false)) inv.status = 'wrong_asset';
        else if (inv.notices.some((x) => x.trusted && x.late)) inv.status = 'late';
        else if (inv.notices.length) inv.status = 'untrusted';
        else inv.status = 'issued';
    }

    // ---------- банк: найти и оплатить счета клиента ----------

    /**
     * Счета клиента по всем его ID (несколько через пробел, разные написания телефона, свои адреса).
     * Зашифрованные счета нода расшифровывает паролем банка (если открыта смена). По каждому счёту —
     * сколько оплачено здесь и в других доверенных банках (§3.1 протокола), остаток, отмена магазином.
     */
    async find(body, password = null, ownAddresses = []) {
        const channel = text(body.channel, 40) || this.store.data.invoiceSettings.channel;
        if (!isAddress(channel)) throw new BankError('Укажите счёт-канал банка в настройках счетов');
        const ids = idVariants([text(body.user, 400), body.mine ? ownAddresses.join(' ') : ''].join(' '));
        if (!ids.length) throw new BankError('Укажите ID клиента: телефон, e-mail или адрес (можно несколько через пробел)');
        const want = new Set(canonicalIds(ids.join(' ')));
        const telegrams = new Map();
        for (const id of ids) {
            for (const tg of await this.backend.findTelegrams(channel, id, password)) telegrams.set(tg.signature, tg);
        }
        const cancels = [...telegrams.values()].map(parseCancel).filter(Boolean);
        const list = [...telegrams.values()].map(parseInvoice).filter(Boolean)
            .filter((inv) => userTokens(inv.user).some((u) => want.has(u)));
        const result = [];
        for (const inv of list) {
            const cancelled = cancels.find((c) => c.invoice === inv.signature && c.shop === inv.shop);
            result.push({ ...inv, currName: this.currName(inv.curr), expired: Date.now() > inv.expiresAt, cancelled: cancelled ? cancelled.timestamp || true : null });
        }
        await this.attachPayments(result);
        return result.sort((a, b) => b.date - a.date);
    }

    // оплачено по счёту: нашим банком (записи оплат) и другими доверенными банками (уведомления в истории магазина)
    async attachPayments(list) {
        const trusted = new Set(this.store.data.invoiceSettings.trustedBanks);
        const ours = this.store.data.invoicesPaid;
        const histories = new Map();
        for (const inv of list) {
            const mine = ours.filter((p) => p.invoice === inv.signature && ['sent', 'paid', 'paying'].includes(p.status));
            inv.paid = [...ours].reverse().find((p) => p.invoice === inv.signature) || null; // последняя попытка
            inv.paidHere = Number(mine.reduce((sum, p) => sum + p.amount, 0).toFixed(8));
            inv.pendingHere = mine.some((p) => p.status !== 'paid');
            inv.paidElsewhere = 0;
            inv.elsewhere = [];
            if (trusted.size) {
                if (!histories.has(inv.shop)) {
                    histories.set(inv.shop, await this.backend.history(inv.shop, 300).catch(() => []));
                }
                let asset = null;
                try {
                    asset = this.assetFor(inv.curr);
                } catch (e) { /* без актива — не считаем */ }
                const ourTx = new Set(mine.map((p) => p.txId));
                for (const tx of histories.get(inv.shop)) {
                    if (tx.direction !== 'in' || !tx.message || ourTx.has(tx.signature) || !trusted.has(tx.from)) continue;
                    let n;
                    try {
                        n = JSON.parse(tx.message);
                    } catch (e) {
                        continue;
                    }
                    if (!n || n.orderSignature !== inv.signature || Number(tx.asset) !== asset) continue;
                    inv.paidElsewhere += Number(tx.amount) || 0;
                    inv.elsewhere.push({ bank: tx.from, amount: Number(tx.amount) || 0, signature: tx.signature, timestamp: tx.timestamp });
                }
                inv.paidElsewhere = Number(inv.paidElsewhere.toFixed(8));
            }
            const total = inv.paidHere + inv.paidElsewhere;
            inv.paidTotal = Number(total.toFixed(8));
            inv.remaining = inv.sum === null ? null : Math.max(0, Number((inv.sum - total).toFixed(8)));
            inv.state = inv.cancelled ? 'cancelled'
                : inv.sum !== null && inv.remaining <= 0 ? (inv.paidHere > 0 ? 'paid' : 'paid_elsewhere')
                    : total > 0 && inv.sum !== null ? 'partial'
                        : inv.expired ? 'expired' : 'open';
        }
        return list;
    }

    // проверить счёт и рассчитать сумму к оплате: остаток с учётом оплат здесь и в других банках
    async prepare(body, password = null) {
        const signature = text(body.signature, 120);
        const from = text(body.from, 40);
        if (!isAddress(from)) throw new BankError('Выберите счёт для оплаты');
        const found = await this.find({ channel: body.channel, user: body.user }, password);
        const inv = found.find((i) => i.signature === signature);
        if (!inv) throw new BankError('Счёт не найден', 404);
        if (inv.cancelled) throw new BankError('Магазин отменил этот счёт');
        if (Date.now() > inv.expiresAt) throw new BankError('Срок счёта истёк — попросите магазин выставить новый');
        if (inv.pendingHere) throw new BankError('Оплата по этому счёту уже отправлена и ждёт подтверждения в сети');
        let amount;
        const a = amountOf(body.amount);
        if (inv.sum !== null) {
            if (inv.remaining <= 0) throw new BankError(inv.state === 'paid_elsewhere' ? 'Счёт уже оплачен в другом банке' : 'Счёт уже оплачен');
            // по умолчанию — весь остаток; можно меньше (частичная оплата по протоколу)
            amount = body.amount !== undefined && body.amount !== '' && body.amount !== null ? Number(a) : inv.remaining;
            if (!(amount > 0) || !isAmount(String(amount))) throw new BankError('Неверная сумма');
            if (amount > inv.remaining + 1e-9) throw new BankError(`Больше остатка по счёту: осталось ${inv.remaining}`);
        } else {
            if (!isAmount(a)) throw new BankError('Счёт без суммы — укажите, сколько оплатить');
            amount = Number(a);
        }
        const asset = this.assetFor(inv.curr);
        const notice = { orderSignature: signature, curr: inv.curr, sum: amount };
        return { inv, from, amount, asset, notice, transfer: { from, to: inv.shop, asset, amount: String(amount), title: '', message: JSON.stringify(notice) } };
    }

    record(prep, user, extra) {
        const { inv } = prep;
        const record = {
            id: crypto.randomUUID(), invoice: inv.signature, order: inv.order, shop: inv.shop, from: prep.from, amount: prep.amount,
            curr: inv.curr, asset: prep.asset, status: 'paying', createdAt: Date.now(), by: user ? user.login : null,
            callbackUrl: inv.callback || null, callback: inv.callback ? { state: 'waiting', attempts: 0 } : null, ...extra,
        };
        this.store.data.invoicesPaid.unshift(record);
        this.store.save();
        return record;
    }

    async pay(body, password, user) {
        const prep = await this.prepare(body, password);
        const record = this.record(prep, user);
        try {
            // перевод магазину с уведомлением об оплате в сообщении — одна транзакция в блокчейне
            const tx = await this.backend.transfer({ ...prep.transfer, encrypt: false }, password);
            // «отправлен»: магазин оповещается, когда перевод наберёт нужное число подтверждений (tick)
            Object.assign(record, { status: 'sent', txId: tx.signature, paidAt: Date.now() });
        } catch (e) {
            Object.assign(record, { status: 'failed', error: e.message });
            this.store.save();
            throw e;
        }
        this.store.save();
        await this.tick().catch(() => {}); // при 0 подтверждений в настройках — оповестить сразу
        return record;
    }

    // кошелёк на устройстве подписал перевод сам: сверяем транзакцию с подготовленной оплатой и ведём её дальше
    async paidSigned(body, user) {
        const prep = await this.prepare(body);
        const txId = text(body.txSignature, 120);
        const d = await this.backend.txData(txId).catch(() => null);
        let notice = null;
        try {
            notice = d && JSON.parse(d.message || '');
        } catch (e) { /* не JSON */ }
        if (!d || d.from !== prep.from || d.to !== prep.inv.shop || !notice || notice.orderSignature !== prep.inv.signature) {
            throw new BankError('Транзакция не похожа на оплату этого счёта');
        }
        const record = this.record(prep, user, { status: 'sent', txId, paidAt: Date.now(), signedOnDevice: true });
        await this.tick().catch(() => {});
        return record;
    }

    // магазин отменяет свой счёт: телеграмма {"operation":"delete,<подпись>"} в тот же канал
    async cancel(signature, password) {
        const inv = this.store.data.invoicesIssued.find((i) => i.signature === signature);
        if (!inv) throw new BankError('Счёт не найден среди выставленных', 404);
        if (inv.status === 'paid') throw new BankError('Счёт уже оплачен — отменить нельзя');
        if (inv.status === 'cancelled') return inv;
        await this.backend.sendMessage({
            from: inv.shop, to: inv.channel, title: inv.user, message: JSON.stringify({ operation: 'delete,' + signature }), encrypt: false,
        }, password);
        Object.assign(inv, { status: 'cancelled', cancelledAt: Date.now() });
        this.store.save();
        return inv;
    }

    // уборка канала: удалить с ноды телеграммы оплаченных, отменённых и давно истёкших счетов
    async cleanup(password, { keepDays = 7 } = {}) {
        const channel = this.store.data.invoiceSettings.channel;
        if (!isAddress(channel)) throw new BankError('Счёт-канал не задан');
        const all = await this.backend.findTelegrams(channel, '', password);
        const cancels = all.map(parseCancel).filter(Boolean);
        const paid = new Set(this.store.data.invoicesPaid.filter((p) => p.status === 'paid').map((p) => p.invoice));
        const old = Date.now() - keepDays * 86400000;
        const list = [];
        for (const tg of all) {
            const inv = parseInvoice(tg);
            if (inv && (paid.has(inv.signature) || inv.expiresAt < old || cancels.some((c) => c.invoice === inv.signature && c.shop === inv.shop))) list.push(tg.signature);
            const c = parseCancel(tg);
            if (c && (tg.timestamp || 0) < old) list.push(tg.signature);
        }
        if (!list.length) return { deleted: 0, left: 0 };
        const left = await this.backend.deleteTelegrams(list, password);
        return { deleted: list.length - left.length, left: left.length };
    }

    paidList() {
        return this.store.data.invoicesPaid;
    }

    /**
     * Фоновая проверка оплат банка: подтверждение перевода по подписи → «оплачен» → обратный вызов магазину
     * с повторами. Перевод, не попавший в сеть за время жизни транзакции, помечается «не прошёл» — его можно
     * оплатить заново (двойной оплаты не будет: старая транзакция уже не пройдёт).
     */
    async tick() {
        const minConf = this.store.data.invoiceSettings.minConfirmations ?? 1;
        const now = Date.now();
        let changed = false;
        for (const r of this.store.data.invoicesPaid) {
            if (r.status === 'sent' && r.txId && this.backend.txStatus) {
                let st;
                try {
                    st = await this.backend.txStatus(r.txId);
                } catch (e) {
                    break; // нода недоступна
                }
                if (st.found && st.confirmations >= minConf) {
                    Object.assign(r, { status: 'paid', confirmations: st.confirmations, seqNo: st.seqNo || null, confirmedAt: now });
                    changed = true;
                } else if (!st.found && now - r.paidAt > TX_LIFETIME_MS) {
                    Object.assign(r, { status: 'failed', error: 'Перевод не попал в сеть — оплатите счёт заново' });
                    changed = true;
                }
            } else if (r.status === 'sent' && !this.backend.txStatus) {
                r.status = 'paid';
                changed = true;
            }
            if (r.status === 'paid' && r.callback && r.callback.state === 'waiting' && (!r.callback.nextAt || now >= r.callback.nextAt)) {
                const res = await safeCallback(r.callbackUrl, r.txId);
                r.callback.attempts += 1;
                Object.assign(r.callback, { status: res.status ?? null, error: res.error || null, lastAt: now });
                if (res.ok) {
                    r.callback.state = 'done';
                } else if (r.callback.attempts >= CALLBACK_BACKOFF_MIN.length) {
                    r.callback.state = 'failed';
                } else {
                    r.callback.nextAt = now + CALLBACK_BACKOFF_MIN[r.callback.attempts - 1] * 60000;
                }
                changed = true;
            }
        }
        if (changed) this.store.save();
        return { changed };
    }

}

module.exports = { Invoices, parseInvoice, parseCancel, idVariants, canonicalIds, isPrivateIp, safeCallback };
