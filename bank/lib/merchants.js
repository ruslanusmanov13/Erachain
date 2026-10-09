'use strict';

const crypto = require('crypto');
const { BankError, isAddress, isAmount, amountOf, text } = require('./validate');

/**
 * Магазины (по образцу cs-cart-vendor): у продавца свой счёт банка, на нём — товар (актив Erachain)
 * и COMPU на комиссии. Покупателю выставляется счёт на оплату (протокол «Безопасный платёж»); когда он
 * оплачен, банк сам отправляет купленный актив со счёта продавца покупателю.
 *
 * Выдача — в две фазы, как начисление СБП: подписанный перевод и его подпись сохраняются ДО отправки,
 * повтор той же транзакции нода отклоняет, а заново перевод формируется только если его нет в сети
 * по истечении времени жизни (~9 минут). Двойной выдачи нет.
 */

const DELIVERY = {
    waiting_payment: 'ждёт оплаты',
    awaiting_address: 'нужен адрес покупателя',
    queue: 'в очереди на выдачу',
    made: 'перевод подписан',
    sent: 'отправлено, ждёт подтверждения',
    delivered: 'выдано',
    expired: 'не оплачен',
    cancelled: 'отменён',
    error: 'ошибка — нужен разбор',
};

// коды ноды, при которых ждём пополнения счёта продавца: 10 — нет COMPU на комиссию, 11 — нет актива
const WAIT_CODES = new Set([10, 11]);
const TX_LIFETIME_MS = 15 * 60000;
const MAX_TRIES = 5;
const DEFAULT_MIN_COMPU = 1;

// произведение десятичных строк без ошибок округления float (до 8 знаков)
function mulDecimal(a, qty) {
    const [i, f = ''] = String(a).split('.');
    const units = BigInt(i + f.padEnd(8, '0').slice(0, 8)) * BigInt(qty);
    const s = units.toString().padStart(9, '0');
    return (s.slice(0, -8) + '.' + s.slice(-8)).replace(/\.?0+$/, '');
}

const ERA_ADDRESS = /(?<![1-9A-HJ-NP-Za-km-z])[78][1-9A-HJ-NP-Za-km-z]{32,34}(?![1-9A-HJ-NP-Za-km-z])/g;

class Merchants {
    /**
     * opts.invoices — сервис счетов; opts.ownAccounts() — [{ n, address }] счетов сид-фразы банка;
     * opts.reserved() — служебные счета (основной, шлюз, выплаты СБП, канал счетов), их магазинам не выдаём.
     */
    constructor(backend, store, opts) {
        this.backend = backend;
        this.store = store;
        this.invoices = opts.invoices;
        this.ownAccounts = opts.ownAccounts || (() => []);
        this.reserved = opts.reserved || (() => []);
        store.data.merchants = store.data.merchants || [];
    }

    list() {
        return this.store.data.merchants;
    }

    get(id) {
        const m = this.store.data.merchants.find((x) => x.id === id);
        if (!m) throw new BankError('Магазин не найден', 404);
        return m;
    }

    // следующий свободный счёт сид-фразы: №2…№21 без служебных и уже занятых магазинами
    freeAccount() {
        const busy = new Set([...this.reserved().filter(Boolean), ...this.store.data.merchants.map((m) => m.address)]);
        const acc = this.ownAccounts().filter((a) => a.n >= 2).sort((x, y) => x.n - y.n).find((a) => !busy.has(a.address));
        if (!acc) throw new BankError('Свободных счетов сид-фразы нет — укажите адрес счёта магазина вручную');
        return acc;
    }

    async create(body, password) {
        const name = text(body.name, 80);
        if (!name) throw new BankError('Укажите название магазина');
        let address = text(body.address, 40);
        let n = null;
        if (address) {
            if (!isAddress(address)) throw new BankError('Неверный адрес счёта магазина');
            if (this.reserved().includes(address)) throw new BankError('Это служебный счёт банка — выберите другой');
            if (this.store.data.merchants.some((m) => m.address === address)) throw new BankError('Этот счёт уже занят другим магазином');
            // выдача подписывается кошельком ноды — счёт должен быть в нём (счёт банка или клиента банка)
            const wallet = await this.backend.walletAddresses(password);
            if (!wallet.includes(address)) throw new BankError('Счёта нет в кошельке банка — выдачу подписать нельзя');
            const own = this.ownAccounts().find((a) => a.address === address);
            n = own ? own.n : null;
        } else {
            ({ address, n } = this.freeAccount());
        }
        const m = {
            id: crypto.randomBytes(6).toString('hex'), name, address, n,
            minCompu: this.minCompu(body.minCompu), products: [], createdAt: Date.now(),
        };
        this.store.data.merchants.push(m);
        this.store.save();
        return m;
    }

