'use strict';

const crypto = require('crypto');
const { BankError, isAddress, text } = require('../validate');
const formats = require('./formats');

const ADDRESS_IN_TEXT = /7[1-9A-HJ-NP-Za-km-z]{32,34}/;

const DEFAULT_SETTINGS = {
    tokenAsset: null,        // ключ актива-токена, обеспеченного деньгами на счёте (например, «цифровой рубль»)
    gatewayAccount: '',      // счёт шлюза в кошельке ноды: с него выдаются токены, на него приходят токены на вывод
    currency: 'RUB',
    organization: {
        name: '', inn: '', kpp: '',
        account: '',         // расчётный счёт организации в банке (20 цифр)
        bank: '', bic: '', corr: '',
        account1C: '',       // номер счёта для выписок блокчейна в 1С (если пусто — адрес Erachain)
    },
};

/**
 * Шлюз между банковским счётом организации и токеном в Erachain.
 *
 * Ввод: поступление денег на расчётный счёт (из выписки 1С/camt или вебхука банка) → заявка
 * на зачисление → оператор подтверждает → токены переводятся со счёта шлюза на адрес клиента,
 * указанный в назначении платежа.
 *
 * Вывод: клиент переводит токены на счёт шлюза, в сообщении — банковские реквизиты →
 * сканирование находит такие переводы → выгрузка платёжных поручений (1С или pain.001) →
 * после оплаты банком оператор отмечает заявку оплаченной (или возвращает токены).
 */
