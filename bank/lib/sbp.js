'use strict';

const crypto = require('crypto');
const { BankError, isAddress, text } = require('./validate');

/**
 * Приём платежей по СБП (Система быстрых платежей) с начислением активов Erachain —
 * по образцу сервиса era-polza-sbp (gitlab.com/erachain/era-polza-sbp):
 *
 *  1. Клиент указывает свой счёт Erachain, сумму в рублях и актив (паевой рубль, ERA, COMPU…).
 *  2. Сервер регистрирует динамический QR-код СБП в банке «Точка» (qrcType 02) и показывает его.
 *  3. Процессор опрашивает статусы оплат (qr-codes/{ids}/payment-status).
 *  4. После Accepted сумма пересчитывается по курсу и актив переводится клиенту со счёта выплат.
 *     В сообщении перевода — «qrcId:trxId»: по нему после сбоя находится уже сделанная выплата,
 *     поэтому повторного начисления не бывает.
 *
 * Статус заказа меняется только после успешного шага; ошибка шага оставляет прежний статус
 * для повтора, неисправимые — FAIL_* для ручного разбора (как в era-polza-sbp).
 */

const STATUS = {
    NEW: 'создан',
    SBP_ACTIVE: 'ожидает оплаты',
    SBP_DONE: 'оплачен по СБП',
    ERA_QUEUE: 'в очереди на начисление',
    ERA_SENDING: 'начисляется',
    ERA_SEND: 'отправлено в блокчейн',
    ERA_DONE: 'начислено',
    EXPIRED: 'QR-код истёк',
    FAIL_MAKE: 'ошибка создания QR',
    FAIL_SBP: 'оплата отклонена',
    FAIL_RATE: 'нет курса',
    FAIL_ERA: 'ошибка начисления',
};

const ACTIVE = ['NEW', 'SBP_ACTIVE'];
const DEDUPE_MS = 12 * 60 * 1000; // повторный запрос той же пары «счёт+сумма+актив» вернёт тот же заказ

const DEFAULT_SETTINGS = {
    enabled: true,
    payoutAccount: '',                // счёт кошелька ноды, с которого начисляются активы
    purpose: 'Оплата через Банк Erachain',
    minRub: 50,
    ttlMinutes: 10,
    redirectUrl: '',
    // курс: сколько рублей стоит 1 единица актива (для «паевого рубля» — 1)
    assets: [
        { asset: 1048, name: 'Цифровой рубль', rubPerUnit: 1, scale: 2 },
        { asset: 1, name: 'ERA', rubPerUnit: 27.55, scale: 8 },
        { asset: 2, name: 'COMPU', rubPerUnit: 25000, scale: 8 },
    ],
};

/**
 * Клиент СБП банка «Точка» (enter.tochka.com, API sbp v2.0).
 * Настройки — из переменных окружения: токен не хранится в данных сервера.
 */
class TochkaSbpClient {
    constructor({ token, merchantId, account, bik, mode = 'test', baseUrl, timeoutMs = 20000 }) {
        this.token = token;
        this.merchantId = merchantId;
        this.account = account;
        this.bik = bik;
        this.mode = mode;
        this.baseUrl = (baseUrl || (mode === 'prod' ? 'https://enter.tochka.com/uapi/sbp/v2.0' : 'https://enter.tochka.com/sandbox/v2/sbp/v2.0')).replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
    }