    minCompu(v) {
        if (v === undefined || v === null || v === '') return DEFAULT_MIN_COMPU;
        const a = amountOf(v);
        if (!isAmount(a) && Number(a) !== 0) throw new BankError('Порог COMPU — число');
        return Number(a);
    }

    update(id, body) {
        const m = this.get(id);
        if (body.name !== undefined) {
            const name = text(body.name, 80);
            if (!name) throw new BankError('Укажите название магазина');
            m.name = name;
        }
        if (body.minCompu !== undefined) m.minCompu = this.minCompu(body.minCompu);
        if (body.disabled !== undefined) m.disabled = !!body.disabled;
        this.store.save();
        return m;
    }

    // товар: { title, asset, amount — сколько актива за 1 шт., price — цена за 1 шт., curr — валюта счёта }
    saveProduct(id, body) {
        const m = this.get(id);
        const title = text(body.title, 120);
        if (!title) throw new BankError('Укажите название товара');
        const asset = Number(body.asset);
        if (!Number.isSafeInteger(asset) || asset <= 0) throw new BankError('Номер актива — целое число');
        const amount = amountOf(body.amount);
        if (!isAmount(amount)) throw new BankError('Сколько актива выдавать за 1 шт.');
        const price = amountOf(body.price);
        if (!isAmount(price)) throw new BankError('Неверная цена');
        const curr = Number(body.curr || 643);
        if (!Number.isSafeInteger(curr) || curr <= 0) throw new BankError('Неверная валюта');
        this.invoices.assetFor(curr); // валюта должна быть сопоставлена активу, иначе оплату не засчитать
        const p = { title, asset, amount: String(amount), price: String(price), curr };
        const existing = body.id && m.products.find((x) => x.id === body.id);
        if (existing) Object.assign(existing, p);
        else m.products.push({ id: crypto.randomBytes(4).toString('hex'), ...p });
        this.store.save();
        return m;
    }

    removeProduct(id, productId) {
        const m = this.get(id);
        m.products = m.products.filter((p) => p.id !== productId);
        this.store.save();
        return m;
    }

    // ---------- заказ: счёт на оплату с выдачей товара ----------

    async order(id, body, password) {
        const m = this.get(id);
        if (m.disabled) throw new BankError('Магазин приостановлен');
        const p = m.products.find((x) => x.id === body.productId);
        if (!p) throw new BankError('Выберите товар');
        const qty = Number(body.qty || 1);
        if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new BankError('Количество — целое число от 1');
        const deliverTo = text(body.deliverTo, 40);
        if (deliverTo && !isAddress(deliverTo)) throw new BankError('Неверный адрес получателя товара');
        const user = text(body.user, 300) || deliverTo;
        if (!user) throw new BankError('Укажите покупателя: телефон, e-mail или адрес Erachain');
        const amount = mulDecimal(p.amount, qty);
        // товара на счёте магазина должно хватать уже при выставлении счёта
        const stock = await this.stockOf(m, p.asset);
        if (stock !== null && Number(stock) < Number(amount)) throw new BankError(`На счёте магазина не хватает товара: есть ${stock}, нужно ${amount}`);
        const sum = mulDecimal(p.price, qty);
        return this.invoices.issue({
            from: m.address, user, curr: p.curr, sum, expire: body.expire,
            title: `${p.title}${qty > 1 ? ' × ' + qty : ''} — ${m.name}`, description: text(body.description, 300) || 'Без НДС',
            callback: body.callback, order: body.order,
        }, password, {
            // счёт своего магазина: засчитываем любой фактический перевод (сумма — из перевода)
            acceptAny: true,
            deliver: { merchantId: m.id, productId: p.id, asset: p.asset, amount, qty, to: deliverTo || null, state: 'waiting_payment', log: [] },
        });
    }

    orders(merchantId = null) {
        return this.invoices.issued().filter((i) => i.deliver && (!merchantId || i.deliver.merchantId === merchantId))
            .map((i) => ({ ...i, deliver: { ...i.deliver, raw: undefined, stateName: DELIVERY[i.deliver.state] || i.deliver.state } }));
    }

