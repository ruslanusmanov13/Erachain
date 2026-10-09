'use strict';

const crypto = require('crypto');
const { BankError, isAddress, text } = require('./validate');

/**
 * Курсы и маркет-мейкер на бирже Erachain (по мотивам dex-trader).
 *
 * Агрегатор курсов: цена пары (сколько актива want за 1 актив have) из нескольких источников —
 * обменник 7Pay, середина стакана биржи Erachain (без ордеров самого банка), ручной курс. Итог — медиана;
 * если источники расходятся сильнее допустимого или данные устарели — курса нет, торговля стоит.
 *
 * Маркет-мейкер выставляет лестницу ордеров вокруг курса (спред, уровни, шаг) со счёта банка и держит её
 * в актуальном виде. Ограничения риска:
 *  - только пассивные ордера (post-only): ордер, который исполнился бы сразу о стакан, не ставится —
 *    банк не торгует сам с собой (нет «самосделок», wash trading) и не забирает ликвидность по плохой цене;
 *  - лимиты оборота за сутки на покупку и продажу, неснижаемые остатки обоих активов, коридор запаса
 *    базового актива (перекос позиции);
 *  - «стоп-кран»: скачок курса больше заданного — пара останавливается и все её ордера снимаются;
 *  - без курса или без COMPU на комиссии ордера снимаются / не ставятся.
 */

const DEFAULT_SETTINGS = {
    symbols: { 1: 'ERA', 2: 'COMPU' }, // актив Erachain → обозначение в 7Pay (или RUB/USD/BTC для токенов, обеспеченных валютой)
    manual: {},                        // "have/want" → { price, at } — ручной курс
    maxSourceDeviationPct: 5,          // источники расходятся сильнее — курса нет
    manualTtlMin: 24 * 60,             // ручной курс устаревает
    pairs: [],
};

const PAIR_DEFAULTS = {
    enabled: false, sources: ['dex', 'sevenpay'], spreadPct: 2, levels: 2, stepPct: 1, levelSize: '1',
    repricePct: 0.5, maxJumpPct: 10, dailyBuyLimit: '100', dailySellLimit: '100',
    reserveHave: '0', reserveWant: '0', minBase: '0', maxBase: '0', minCompu: '0.01',
};

const DAY = 86400000;
const fix8 = (n) => (Math.floor(n * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, '');
const ceil8 = (n) => (Math.ceil(n * 1e8 - 1e-6) / 1e8).toFixed(8).replace(/\.?0+$/, '');
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function num(v, name, { min = 0, max = Infinity } = {}) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new BankError(`${name}: число${min > 0 ? ' больше ' + min : ''}${max < Infinity ? ' до ' + max : ''}`);
    return n;
}

class MarketMaker {
    /** sevenpay — клиент 7Pay (ratesTable) или null; walletAddresses(password) — счета банка (для защиты от самосделок). */
    constructor(backend, store, { sevenpay = null } = {}) {
        this.backend = backend;
        this.store = store;
        this.sevenpay = sevenpay;
        const d = store.data;
        d.mmSettings = { ...structuredClone(DEFAULT_SETTINGS), ...(d.mmSettings || {}) };
        d.mmOrders = d.mmOrders || [];   // ордера маркет-мейкера: { id, pairId, side, level, ref, seqNo, signature, price, size, placedAt, active, filled }
        d.mmLog = d.mmLog || [];
    }

    settings() {
        return this.store.data.mmSettings;
    }

    log(pairId, text, kind = 'info') {
        this.store.data.mmLog.unshift({ at: Date.now(), pairId, text, kind });
        this.store.data.mmLog.length = Math.min(this.store.data.mmLog.length, 300);
    }

    updateSettings(body) {
        const s = this.settings();
        if (body.symbols && typeof body.symbols === 'object') {
            const map = {};
            for (const [k, v] of Object.entries(body.symbols)) {
                if (!/^\d+$/.test(k)) throw new BankError('Обозначения: номер актива — целое число');
                const sym = text(v, 10).toUpperCase();
                if (sym) map[k] = sym;
            }
            s.symbols = map;
        }
        if (body.maxSourceDeviationPct !== undefined) s.maxSourceDeviationPct = num(body.maxSourceDeviationPct, 'Расхождение источников, %', { min: 0.1, max: 100 });
        if (body.manual && typeof body.manual === 'object') {
            for (const [pair, price] of Object.entries(body.manual)) {
                if (!/^\d+\/\d+$/.test(pair)) throw new BankError('Ручной курс: пара в виде have/want');
                if (price === null || price === '') delete s.manual[pair];
                else s.manual[pair] = { price: num(price, 'Ручной курс', { min: 1e-12 }), at: Date.now() };
            }
        }
        this.store.save();
        return s;
    }