class Gateway {
    constructor(backend, store) {
        this.backend = backend;
        this.store = store;
        const d = store.data;
        d.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(d.settings || {}) };
        d.settings.organization = { ...DEFAULT_SETTINGS.organization, ...(d.settings.organization || {}) };
        d.deposits = d.deposits || [];
        d.withdrawals = d.withdrawals || [];
        d.exports = d.exports || 0;
    }

    get data() {
        return this.store.data;
    }

    settings() {
        return this.data.settings;
    }

    updateSettings(body) {
        const s = this.data.settings;
        if (body.tokenAsset !== undefined) {
            const k = Number(body.tokenAsset);
            if (body.tokenAsset !== null && body.tokenAsset !== '' && (!Number.isSafeInteger(k) || k <= 0)) throw new BankError('Неверный ключ актива');
            s.tokenAsset = body.tokenAsset === null || body.tokenAsset === '' ? null : k;
        }
        if (body.gatewayAccount !== undefined) {
            const a = text(body.gatewayAccount, 40);
            if (a && !isAddress(a)) throw new BankError('Неверный адрес счёта шлюза');
            s.gatewayAccount = a;
        }
        if (body.currency !== undefined) {
            const c = text(body.currency, 3).toUpperCase();
            if (!/^[A-Z]{3}$/.test(c)) throw new BankError('Валюта: трёхбуквенный код ISO 4217');
            s.currency = c;
        }
        if (body.organization && typeof body.organization === 'object') {
            const o = body.organization;
            const org = s.organization;
            for (const k of ['name', 'bank']) if (o[k] !== undefined) org[k] = text(o[k], 160);
            const digits = { inn: [10, 12], kpp: [9], account: [20], bic: [9], corr: [20] };
            for (const [k, lens] of Object.entries(digits)) {
                if (o[k] === undefined) continue;
                const v = text(o[k], 20).replace(/\s/g, '');
                if (v && (!/^\d+$/.test(v) || !lens.includes(v.length))) throw new BankError(`Поле «${k}»: ${lens.join(' или ')} цифр`);
                org[k] = v;
            }
            if (o.account1C !== undefined) org.account1C = text(o.account1C, 40);
        }
        // сопоставление счетов для 1С: актив → номер счёта (у каждого актива может быть свой «расчётный счёт»)
        if (body.accounts1C && typeof body.accounts1C === 'object') {
            const map = {};
            for (const [asset, acc] of Object.entries(body.accounts1C)) {
                const a = text(acc, 40).replace(/\s/g, '');
                if (!a) continue;
                if (!/^\d+$/.test(asset)) throw new BankError('Сопоставление счетов: номер актива — целое число');
                map[asset] = a;
            }
            s.accounts1C = map;
        }
        // справочник контрагентов: адрес Erachain → наименование, ИНН, КПП, счёт и банк для выписок
        if (Array.isArray(body.counterparties)) {
            const list = [];
            for (const c of body.counterparties.slice(0, 2000)) {
                const address = text(c.address, 40);
                if (!isAddress(address)) throw new BankError('Контрагент: неверный адрес ' + address);
                const name = text(c.name, 160);
                if (!name) throw new BankError('Контрагент ' + address + ': укажите наименование');
                const item = { address, name, bank: text(c.bank, 160) };
                const digits = { inn: [10, 12], kpp: [9], account: [20], bic: [9], corr: [20] };
                for (const [k, lens] of Object.entries(digits)) {
                    const v = text(c[k], 20).replace(/\s/g, '');
                    if (v && (!/^\d+$/.test(v) || !lens.includes(v.length))) throw new BankError(`Контрагент ${name}: «${k}» — ${lens.join(' или ')} цифр`);
                    item[k] = v;
                }
                list.push(item);
            }
            s.counterparties = list;
        }
        this.store.save();
        return s;
    }

    requireConfigured() {
        const s = this.data.settings;
        if (!s.tokenAsset || !s.gatewayAccount) throw new BankError('Настройте шлюз: актив-токен и счёт шлюза');
        return s;
    }

    // ---------- ввод средств ----------

    addIncoming(list, source) {
        const added = [];
        for (const p of list) {
            if (!(Number(p.amount) > 0)) continue;
            const ref = p.bankRef || crypto.createHash('sha256').update(`${p.date}|${p.amount}|${p.payer}|${p.purpose}`).digest('hex').slice(0, 16);
            if (this.data.deposits.some((d) => d.bankRef === ref)) continue; // уже загружено
            const m = String(p.purpose || '').match(ADDRESS_IN_TEXT);
            const dep = {
                id: crypto.randomUUID(),
                bankRef: ref,
                source,
                date: p.date || Date.now(),
                amount: p.amount,
                currency: p.currency || this.data.settings.currency,
                payer: p.payer || '',
                payerAccount: p.payerAccount || '',
                purpose: p.purpose || '',
                address: m && isAddress(m[0]) ? m[0] : '',
                status: m ? 'new' : 'review', // review — в назначении нет адреса Erachain
                createdAt: Date.now(),
            };
            this.data.deposits.unshift(dep);
            added.push(dep);
        }
        this.store.save();
        return added;
    }

    importStatement(buffer) {
        const list = formats.parseBankStatement(buffer, this.data.settings.organization.account || null);
        const added = this.addIncoming(list, 'statement');
        return { found: list.length, added: added.length, deposits: added };
    }

    webhook(rawBody, signature, secret) {
        if (!secret) throw new BankError('Вебхук отключён: задайте BANK_WEBHOOK_SECRET', 404);
        const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        const given = String(signature || '').replace(/^sha256=/, '');
        if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
            throw new BankError('Неверная подпись вебхука', 401);
        }
        let body;
        try {
            body = JSON.parse(rawBody.toString('utf8'));
        } catch (e) {
            throw new BankError('Некорректный JSON');
        }
        const items = Array.isArray(body) ? body : [body];
        const list = items.map((p) => ({
            bankRef: text(p.id ?? p.bankRef, 100),
            date: p.date ? Date.parse(p.date) : Date.now(),
            amount: Number(p.amount).toFixed(2),
            currency: text(p.currency, 3) || undefined,
            payer: text(p.payer, 160),
            payerAccount: text(p.payerAccount, 34),
            purpose: text(p.purpose, 500),
        }));
        const added = this.addIncoming(list, 'webhook');
        return { received: list.length, added: added.length };
    }

    deposits() {
        return this.data.deposits;
    }

    updateDeposit(id, body) {
        const dep = this.data.deposits.find((d) => d.id === id);
        if (!dep) throw new BankError('Поступление не найдено', 404);
        if (dep.status === 'credited') throw new BankError('Уже зачислено');
        if (body.address !== undefined) {
            const a = text(body.address, 40);
            if (!isAddress(a)) throw new BankError('Неверный адрес Erachain');
            dep.address = a;
            if (dep.status === 'review') dep.status = 'new';
        }
        if (body.status === 'rejected') dep.status = 'rejected';
        this.store.save();
        return dep;
    }

    async creditDeposit(id, password) {
        const s = this.requireConfigured();
        const dep = this.data.deposits.find((d) => d.id === id);
        if (!dep) throw new BankError('Поступление не найдено', 404);
        if (dep.status !== 'new') throw new BankError('Зачислить можно только новое поступление с адресом');
        if (dep.address === s.gatewayAccount) throw new BankError('Адрес клиента совпадает со счётом шлюза');
        dep.status = 'processing'; // защита от двойного зачисления при повторном нажатии
        this.store.save();
        try {
            const tx = await this.backend.transfer({
                from: s.gatewayAccount, to: dep.address, asset: s.tokenAsset, amount: String(Number(dep.amount)),
                title: `Пополнение из банка ${formats.dateRu(dep.date)}`, message: `Платёж: ${dep.payer}. ${dep.purpose}`.slice(0, 400),
            }, password);
            Object.assign(dep, { status: 'credited', signature: tx.signature, creditedAt: Date.now() });
        } catch (e) {
            dep.status = 'new';
            dep.error = e.message;
            throw e;
        } finally {
            this.store.save();
        }
        return dep;
    }

    // ---------- вывод средств ----------

    static parseRequisites(message) {
        const msg = String(message || '').trim();
        let r = null;
        try {
            const j = JSON.parse(msg);
            if (j && typeof j === 'object') r = { name: j.name, inn: j.inn, account: j.account, bic: j.bic, bank: j.bank, corr: j.corr, purpose: j.purpose };
        } catch (e) {
            // формат строкой: ВЫВОД;Получатель;ИНН;Счёт;БИК[;Назначение]
            const parts = msg.split(';').map((x) => x.trim());
            if (/^(ВЫВОД|WITHDRAW)$/i.test(parts[0]) && parts.length >= 5) {
                r = { name: parts[1], inn: parts[2], account: parts[3], bic: parts[4], purpose: parts[5] };
            }
        }
        if (!r) return { ok: false, error: 'В сообщении нет реквизитов (ВЫВОД;Получатель;ИНН;Счёт;БИК)' };
        const clean = (v) => String(v || '').replace(/\s/g, '');
        const out = {
            name: text(r.name, 160), inn: clean(r.inn), account: clean(r.account), bic: clean(r.bic),
            bank: text(r.bank, 160), corr: clean(r.corr), purpose: text(r.purpose, 210),
        };
        if (!out.name) return { ok: false, error: 'Не указан получатель', requisites: out };
        if (out.inn && !/^(\d{10}|\d{12})$/.test(out.inn)) return { ok: false, error: 'ИНН: 10 или 12 цифр', requisites: out };
        if (!/^\d{20}$/.test(out.account)) return { ok: false, error: 'Счёт получателя: 20 цифр', requisites: out };
        if (!/^\d{9}$/.test(out.bic)) return { ok: false, error: 'БИК: 9 цифр', requisites: out };
        return { ok: true, requisites: out };
    }

    async scanWithdrawals() {
        const s = this.requireConfigured();
        const history = await this.backend.history(s.gatewayAccount, 200);
        let added = 0;
        for (const tx of history) {
            if (tx.direction !== 'in' || Number(tx.asset) !== s.tokenAsset || !tx.amount) continue;
            // деньги выплачиваем только по подтверждённым переводам — неподтверждённый может не попасть в блок
            if (!tx.confirmations) continue;
            if (this.data.deposits.some((d) => d.signature === tx.signature)) continue; // наш собственный перевод
            if (this.data.withdrawals.some((w) => w.signature === tx.signature)) continue;
            const parsed = Gateway.parseRequisites(tx.message || tx.title);
            this.data.withdrawals.unshift({
                id: crypto.randomUUID(),
                signature: tx.signature,
                seqNo: tx.seqNo,
                from: tx.from,
                amount: Number(tx.amount).toFixed(2),
                timestamp: tx.timestamp,
                confirmations: tx.confirmations,
                requisites: parsed.requisites || null,
                status: parsed.ok ? 'new' : 'invalid',
                error: parsed.ok ? undefined : parsed.error,
                createdAt: Date.now(),
            });
            added += 1;
        }
        this.store.save();
        return { scanned: history.length, added, pending: history.filter((t) => t.direction === 'in' && !t.confirmations).length };
    }

    withdrawals() {
        return this.data.withdrawals;
    }

    exportPayments(ids, format) {
        const s = this.data.settings;
        const list = this.data.withdrawals.filter((w) => (ids && ids.length ? ids.includes(w.id) : w.status === 'new') && w.status === 'new');
        if (!list.length) throw new BankError('Нет заявок для выгрузки');
        const payments = list.map((w) => ({
            id: (w.seqNo || w.id).replace(/[^\w-]/g, '').slice(0, 35),
            amount: w.amount, ...w.requisites,
            purpose: w.requisites.purpose || `Вывод средств по заявке ${w.seqNo || w.id}. НДС не облагается`,
        }));
        this.data.exports += 1;
        const batch = `ERA-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${this.data.exports}`;
        const org = { ...s.organization, currency: s.currency };
        const content = format === 'pain001'
            ? formats.pain001(payments, org, batch)
            : formats.paymentOrders1C(payments, org, this.data.exports * 1000 + 1);
        for (const w of list) Object.assign(w, { status: 'exported', batch, exportedAt: Date.now() });
        this.store.save();
        return {
            filename: format === 'pain001' ? `${batch}.pain001.xml` : `${batch}.1c.txt`,
            mime: format === 'pain001' ? 'application/xml' : 'text/plain; charset=windows-1251',
            content,
        };
    }

    markPaid(id) {
        const w = this.data.withdrawals.find((x) => x.id === id);
        if (!w) throw new BankError('Заявка не найдена', 404);
        if (!['new', 'exported'].includes(w.status)) throw new BankError('Отметить оплаченной можно только новую или выгруженную заявку');
        Object.assign(w, { status: 'paid', paidAt: Date.now() });
        this.store.save();
        return w;
    }

    async refund(id, password) {
        const s = this.requireConfigured();
        const w = this.data.withdrawals.find((x) => x.id === id);
        if (!w) throw new BankError('Заявка не найдена', 404);
        if (!['new', 'invalid', 'exported'].includes(w.status)) throw new BankError('Эту заявку вернуть нельзя');
        const prev = w.status;
        w.status = 'processing';
        this.store.save();
        try {
            const tx = await this.backend.transfer({
                from: s.gatewayAccount, to: w.from, asset: s.tokenAsset, amount: String(Number(w.amount)),
                title: 'Возврат заявки на вывод', message: w.error ? 'Причина: ' + w.error : '',
            }, password);
            Object.assign(w, { status: 'refunded', refundSignature: tx.signature });
        } catch (e) {
            w.status = prev;
            throw e;
        } finally {
            this.store.save();
        }
        return w;
    }
}

module.exports = { Gateway };