    findOrder(signature) {
        const inv = this.invoices.issued().find((i) => i.signature === signature && i.deliver);
        if (!inv) throw new BankError('Заказ не найден', 404);
        return inv;
    }

    setAddress(signature, address) {
        const inv = this.findOrder(signature);
        const to = text(address, 40);
        if (!isAddress(to)) throw new BankError('Неверный адрес получателя');
        const d = inv.deliver;
        if (!['waiting_payment', 'awaiting_address'].includes(d.state)) throw new BankError('Товар уже выдаётся — адрес менять нельзя');
        d.to = to;
        if (d.state === 'awaiting_address') this.mark(d, 'queue', 'Адрес получателя указан вручную');
        this.store.save();
        return inv;
    }

    // повтор после ошибки: только если подписанной транзакции нет в сети (иначе — ждём её)
    async retry(signature) {
        const inv = this.findOrder(signature);
        const d = inv.deliver;
        if (d.state !== 'error') throw new BankError('Повтор нужен только для заказа с ошибкой');
        if (d.txId) {
            const st = await this.backend.txStatus(d.txId);
            if (st.found) {
                this.mark(d, 'sent', 'Перевод найден в сети');
                this.store.save();
                return inv;
            }
        }
        Object.assign(d, { txId: null, raw: null, tries: 0 });
        this.mark(d, d.to ? 'queue' : 'awaiting_address', 'Повтор выдачи');
        this.store.save();
        return inv;
    }

    mark(d, state, note = null) {
        d.state = state;
        d.message = note;
        d.updatedAt = Date.now();
        d.log = [...(d.log || []), { at: Date.now(), state, note }].slice(-20);
    }

    // кому выдавать: указанный адрес → адрес Erachain среди ID покупателя → счёт, с которого пришла оплата
    recipientOf(inv) {
        if (inv.deliver.to) return inv.deliver.to;
        const ids = String(inv.user || '').match(ERA_ADDRESS);
        if (ids && ids.length === 1 && isAddress(ids[0])) return ids[0];
        const payers = [...new Set(inv.notices.filter((x) => x.assetOk !== false && !x.late).map((x) => x.from))];
        // платёж через другой банк приходит с его счёта — товар ему не отправляем
        const trusted = new Set(this.invoices.settings().trustedBanks);
        const own = payers.filter((a) => !trusted.has(a));
        return own.length === 1 ? own[0] : null;
    }

    /** Фоновая выдача: оплаченные заказы → перевод товара покупателю (две фазы). */
    async deliveries(password) {
        const done = [];
        for (const inv of this.invoices.issued()) {
            const d = inv.deliver;
            if (!d) continue;
            if (d.state === 'waiting_payment') {
                if (inv.status === 'paid') {
                    const to = this.recipientOf(inv);
                    if (to) {
                        d.to = to;
                        this.mark(d, 'queue');
                    } else {
                        this.mark(d, 'awaiting_address', 'Оплата пришла, но адрес покупателя неизвестен — укажите его');
                    }
                    this.store.save();
                } else if (inv.status === 'cancelled') {
                    this.mark(d, 'cancelled');
                    this.store.save();
                } else if (inv.expiresAt < Date.now() - TX_LIFETIME_MS && !inv.paidSum && !inv.pendingSum) {
                    this.mark(d, 'expired');
                    this.store.save();
                }
            }
            if (d.state === 'queue') {
                if ((d.tries || 0) >= MAX_TRIES) {
                    this.mark(d, 'error', `Перевод не прошёл после ${MAX_TRIES} попыток`);
                    this.store.save();
                    continue;
                }
                const m = this.store.data.merchants.find((x) => x.id === d.merchantId);
                if (!m) {
                    this.mark(d, 'error', 'Магазин удалён');
                    this.store.save();
                    continue;
                }
                try {
                    const made = await this.backend.makeTransfer({
                        from: m.address, to: d.to, asset: d.asset, amount: d.amount,
                        title: ('Заказ ' + inv.order).slice(0, 60), message: JSON.stringify({ order: inv.order, invoice: inv.signature }), encrypt: false,
                    }, password);
                    Object.assign(d, { txId: made.signature, raw: made.raw, makeAt: Date.now(), tries: (d.tries || 0) + 1 });
                    this.mark(d, 'made');
                    this.store.save();
                } catch (e) {
                    if (e.status === 502) return done; // нода недоступна — в следующий раз
                    d.eraCode = e.code ?? null;
                    this.mark(d, 'error', e.message);
                    this.store.save();
                    continue;
                }
            }
            if (d.state === 'made') {
                if ((await this.sendMade(d)) === 'stop') return done;
            }
            if (d.state === 'sent') {
                let st;
                try {
                    st = await this.backend.txStatus(d.txId);
                } catch (e) {
                    return done;
                }
                const minConf = this.invoices.settings().minConfirmations || 1;
                if (st.found && st.confirmations >= minConf) {
                    Object.assign(d, { raw: null, confirmations: st.confirmations, deliveredAt: Date.now() });
                    this.mark(d, 'delivered');
                    this.store.save();
                    done.push(inv.signature);
                } else if (!st.found && Date.now() - d.makeAt > TX_LIFETIME_MS) {
                    Object.assign(d, { txId: null, raw: null });
                    this.mark(d, 'queue', 'Перевод выпал из сети — формируем заново');
                    this.store.save();
                }
            }
        }
        return done;
    }