    savePair(body) {
        const s = this.settings();
        const existing = body.id ? s.pairs.find((p) => p.id === body.id) : null;
        if (body.id && !existing) throw new BankError('Пара не найдена', 404);
        const p = { ...PAIR_DEFAULTS, ...(existing || {}) };
        if (!existing) {
            p.have = num(body.have, 'Базовый актив', { min: 1 });
            p.want = num(body.want, 'Котируемый актив', { min: 1 });
            if (!Number.isInteger(p.have) || !Number.isInteger(p.want) || p.have === p.want) throw new BankError('Пара: два разных номера актива');
            if (s.pairs.some((x) => x.have === p.have && x.want === p.want)) throw new BankError('Такая пара уже есть');
            p.id = crypto.randomBytes(4).toString('hex');
            p.createdAt = Date.now();
        }
        if (body.account !== undefined) {
            const a = text(body.account, 40);
            if (!isAddress(a)) throw new BankError('Выберите счёт маркет-мейкера');
            p.account = a;
        }
        if (!p.account) throw new BankError('Выберите счёт маркет-мейкера');
        if (Array.isArray(body.sources)) {
            const src = body.sources.filter((x) => ['dex', 'sevenpay', 'manual'].includes(x));
            if (!src.length) throw new BankError('Нужен хотя бы один источник курса');
            p.sources = [...new Set(src)];
        }
        if (body.spreadPct !== undefined) p.spreadPct = num(body.spreadPct, 'Спред, %', { min: 0.05, max: 50 });
        if (body.levels !== undefined) p.levels = Math.round(num(body.levels, 'Уровней', { min: 1, max: 10 }));
        if (body.stepPct !== undefined) p.stepPct = num(body.stepPct, 'Шаг, %', { min: 0, max: 20 });
        if (body.repricePct !== undefined) p.repricePct = num(body.repricePct, 'Перестановка, %', { min: 0.05, max: 20 });
        if (body.maxJumpPct !== undefined) p.maxJumpPct = num(body.maxJumpPct, 'Стоп-кран, %', { min: 0.5, max: 100 });
        for (const k of ['levelSize', 'dailyBuyLimit', 'dailySellLimit', 'reserveHave', 'reserveWant', 'minBase', 'maxBase', 'minCompu']) {
            if (body[k] !== undefined) p[k] = String(num(body[k], k));
        }
        if (Number(p.levelSize) <= 0) throw new BankError('Объём уровня должен быть больше нуля');
        if (Number(p.maxBase) > 0 && Number(p.maxBase) < Number(p.minBase)) throw new BankError('Коридор запаса: максимум меньше минимума');
        if (body.enabled !== undefined) p.enabled = !!body.enabled;
        if (existing) Object.assign(existing, p);
        else s.pairs.push(p);
        this.store.save();
        return p;
    }

    pair(id) {
        const p = this.settings().pairs.find((x) => x.id === id);
        if (!p) throw new BankError('Пара не найдена', 404);
        return p;
    }

    // ---------- курсы ----------

    async ownSet(password) {
        try {
            this.own = new Set(await this.backend.walletAddresses(password));
        } catch (e) {
            this.own = this.own || new Set();
        }
        for (const p of this.settings().pairs) if (p.account) this.own.add(p.account);
        return this.own;
    }

