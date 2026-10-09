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
};

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
    if (!m || typeof m !== 'object' || m.orderSignature) return null; // уведомление об оплате, не счёт
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
        return ISO_NAMES[curr] || '#' + curr;
    }

    // ---------- магазин: выставить счёт ----------

    async issue(body, password) {
        const from = text(body.from, 40);
        const channel = text(body.channel, 40) || this.store.data.invoiceSettings.channel;
        if (!isAddress(from)) throw new BankError('Выберите счёт магазина');
        if (!isAddress(channel)) throw new BankError('Укажите счёт банка, куда отправить счёт (канал)');
        const user = text(body.user, 120);
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
        const inv = { signature: res.signature, shop: from, channel, ...msg, sum, status: 'issued', paidSum: 0, notices: [], createdAt: Date.now() };
        this.store.data.invoicesIssued.unshift(inv);
        this.store.save();
        return inv;
    }

    issued() {
        return this.store.data.invoicesIssued;
    }

    // магазин проверяет уведомления об оплате в истории своего счёта
    async checkIssued(password) {
        const trusted = new Set(this.store.data.invoiceSettings.trustedBanks);
        const byShop = new Map();
        for (const inv of this.store.data.invoicesIssued) {
            if (!byShop.has(inv.shop)) byShop.set(inv.shop, []);
            byShop.get(inv.shop).push(inv);
        }
        let updated = 0;
        for (const [shop, list] of byShop) {
            const history = await this.backend.history(shop, 200, password);
            for (const tx of history) {
                if (tx.direction !== 'in' || !tx.message) continue;
                let n;
                try {
                    n = JSON.parse(tx.message);
                } catch (e) {
                    continue;
                }
                const inv = n && list.find((i) => i.signature === n.orderSignature);
                if (!inv || inv.notices.some((x) => x.signature === tx.signature)) continue;
                const isTrusted = trusted.has(tx.from);
                const sum = Number(n.sum ?? tx.amount ?? 0);
                inv.notices.push({ signature: tx.signature, from: tx.from, sum, trusted: isTrusted, timestamp: tx.timestamp, confirmations: tx.confirmations });
                if (isTrusted) {
                    inv.paidSum = Number((inv.paidSum + sum).toFixed(8));
                    inv.status = inv.sum === null || inv.sum === undefined || inv.paidSum >= inv.sum ? 'paid' : 'partial';
                } else if (inv.status === 'issued') {
                    inv.status = 'untrusted';
                }
                updated += 1;
            }
        }
        this.store.save();
        return { updated, invoices: this.store.data.invoicesIssued };
    }

    // ---------- банк: найти и оплатить счета клиента ----------

    async find(body) {
        const channel = text(body.channel, 40) || this.store.data.invoiceSettings.channel;
        if (!isAddress(channel)) throw new BankError('Укажите счёт-канал банка в настройках счетов');
        const user = text(body.user, 120);
        if (!user) throw new BankError('Укажите ID клиента: телефон, e-mail или адрес');
        const list = (await this.backend.findTelegrams(channel, user)).map(parseInvoice).filter(Boolean);
        const paid = new Map(this.store.data.invoicesPaid.map((p) => [p.invoice, p]));
        return list.map((inv) => ({
            ...inv,
            currName: this.currName(inv.curr),
            expired: Date.now() > inv.expiresAt,
            paid: paid.get(inv.signature) || null,
        })).sort((a, b) => b.date - a.date);
    }

    async pay(body, password, user) {
        const signature = text(body.signature, 120);
        const from = text(body.from, 40);
        if (!isAddress(from)) throw new BankError('Выберите счёт для оплаты');
        if (this.store.data.invoicesPaid.some((p) => p.invoice === signature && p.status !== 'failed')) throw new BankError('Счёт уже оплачен');
        const channel = text(body.channel, 40) || this.store.data.invoiceSettings.channel;
        const found = (await this.backend.findTelegrams(channel, text(body.user, 120))).map(parseInvoice).filter(Boolean);
        const inv = found.find((i) => i.signature === signature);
        if (!inv) throw new BankError('Счёт не найден', 404);
        if (Date.now() > inv.expiresAt) throw new BankError('Срок счёта истёк — попросите магазин выставить новый');
        let amount;
        if (inv.sum !== null) {
            amount = inv.sum;
        } else {
            const a = amountOf(body.amount);
            if (!isAmount(a)) throw new BankError('Счёт без суммы — укажите, сколько оплатить');
            amount = Number(a);
        }
        const asset = this.assetFor(inv.curr);
        const record = {
            id: crypto.randomUUID(), invoice: signature, order: inv.order, shop: inv.shop, from, amount, curr: inv.curr, asset,
            status: 'paying', createdAt: Date.now(), by: user ? user.login : null,
        };
        this.store.data.invoicesPaid.unshift(record);
        this.store.save();
        try {
            // перевод магазину с уведомлением об оплате в сообщении — одна транзакция в блокчейне
            const notice = { orderSignature: signature, curr: inv.curr, sum: amount };
            const tx = await this.backend.transfer({
                from, to: inv.shop, asset, amount: String(amount), title: '', message: JSON.stringify(notice), encrypt: false,
            }, password);
            Object.assign(record, { status: 'paid', txId: tx.signature, paidAt: Date.now() });
        } catch (e) {
            Object.assign(record, { status: 'failed', error: e.message });
            this.store.save();
            throw e;
        }
        if (inv.callback) {
            record.callback = await safeCallback(inv.callback, record.txId);
        }
        this.store.save();
        return record;
    }

    paidList() {
        return this.store.data.invoicesPaid;
    }
}

module.exports = { Invoices, parseInvoice, isPrivateIp, safeCallback };