    async call(method, path, body) {
        let res;
        try {
            res = await fetch(this.baseUrl + path, {
                method,
                headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (e) {
            const err = new BankError('Банк «Точка» недоступен', 502);
            err.broken = true; // временная ошибка — шаг повторится
            throw err;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = (data.Errors && data.Errors[0] && data.Errors[0].message) || data.message || 'HTTP ' + res.status;
            const err = new BankError('Точка: ' + msg, res.status >= 500 ? 502 : 400);
            err.broken = res.status >= 500;
            throw err;
        }
        return data;
    }

    // Регистрация динамического QR-кода (qrcType 02), сумма в копейках
    async createQr({ amountKop, purpose, sourceName, ttlMinutes, redirectUrl }) {
        const Data = {
            amount: amountKop, currency: 'RUB', qrcType: '02', paymentPurpose: purpose,
            imageParams: { width: 300, height: 300, mediaType: 'image/png' },
            sourceName, ttl: ttlMinutes,
        };
        if (redirectUrl) Data.redirectUrl = redirectUrl;
        const r = await this.call('POST', `/qr-code/merchant/${this.merchantId}/${this.account}/${this.bik}`, { Data });
        const d = r.Data || {};
        return { qrcId: d.qrcId, payload: d.payload, image: d.image && d.image.content ? d.image : null };
    }

    async qrInfo(qrcId) {
        const r = await this.call('GET', `/qr-code/${encodeURIComponent(qrcId)}`);
        return r.Data || {};
    }

    // Статусы оплат по списку QR: NotStarted | Received | InProgress | Accepted | Rejected
    async paymentStatuses(qrcIds) {
        const r = await this.call('GET', `/qr-codes/${qrcIds.map(encodeURIComponent).join(',')}/payment-status`);
        return ((r.Data || {}).paymentList) || [];
    }
}

/**
 * Эмулятор СБП для демо и тестов: оплата «проходит» через acceptAfterMs после создания QR,
 * если сумма не оканчивается на 13 копеек (так можно проверить отказ).
 */
class SbpEmulator {
    constructor({ acceptAfterMs = 8000 } = {}) {
        this.acceptAfterMs = acceptAfterMs;
        this.qrs = new Map();
        this.mode = 'demo';
    }

    async createQr({ amountKop, purpose }) {
        const qrcId = 'AD' + crypto.randomBytes(15).toString('hex').toUpperCase().slice(0, 30);
        this.qrs.set(qrcId, { amountKop, created: Date.now() });
        return {
            qrcId,
            payload: `https://qr.nspk.ru/${qrcId}?type=02&bank=100000000284&sum=${amountKop}&cur=RUB&crc=AB12&payment_purpose=${encodeURIComponent(purpose)}`,
            image: null,
        };
    }

    async qrInfo(qrcId) {
        return { status: this.qrs.has(qrcId) ? 'Active' : 'NotFound', commissionPercent: 0.4 };
    }

    // ручное подтверждение оплаты (кнопка в демо)
    accept(qrcId) {
        const q = this.qrs.get(qrcId);
        if (q) q.created = 0;
    }

    async paymentStatuses(qrcIds) {
        return qrcIds.filter((id) => this.qrs.has(id)).map((qrcId) => {
            const q = this.qrs.get(qrcId);
            if (Date.now() - q.created < this.acceptAfterMs) return { qrcId, code: 'RQ00000', status: 'NotStarted' };
            if (q.amountKop % 100 === 13) return { qrcId, code: 'RQ05043', status: 'Rejected', message: 'Платёж отклонён банком плательщика' };
            return { qrcId, code: 'RQ00000', status: 'Accepted', trxId: 'A' + crypto.randomBytes(14).toString('hex').toUpperCase() };
        });
    }
}

function roundDown(value, scale) {
    const f = 10 ** scale;
    return Math.floor(value * f + 1e-9) / f;
}

class SbpService {
    /**
     * client — TochkaSbpClient или SbpEmulator; walletPassword() — пароль кошелька для начисления
     * (у сервера он есть только при открытой смене), иначе начисление ждёт в очереди.
     */
    constructor(client, backend, store, walletPassword) {
        this.client = client;
        this.backend = backend;
        this.store = store;
        this.walletPassword = walletPassword;
        store.data.sbpOrders = store.data.sbpOrders || [];
        store.data.sbpSettings = { ...structuredClone(DEFAULT_SETTINGS), ...(store.data.sbpSettings || {}) };
        this.busy = false;
        // после перезапуска: незавершённое начисление проверяется по истории счёта
        for (const o of store.data.sbpOrders) if (o.status === 'ERA_SENDING') o.recover = true;
    }

    settings() {
        return { ...this.store.data.sbpSettings, mode: this.client.mode || 'test' };
    }

    publicConfig() {
        const s = this.store.data.sbpSettings;
        return {
            enabled: s.enabled && !!s.payoutAccount, minRub: s.minRub, purpose: s.purpose, mode: this.client.mode || 'test',
            assets: s.assets.map((a) => ({ asset: a.asset, name: a.name, rubPerUnit: a.rubPerUnit, scale: a.scale })),
        };
    }

    updateSettings(body) {
        const s = this.store.data.sbpSettings;
        if (body.enabled !== undefined) s.enabled = body.enabled === true;
        if (body.payoutAccount !== undefined) {
            const a = text(body.payoutAccount, 40);
            if (a && !isAddress(a)) throw new BankError('Неверный счёт выплат');
            s.payoutAccount = a;
        }
        if (body.purpose !== undefined) s.purpose = text(body.purpose, 140) || DEFAULT_SETTINGS.purpose;
        if (body.redirectUrl !== undefined) {
            const u = text(body.redirectUrl, 300);
            if (u && !/^https:\/\//.test(u)) throw new BankError('Адрес возврата должен начинаться с https://');
            s.redirectUrl = u;
        }
        if (body.minRub !== undefined) {
            const m = Number(body.minRub);
            if (!(m >= 1)) throw new BankError('Минимальная сумма — от 1 ₽');
            s.minRub = m;
        }
        if (body.ttlMinutes !== undefined) {
            const t = Number(body.ttlMinutes);
            if (!Number.isInteger(t) || t < 1 || t > 129600) throw new BankError('Срок QR: от 1 минуты');
            s.ttlMinutes = t;
        }
        if (Array.isArray(body.assets)) {
            s.assets = body.assets.map((a) => {
                const asset = Number(a.asset);
                const rub = Number(a.rubPerUnit);
                const scale = Number(a.scale ?? 8);
                if (!Number.isSafeInteger(asset) || asset <= 0) throw new BankError('Неверный номер актива');
                if (!(rub > 0)) throw new BankError(`Курс для актива ${asset} должен быть больше нуля`);
                if (!Number.isInteger(scale) || scale < 0 || scale > 8) throw new BankError('Точность актива: 0–8');
                return { asset, name: text(a.name, 60) || '#' + asset, rubPerUnit: rub, scale };
            });
            if (!s.assets.length) throw new BankError('Нужен хотя бы один актив');
        }
        this.store.save();
        return this.settings();
    }

    view(o, full = false) {
        const v = {
            id: o.id, status: o.status, statusText: STATUS[o.status] || o.status, receiver: o.receiver, asset: o.asset,
            assetName: o.assetName, amountRub: o.amountKop / 100, amountChain: o.amountChain, rubPerUnit: o.rubPerUnit,
            qrcId: o.qrcId || null, payload: o.payload || null, image: o.image || null,
            createdAt: o.createdAt, expiresAt: o.expiresAt || null, txId: o.txId || null, confirmations: o.confirmations || 0,
            message: o.message || null,
        };
        if (full) Object.assign(v, { trxIdSbp: o.trxIdSbp || null, sbpCode: o.sbpCode || null, source: o.source || 'public', createdBy: o.createdBy || null });
        return v;
    }

    // Создание заказа и QR-кода (публично — клиентом, или сотрудником для клиента в отделении)
    async createOrder(body, source = 'public', createdBy = null) {
        const s = this.store.data.sbpSettings;
        if (!s.enabled || !s.payoutAccount) throw new BankError('Приём платежей по СБП не настроен', 503);
        const receiver = text(body.receiver, 40);
        if (!isAddress(receiver)) throw new BankError('Неверный счёт Erachain получателя');
        const asset = Number(body.asset);
        const conf = s.assets.find((a) => a.asset === asset);
        if (!conf) throw new BankError('Этот актив не продаётся через СБП');
        const rub = Number(String(body.amount ?? '').replace(',', '.'));
        if (!(rub > 0) || !/^\d+([.,]\d{1,2})?$/.test(String(body.amount).trim())) throw new BankError('Сумма в рублях: например 550 или 550.95');
        if (rub < s.minRub) throw new BankError(`Минимальная сумма — ${s.minRub} ₽`);
        if (rub > 600000) throw new BankError('Максимальная сумма одного платежа — 600 000 ₽');
        const amountKop = Math.round(rub * 100);

        // защита от спама: та же пара «счёт + сумма + актив» в течение 12 минут — тот же заказ
        const same = this.store.data.sbpOrders.find((o) => o.receiver === receiver && o.amountKop === amountKop && o.asset === asset
            && ACTIVE.includes(o.status) && Date.now() - o.createdAt < DEDUPE_MS);
        if (same) return this.view(same, source === 'office');

        const order = {
            id: crypto.randomUUID(), status: 'NEW', receiver, asset, assetName: conf.name, scale: conf.scale,
            rubPerUnit: conf.rubPerUnit, amountKop, amountChain: roundDown(rub / conf.rubPerUnit, conf.scale),
            createdAt: Date.now(), source, createdBy,
        };
        this.store.data.sbpOrders.unshift(order);
        try {
            const qr = await this.client.createQr({
                amountKop, purpose: s.purpose, sourceName: receiver, ttlMinutes: s.ttlMinutes, redirectUrl: s.redirectUrl || undefined,
            });
            if (!qr.qrcId) throw new BankError('Банк не вернул идентификатор QR-кода');
            Object.assign(order, {
                qrcId: qr.qrcId, payload: qr.payload, image: qr.image ? { mediaType: qr.image.mediaType, content: qr.image.content } : null,
                status: 'SBP_ACTIVE', expiresAt: Date.now() + s.ttlMinutes * 60000,
            });
        } catch (e) {
            Object.assign(order, { status: 'FAIL_MAKE', message: e.message });
        }
        this.store.save();
        if (order.status === 'FAIL_MAKE') throw new BankError('Не удалось создать QR-код: ' + order.message, 502);
        return this.view(order, source === 'office');
    }

    get(id) {
        const o = this.store.data.sbpOrders.find((x) => x.id === id);
        if (!o) throw new BankError('Заказ не найден', 404);
        return o;
    }

    list(limit = 200) {
        return this.store.data.sbpOrders.slice(0, limit).map((o) => this.view(o, true));
    }

    stats() {
        const orders = this.store.data.sbpOrders;
        const sum = (f) => orders.filter(f).reduce((acc, o) => acc + o.amountKop, 0) / 100;
        return {
            total: orders.length,
            paidRub: sum((o) => ['SBP_DONE', 'ERA_QUEUE', 'ERA_SENDING', 'ERA_SEND', 'ERA_DONE'].includes(o.status)),
            creditedRub: sum((o) => o.status === 'ERA_DONE'),
            waiting: orders.filter((o) => o.status === 'SBP_ACTIVE').length,
            queue: orders.filter((o) => ['SBP_DONE', 'ERA_QUEUE'].includes(o.status)).length,
            failed: orders.filter((o) => o.status.startsWith('FAIL')).length,
        };
    }

    // Ручные действия сотрудника над заказом: повтор начисления, отметка ошибки
    retry(id) {
        const o = this.get(id);
        if (!['FAIL_ERA', 'FAIL_RATE'].includes(o.status)) throw new BankError('Повторить можно только начисление с ошибкой');
        Object.assign(o, { status: 'ERA_QUEUE', message: null });
        this.store.save();
        return this.view(o, true);
    }

    // демо: «оплатить» QR кнопкой
    emulatePay(id) {
        if (typeof this.client.accept !== 'function') throw new BankError('Доступно только в демо-режиме', 400);
        const o = this.get(id);
        this.client.accept(o.qrcId);
        return this.view(o);
    }

    // ---------- процессор (вызывается по таймеру) ----------

    async tick() {
        if (this.busy) return;
        this.busy = true;
        try {
            await this.checkPayments();
            await this.recover();
            await this.creditQueue();
            await this.checkConfirmations();
        } finally {
            this.busy = false;
        }
    }

    save(o, patch) {
        Object.assign(o, patch);
        this.store.save();
    }

    async checkPayments() {
        const active = this.store.data.sbpOrders.filter((o) => o.status === 'SBP_ACTIVE');
        if (!active.length) return;
        let list;
        try {
            list = await this.client.paymentStatuses(active.map((o) => o.qrcId));
        } catch (e) {
            return; // банк недоступен — проверим в следующий раз
        }
        for (const o of active) {
            const p = list.find((x) => x.qrcId === o.qrcId);
            if (p && p.status === 'Accepted') {
                this.save(o, { status: 'SBP_DONE', trxIdSbp: p.trxId || null, sbpCode: p.code || null, paidAt: Date.now() });
            } else if (p && p.status === 'Rejected') {
                this.save(o, { status: 'FAIL_SBP', message: p.message || 'Оплата отклонена', sbpCode: p.code || null });
            } else if ((!p || p.status === 'NotStarted') && o.expiresAt && Date.now() > o.expiresAt + 60000) {
                this.save(o, { status: 'EXPIRED' });
            }
        }
        // оплаченные — в очередь на начисление по курсу, зафиксированному при создании
        for (const o of this.store.data.sbpOrders.filter((x) => x.status === 'SBP_DONE')) {
            if (!(o.amountChain > 0)) this.save(o, { status: 'FAIL_RATE', message: 'Сумма к начислению равна нулю' });
            else this.save(o, { status: 'ERA_QUEUE' });
        }
    }

    marker(o) {
        return `${o.qrcId}:${o.trxIdSbp || ''}`;
    }

    // незавершённая отправка после сбоя: ищем перевод с меткой заказа в истории счёта выплат
    async recover() {
        const s = this.store.data.sbpSettings;
        const pending = this.store.data.sbpOrders.filter((o) => o.status === 'ERA_SENDING' && o.recover);
        if (!pending.length) return;
        let history;
        try {
            history = await this.backend.history(s.payoutAccount, 200, this.walletPassword());
        } catch (e) {
            return;
        }
        for (const o of pending) {
            const tx = history.find((t) => t.to === o.receiver && (t.message || '').includes(o.qrcId));
            this.save(o, tx ? { status: 'ERA_SEND', txId: tx.signature, recover: false } : { status: 'ERA_QUEUE', recover: false });
        }
    }

    async creditQueue() {
        const s = this.store.data.sbpSettings;
        const queue = this.store.data.sbpOrders.filter((o) => o.status === 'ERA_QUEUE').reverse();
        if (!queue.length) return;
        let password;
        try {
            password = this.walletPassword();
        } catch (e) {
            for (const o of queue) if (o.message !== e.message) this.save(o, { message: e.message });
            return; // смена закрыта — начислим, когда откроют
        }
        for (const o of queue) {
            this.save(o, { status: 'ERA_SENDING', recover: false, message: null });
            try {
                const tx = await this.backend.transfer({
                    from: s.payoutAccount, to: o.receiver, asset: o.asset, amount: String(o.amountChain),
                    title: 'СБП ' + (o.amountKop / 100).toFixed(2) + ' ₽', message: this.marker(o), encrypt: false,
                }, password);
                this.save(o, { status: 'ERA_SEND', txId: tx.signature, sentAt: Date.now() });
            } catch (e) {
                // нехватка средств или нода недоступна — повторим; прочие ошибки требуют разбора
                const retry = e.status === 502 || /недостаточно|not enough|no balance|locked|смена/i.test(e.message);
                this.save(o, { status: retry ? 'ERA_QUEUE' : 'FAIL_ERA', message: e.message });
                if (e.status === 502) return;
            }
        }
    }

    async checkConfirmations() {
        const s = this.store.data.sbpSettings;
        const sent = this.store.data.sbpOrders.filter((o) => o.status === 'ERA_SEND');
        if (!sent.length) return;
        let history;
        try {
            history = await this.backend.history(s.payoutAccount, 200, this.walletPassword());
        } catch (e) {
            return;
        }
        for (const o of sent) {
            const tx = history.find((t) => t.signature === o.txId);
            if (tx && tx.confirmations > 0) this.save(o, { status: 'ERA_DONE', confirmations: tx.confirmations, doneAt: Date.now() });
            else if (!tx && o.sentAt && Date.now() - o.sentAt > 30 * 60000 && !o.message) {
                // повторно не отправляем автоматически — это могло бы дать двойное начисление
                this.save(o, { message: 'Не подтверждено более 30 минут — проверьте транзакцию в обозревателе' });
            }
        }
    }
}

module.exports = { SbpService, TochkaSbpClient, SbpEmulator, STATUS, DEFAULT_SETTINGS };