    async sourcePrice(name, have, want) {
        const s = this.settings();
        if (name === 'manual') {
            const m = s.manual[`${have}/${want}`];
            if (!m) throw new Error('ручной курс не задан');
            if (Date.now() - m.at > s.manualTtlMin * 60000) throw new Error('ручной курс устарел');
            return m.price;
        }
        if (name === 'dex') {
            const own = this.own || new Set();
            const book = await this.backend.orderBook(have, want);
            const ext = (list) => list.filter((o) => !own.has(o.creator)).map((o) => Number(o.price)).filter((x) => x > 0);
            const asks = ext(book.sell);
            const bids = ext(book.buy);
            if (!asks.length || !bids.length) throw new Error('в стакане нет встречных ордеров');
            const ask = Math.min(...asks);
            const bid = Math.max(...bids);
            if (bid >= ask) throw new Error('стакан пересечён');
            return (ask + bid) / 2;
        }
        if (name === 'sevenpay') {
            if (!this.sevenpay) throw new Error('7Pay не подключён');
            const t = await this.sevenpay.ratesTable();
            const rub = new Map((t.rub || []).map(([rate, sym]) => [String(sym).toUpperCase(), Number(rate)]));
            // таблица rub: цена 1 единицы валюты в рублях
            const priceRub = (asset) => {
                const sym = s.symbols[asset];
                if (!sym) throw new Error(`для актива ${asset} не задано обозначение`);
                if (sym === 'RUB') return 1;
                const r = rub.get(sym);
                if (!(r > 0)) throw new Error('7Pay не знает ' + sym);
                return r;
            };
            return priceRub(have) / priceRub(want);
        }
        throw new Error('неизвестный источник');
    }

    /** Курс пары: медиана источников; null, если источников нет или они расходятся. */
    async rate(pairOrIds) {
        const { have, want, sources } = pairOrIds;
        const out = [];
        for (const name of sources || ['dex', 'sevenpay', 'manual']) {
            try {
                const price = await this.sourcePrice(name, have, want);
                if (!(price > 0) || !Number.isFinite(price)) throw new Error('нет цены');
                out.push({ name, price, ok: true });
            } catch (e) {
                out.push({ name, ok: false, error: e.message });
            }
        }
        const ok = out.filter((x) => x.ok).map((x) => x.price);
        if (!ok.length) return { price: null, sources: out, reason: 'нет ни одного источника курса' };
        const price = median(ok);
        const dev = ok.length > 1 ? (Math.max(...ok) - Math.min(...ok)) / price * 100 : 0;
        const maxDev = this.settings().maxSourceDeviationPct;
        if (dev > maxDev) return { price: null, sources: out, deviationPct: dev, reason: `источники расходятся на ${dev.toFixed(1)} % (допустимо ${maxDev} %)` };
        return { price, sources: out, deviationPct: dev };
    }

    // ---------- маркет-мейкер ----------

    pairOrders(p) {
        return this.store.data.mmOrders.filter((o) => o.pairId === p.id && o.active);
    }

    filledToday(p, side) {
        const since = Date.now() - DAY;
        return this.store.data.mmOrders.filter((o) => o.pairId === p.id && o.side === side)
            .reduce((s, o) => s + (o.fills || []).filter((f) => f.at >= since).reduce((a, f) => a + f.base, 0), 0);
    }

    // свериться с биржей: исполнение (в базовом активе) и закрытые ордера
    async syncOrders(p) {
        const mine = await this.backend.myOrders(p.account);
        for (const o of this.pairOrders(p)) {
            if (!o.seqNo && o.signature && this.backend.txStatus) {
                const st = await this.backend.txStatus(o.signature).catch(() => ({ found: false }));
                if (st.found && st.seqNo) o.seqNo = st.seqNo;
            }
            const x = o.seqNo ? mine.find((m) => m.seqNo === o.seqNo) : null;
            if (!x) {
                if (Date.now() - o.placedAt > 10 * 60000) {
                    o.active = false; // не появился в сети за время жизни транзакции
                    this.log(p.id, `Ордер ${o.side === 'ask' ? 'на продажу' : 'на покупку'} по ${o.price} не найден на бирже — снят с учёта`, 'warn');
                }
                continue;
            }
            // left — остаток в отдаваемом активе: у продажи — базовый, у покупки — котируемый
            const left = Number(x.left);
            const doneHave = Number(x.amount) - left;
            const base = o.side === 'ask' ? doneHave : doneHave / o.price;
            const already = (o.fills || []).reduce((a, f) => a + f.base, 0);
            if (base - already > 1e-9) {
                o.fills = [...(o.fills || []), { at: Date.now(), base: base - already }];
                this.log(p.id, `Исполнено ${fix8(base - already)} по ${o.price} (${o.side === 'ask' ? 'продажа' : 'покупка'})`);
            }
            if (x.active === false || left <= 0) o.active = false;
        }
    }

    async cancel(p, o, password, why) {
        try {
            await this.backend.cancelOrder({ creator: p.account, order: o.seqNo || o.signature }, password);
            o.active = false;
            o.cancelledAt = Date.now();
            if (why) this.log(p.id, `Снят ордер по ${o.price}: ${why}`);
        } catch (e) {
            if (e.status === 404 || /не найден|not found|closed/i.test(e.message)) o.active = false;
            else throw e;
        }
    }

