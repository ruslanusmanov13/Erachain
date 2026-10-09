'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { parseRaw } = require('./eratx');

/**
 * Журнал платежей: каждый исходящий перевод банка — кто инициировал (сотрудник, клиент, фоновая задача),
 * откуда, куда, сколько, подпись транзакции и её судьба (подписан → отправлен → подтверждён / не прошёл).
 * Журнал ведётся на уровне бэкенда, поэтому в него попадают переводы из всех разделов: переводы и выплаты,
 * СБП, счета на оплату, магазины, кредиты, шлюз, кошелёк на устройстве.
 */

const context = new AsyncLocalStorage(); // { by, source } текущего запроса или фоновой задачи
const MAX = 20000;
const LIFETIME_MS = 15 * 60000;

class PaymentsLog {
    constructor(store) {
        this.store = store;
        store.data.payments = store.data.payments || [];
    }

    run(ctx, fn) {
        return context.run(ctx, fn);
    }

    ctx() {
        return context.getStore() || { by: 'система', source: 'фоновая задача' };
    }

    add(entry) {
        const c = this.ctx();
        const e = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), by: c.by, source: c.source, ...entry };
        this.store.data.payments.unshift(e);
        if (this.store.data.payments.length > MAX) this.store.data.payments.length = MAX;
        this.store.save();
        return e;
    }

    find(signature) {
        return signature ? this.store.data.payments.find((x) => x.signature === signature) : null;
    }

    /** Обёртка бэкенда: переводы записываются в журнал, остальное проходит как есть. */
    wrap(backend) {
        const log = this;
        const brief = (t) => ({ from: t.from, to: t.to, asset: Number(t.asset), amount: String(t.amount), title: t.title || '' });
        const wrapped = {
            async transfer(t, password) {
                try {
                    const tx = await backend.transfer.call(proxy, t, password);
                    log.add({ kind: 'transfer', ...brief(t), signature: tx && tx.signature, status: 'sent' });
                    return tx;
                } catch (e) {
                    if (e.status !== 502) log.add({ kind: 'transfer', ...brief(t), status: 'failed', error: e.message });
                    throw e;
                }
            },
            async debtTransfer(t, password) {
                const tx = await backend.debtTransfer.call(proxy, t, password);
                log.add({ kind: t.backward ? 'debt_collect' : 'debt', ...brief(t), signature: tx && tx.signature, status: 'sent' });
                return tx;
            },
            // двухфазная отправка: подпись сохраняется в журнале до отправки
            async makeTransfer(t, password) {
                const made = await backend.makeTransfer.call(proxy, t, password);
                log.add({ kind: 'two_phase', ...brief(t), signature: made.signature, status: 'made' });
                return made;
            },
            async broadcast(raw) {
                let entry = null;
                {
                    // подпись известна из makeTransfer (у демо raw — это подпись) или из разбора транзакции устройства
                    let sig = null;
                    let parsed = null;
                    try {
                        parsed = parseRaw(raw);
                        sig = parsed.signatureB58;
                    } catch (e) {
                        sig = raw;
                    }
                    entry = log.find(sig);
                    if (!entry && parsed && parsed.amount !== undefined) {
                        entry = log.add({
                            kind: 'device', from: parsed.creator, to: parsed.recipient, asset: parsed.asset, amount: parsed.amount,
                            title: parsed.title || '', signature: sig, status: 'made',
                        });
                    }
                }
                try {
                    const r = await backend.broadcast.call(proxy, raw);
                    if (entry && entry.status === 'made') Object.assign(entry, { status: 'sent', sentAt: Date.now() });
                    log.store.save();
                    return r;
                } catch (e) {
                    if (entry && e.code !== 7 && e.status !== 502) entry.lastError = e.message;
                    throw e;
                }
            },
        };
        const proxy = new Proxy(backend, {
            get(target, prop) {
                if (Object.prototype.hasOwnProperty.call(wrapped, prop) && typeof target[prop] === 'function') return wrapped[prop];
                const v = target[prop];
                return typeof v === 'function' ? v.bind(proxy) : v;
            },
            set(target, prop, value) {
                target[prop] = value;
                return true;
            },
        });
        return proxy;
    }

    /** Подтверждения сети для отправленных платежей (порциями). */
    async tick(backend, limit = 30) {
        const list = this.store.data.payments.filter((x) => (x.status === 'sent' || x.status === 'made') && x.signature
            && Date.now() - x.at < 3 * 86400000).slice(0, limit);
        for (const e of list) {
            let st;
            try {
                st = await backend.txStatus(e.signature);
            } catch (err) {
                if (err.status === 502) return; // нода недоступна — позже
                continue;
            }
            if (st.found && st.confirmations > 0) Object.assign(e, { status: 'confirmed', confirmations: st.confirmations, seqNo: st.seqNo || null, confirmedAt: Date.now() });
            else if (st.found && e.status === 'made') e.status = 'sent';
            else if (!st.found && Date.now() - (e.sentAt || e.at) > LIFETIME_MS) e.status = e.status === 'made' ? 'expired' : 'lost';
        }
        this.store.save();
    }

    list({ from = 0, to = Infinity, status = null, address = null, limit = 500 } = {}) {
        return this.store.data.payments
            .filter((x) => x.at >= from && x.at <= to && (!status || x.status === status) && (!address || x.from === address || x.to === address))
            .slice(0, Math.min(limit, 5000));
    }

    csv(list) {
        const cell = (v) => {
            const s = String(v ?? '');
            return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const head = ['Время', 'Вид', 'Откуда', 'Куда', 'Актив', 'Сумма', 'Назначение', 'Статус', 'Подтверждений', 'Подпись', 'Кто', 'Источник', 'Ошибка'];
        const rows = list.map((x) => [new Date(x.at).toISOString(), x.kind, x.from, x.to, x.asset, x.amount, x.title, x.status, x.confirmations ?? '', x.signature || '', x.by, x.source, x.error || x.lastError || '']);
        return Buffer.from('﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n', 'utf8');
    }
}

module.exports = { PaymentsLog };