    async sendMade(d) {
        try {
            const st = await this.backend.txStatus(d.txId);
            if (st.found) {
                this.mark(d, 'sent');
            } else if (Date.now() - d.makeAt > TX_LIFETIME_MS) {
                Object.assign(d, { txId: null, raw: null });
                this.mark(d, 'queue', 'Перевод не попал в сеть за время жизни — формируем заново');
            } else {
                await this.backend.broadcast(d.raw);
                d.sentAt = Date.now();
                this.mark(d, 'sent');
            }
        } catch (e) {
            if (e.status === 502) return 'stop';
            if (WAIT_CODES.has(e.code) || /недостаточно|not enough|no balance/i.test(e.message)) {
                // подпись та же — после пополнения счёта магазина уйдёт этот же перевод
                d.eraCode = e.code ?? null;
                d.message = (e.code === 10 ? 'Нет COMPU на комиссию' : 'Не хватает товара') + ' на счёте магазина — пополните его';
            } else if (e.code !== 7) {
                d.eraCode = e.code ?? null;
                this.mark(d, 'error', e.message);
            }
        }
        this.store.save();
        return 'ok';
    }

    // ---------- остатки и контроль COMPU ----------

    async stockOf(m, asset) {
        if (!this.backend.balances) return null;
        const b = (await this.backend.balances(m.address)).find((x) => Number(x.asset) === Number(asset));
        return b ? String(b.amount) : '0';
    }

    async overview() {
        const out = [];
        for (const m of this.store.data.merchants) {
            const balances = this.backend.balances ? await this.backend.balances(m.address).catch(() => []) : [];
            const amount = (asset) => {
                const b = balances.find((x) => Number(x.asset) === Number(asset));
                return b ? String(b.amount) : '0';
            };
            const orders = this.invoices.issued().filter((i) => i.deliver && i.deliver.merchantId === m.id);
            out.push({
                ...m, compu: amount(2), lowCompu: Number(amount(2)) < m.minCompu,
                products: m.products.map((p) => ({ ...p, stock: amount(p.asset) })),
                stats: {
                    orders: orders.length, delivered: orders.filter((i) => i.deliver.state === 'delivered').length,
                    pending: orders.filter((i) => ['queue', 'made', 'sent', 'awaiting_address'].includes(i.deliver.state)).length,
                    errors: orders.filter((i) => i.deliver.state === 'error').length,
                },
            });
        }
        return out;
    }

    /** Счета, где COMPU меньше порога: магазины и служебные счета банка (им тоже нужна комиссия). */
    async compuAlerts(service = []) {
        const alerts = [];
        if (!this.backend.balances) return alerts;
        const check = async (address, label, min) => {
            if (!address) return;
            const b = (await this.backend.balances(address).catch(() => [])).find((x) => Number(x.asset) === 2);
            const compu = b ? Number(b.amount) : 0;
            if (compu < min) alerts.push({ address, label, compu, min });
        };
        for (const m of this.store.data.merchants) if (!m.disabled) await check(m.address, 'Магазин «' + m.name + '»', m.minCompu);
        const seen = new Set();
        for (const s of service) {
            if (!s.address || seen.has(s.address)) continue;
            seen.add(s.address);
            await check(s.address, s.label, s.min ?? DEFAULT_MIN_COMPU);
        }
        return alerts;
    }
}

module.exports = { Merchants, DELIVERY, mulDecimal };