    async cancelAll(p, password, why) {
        for (const o of this.pairOrders(p)) await this.cancel(p, o, password, why);
    }

    async balanceOf(address, asset) {
        const b = (await this.backend.balances(address)).find((x) => Number(x.asset) === Number(asset));
        return b ? Number(b.amount) : 0;
    }

    /** Один проход по паре. Возвращает краткий итог. */
    async tickPair(p, password) {
        p.status = p.status || {};
        if (!p.enabled || p.paused) {
            if (this.pairOrders(p).length) await this.cancelAll(p, password, p.paused ? 'пара остановлена' : 'пара выключена');
            return { pair: p.id, skipped: p.paused ? 'paused' : 'disabled' };
        }
        await this.syncOrders(p);
        const r = await this.rate(p);
        p.status = { at: Date.now(), rate: r.price, sources: r.sources, reason: r.reason || null };
        if (!r.price) {
            await this.cancelAll(p, password, 'нет надёжного курса');
            return { pair: p.id, skipped: 'no_rate', reason: r.reason };
        }
        if (p.lastRate && Math.abs(r.price - p.lastRate) / p.lastRate * 100 > p.maxJumpPct) {
            p.paused = true;
            p.pausedReason = `Скачок курса ${p.lastRate} → ${r.price} (больше ${p.maxJumpPct} %)`;
            this.log(p.id, 'Стоп-кран: ' + p.pausedReason, 'bad');
            await this.cancelAll(p, password, 'стоп-кран');
            return { pair: p.id, skipped: 'jump' };
        }
        p.lastRate = r.price;

        // уровни: цены продажи выше курса, покупки — ниже
        const targets = [];
        for (let i = 0; i < p.levels; i++) {
            const off = p.spreadPct / 200 + i * p.stepPct / 100;
            targets.push({ side: 'ask', level: i, price: Number((r.price * (1 + off)).toPrecision(8)) });
            targets.push({ side: 'bid', level: i, price: Number((r.price * (1 - off)).toPrecision(8)) });
        }
        // снять ордера, ушедшие от целевой цены, и лишние уровни
        for (const o of this.pairOrders(p)) {
            const t = targets.find((x) => x.side === o.side && x.level === o.level);
            if (!t) await this.cancel(p, o, password, 'уровень больше не нужен');
            else if (Math.abs(o.price - t.price) / t.price * 100 > p.repricePct) await this.cancel(p, o, password, `курс сдвинулся, новая цена ${t.price}`);
        }

        const compu = await this.balanceOf(p.account, 2);
        if (compu < Number(p.minCompu)) {
            p.status.reason = `Мало COMPU на комиссии: ${compu}`;
            return { pair: p.id, skipped: 'compu' };
        }
        const own = await this.ownSet(password);
        const book = await this.backend.orderBook(p.have, p.want);
        const bestAsk = Math.min(...book.sell.map((o) => Number(o.price)).filter((x) => x > 0), Infinity);
        const bestBid = Math.max(...book.buy.map((o) => Number(o.price)).filter((x) => x > 0), 0);
        const ownAsks = book.sell.filter((o) => own.has(o.creator)).map((o) => Number(o.price));
        const ownBids = book.buy.filter((o) => own.has(o.creator)).map((o) => Number(o.price));
        let baseBal = await this.balanceOf(p.account, p.have);
        let quoteBal = await this.balanceOf(p.account, p.want);
        const size = Number(p.levelSize);
        const placed = [];
        const skipped = [];
        let soldToday = this.filledToday(p, 'ask') + this.pairOrders(p).filter((o) => o.side === 'ask').reduce((s, o) => s + o.size, 0);
        let boughtToday = this.filledToday(p, 'bid') + this.pairOrders(p).filter((o) => o.side === 'bid').reduce((s, o) => s + o.size, 0);
        for (const t of targets) {
            if (this.pairOrders(p).some((o) => o.side === t.side && o.level === t.level)) continue;
            // post-only и без самосделок: ордер не должен исполниться сразу — ни о чужой, ни о свой встречный
            if (t.side === 'ask' && (t.price <= bestBid || ownBids.some((x) => x >= t.price))) { skipped.push(`продажа ${t.price}: исполнилась бы сразу`); continue; }
            if (t.side === 'bid' && (t.price >= bestAsk || ownAsks.some((x) => x <= t.price))) { skipped.push(`покупка ${t.price}: исполнилась бы сразу`); continue; }
            if (t.side === 'ask') {
                if (soldToday + size > Number(p.dailySellLimit)) { skipped.push('лимит продаж за сутки'); continue; }
                if (baseBal - size < Number(p.reserveHave) || baseBal - size < Number(p.minBase)) { skipped.push('запас базового актива на минимуме'); continue; }
            } else {
                const cost = size * t.price;
                if (boughtToday + size > Number(p.dailyBuyLimit)) { skipped.push('лимит покупок за сутки'); continue; }
                if (quoteBal - cost < Number(p.reserveWant)) { skipped.push('неснижаемый остаток котируемого актива'); continue; }
                if (Number(p.maxBase) > 0 && baseBal + size > Number(p.maxBase)) { skipped.push('запас базового актива на максимуме'); continue; }
            }
            const order = t.side === 'ask'
                ? { creator: p.account, have: p.have, want: p.want, haveAmount: fix8(size), wantAmount: ceil8(size * t.price) }
                : { creator: p.account, have: p.want, want: p.have, haveAmount: fix8(size * t.price), wantAmount: fix8(size) };
            try {
                const res = await this.backend.createOrder(order, password);
                const rec = {
                    id: crypto.randomBytes(5).toString('hex'), pairId: p.id, side: t.side, level: t.level, price: t.price, size,
                    seqNo: res.seqNo || null, signature: res.signature || null, placedAt: Date.now(), active: true, fills: [],
                };
                this.store.data.mmOrders.push(rec);
                placed.push(rec);
                if (t.side === 'ask') { baseBal -= size; soldToday += size; } else { quoteBal -= size * t.price; boughtToday += size; }
            } catch (e) {
                if (e.status === 502) throw e;
                skipped.push(`${t.side === 'ask' ? 'продажа' : 'покупка'} ${t.price}: ${e.message}`);
            }
        }
        if (placed.length) this.log(p.id, `Выставлено ордеров: ${placed.length} (курс ${r.price.toPrecision(6)})`);
        p.status.skipped = skipped;
        // ордера, исполнившиеся сразу (на бирже ноды так бывает при гонке) — сверим на следующем проходе
        this.store.data.mmOrders = this.store.data.mmOrders.filter((o) => o.active || Date.now() - (o.cancelledAt || o.placedAt) < 7 * DAY);
        return { pair: p.id, rate: r.price, placed: placed.length, skipped };
    }

    async tick(password) {
        const out = [];
        await this.ownSet(password);
        for (const p of this.settings().pairs) {
            try {
                out.push(await this.tickPair(p, password));
            } catch (e) {
                if (e.status === 502) break;
                p.status = { ...(p.status || {}), at: Date.now(), reason: e.message };
                this.log(p.id, 'Ошибка: ' + e.message, 'bad');
                out.push({ pair: p.id, error: e.message });
            }
        }
        this.store.save();
        return out;
    }

    async resume(id) {
        const p = this.pair(id);
        p.paused = false;
        p.pausedReason = null;
        p.lastRate = null; // курс после остановки берётся заново
        this.log(p.id, 'Пара возобновлена');
        this.store.save();
        return p;
    }

    async pause(id, password) {
        const p = this.pair(id);
        p.paused = true;
        p.pausedReason = 'остановлена вручную';
        await this.cancelAll(p, password, 'остановлена вручную');
        this.log(p.id, 'Пара остановлена вручную', 'warn');
        this.store.save();
        return p;
    }

    async removePair(id, password) {
        const p = this.pair(id);
        await this.cancelAll(p, password, 'пара удалена');
        this.settings().pairs = this.settings().pairs.filter((x) => x.id !== id);
        this.store.save();
        return { ok: true };
    }

    view() {
        const s = this.settings();
        return {
            settings: { symbols: s.symbols, manual: s.manual, maxSourceDeviationPct: s.maxSourceDeviationPct },
            pairs: s.pairs.map((p) => ({
                ...p, orders: this.pairOrders(p).map(({ fills, ...o }) => o),
                soldToday: this.filledToday(p, 'ask'), boughtToday: this.filledToday(p, 'bid'),
            })),
            log: this.store.data.mmLog.slice(0, 50),
        };
    }
}

module.exports = { MarketMaker, median };
