'use strict';

const { BankError, isAddress, isAmount, amountOf, text } = require('./validate');

/**
 * Залоговое кредитование по модели Vires (icreator/protocol): пулы активов, депозиты под процент,
 * займы под залог депозитов, ставка от загрузки пула, «здоровье» позиции и ликвидация.
 *
 * Деньги лежат на счёте пула банка в блокчейне, банк ведёт учёт долей:
 *  - депозит: клиент переводит актив на счёт пула, получает доли депозита (растут вместе с индексом дохода);
 *    депозит одновременно служит залогом;
 *  - займ: выдаётся со счёта пула, если «здоровье» после займа не ниже 1 по коэффициенту залога (LTV);
 *  - ставка займа от загрузки пула U = займы / депозиты: base + slope1·U/opt до оптимума, выше — круче (slope2);
 *    доход вкладчиков = ставка займа · U · (1 − доля банка);
 *  - здоровье HF = Σ залог·цена·порог ликвидации / Σ долг·цена; HF < 1 — позицию можно ликвидировать:
 *    казна банка гасит часть долга (не больше closeFactor) и забирает залог с премией (liquidationBonus).
 *
 * Цены активов — от агрегатора курсов (медиана 7Pay, стакана биржи, ручного курса) в котируемом активе.
 * Без надёжной цены займы, вывод залога и ликвидация не выполняются.
 */

const YEAR = 365 * 86400000;
const POOL_DEFAULTS = {
    enabled: true, collateralFactor: 0.6, liquidationThreshold: 0.75, liquidationBonus: 0.05, closeFactor: 0.5,
    reserveFactor: 0.1, baseRate: 0.02, slope1: 0.1, optimal: 0.8, slope2: 1.0, scale: 8,
};
const DEFAULT_SETTINGS = { poolAccount: '', treasuryAccount: '', quoteAsset: 1048, priceSources: ['dex', 'sevenpay', 'manual'], autoLiquidate: false, warnHf: 1.1 };

const r8 = (x, scale = 8) => Math.floor(x * 10 ** scale + 1e-6) / 10 ** scale;
const str = (x, scale = 8) => r8(x, scale).toFixed(scale).replace(/\.?0+$/, '') || '0';

function frac(v, name, max = 1) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new BankError(`${name}: от 0 до ${max}`);
    return n;
}

class Lending {
    /** rate({have, want, sources}) — агрегатор курсов (MarketMaker.rate). */
    constructor(backend, store, { rate }) {
        this.backend = backend;
        this.store = store;
        this.rateFn = rate;
        const d = store.data;
        d.lendSettings = { ...DEFAULT_SETTINGS, ...(d.lendSettings || {}) };
        d.lendPools = d.lendPools || [];      // { asset, ...конфиг, supplyIndex, borrowIndex, supplyShares, borrowShares, updatedAt }
        d.lendPositions = d.lendPositions || {}; // адрес → { supply: {asset: доли}, borrow: {asset: доли} }
        d.lendLog = d.lendLog || [];
    }

    settings() {
        return this.store.data.lendSettings;
    }

    updateSettings(body) {
        const s = this.settings();
        // сначала проверки, потом изменения — неверный запрос ничего не меняет
        const acc = {};
        for (const k of ['poolAccount', 'treasuryAccount']) {
            if (body[k] === undefined) continue;
            const a = text(body[k], 40);
            if (a && !isAddress(a)) throw new BankError('Неверный счёт');
            acc[k] = a;
        }
        const next = { ...s, ...acc };
        if (next.poolAccount && next.poolAccount === next.treasuryAccount) throw new BankError('Счёт пула и казна должны различаться');
        Object.assign(s, acc);
        if (body.quoteAsset !== undefined) {
            const q = Number(body.quoteAsset);
            if (!Number.isSafeInteger(q) || q <= 0) throw new BankError('Котируемый актив — номер актива');
            s.quoteAsset = q;
        }
        if (Array.isArray(body.priceSources)) s.priceSources = body.priceSources.filter((x) => ['dex', 'sevenpay', 'manual'].includes(x));
        if (body.autoLiquidate !== undefined) s.autoLiquidate = !!body.autoLiquidate;
        if (body.warnHf !== undefined) s.warnHf = frac(body.warnHf, 'Порог предупреждения', 10);
        this.store.save();
        return s;
    }

    pool(asset) {
        const p = this.store.data.lendPools.find((x) => x.asset === Number(asset));
        if (!p) throw new BankError(`Пула актива ${asset} нет`, 404);
        return p;
    }

    savePool(body) {
        const asset = Number(body.asset);
        if (!Number.isSafeInteger(asset) || asset <= 0) throw new BankError('Номер актива пула');
        const existing = this.store.data.lendPools.find((x) => x.asset === asset);
        if (existing) this.accrue(existing);
        const p = existing ? { ...existing } : { asset, ...POOL_DEFAULTS, supplyIndex: 1, borrowIndex: 1, supplyShares: 0, borrowShares: 0, updatedAt: Date.now() };
        for (const k of ['collateralFactor', 'liquidationThreshold', 'closeFactor', 'reserveFactor', 'optimal']) if (body[k] !== undefined) p[k] = frac(body[k], k);
        for (const k of ['liquidationBonus']) if (body[k] !== undefined) p[k] = frac(body[k], k, 0.5);
        for (const k of ['baseRate', 'slope1', 'slope2']) if (body[k] !== undefined) p[k] = frac(body[k], k, 10);
        if (body.scale !== undefined) p.scale = Math.round(frac(body.scale, 'Точность', 8));
        if (body.enabled !== undefined) p.enabled = !!body.enabled;
        if (p.collateralFactor > p.liquidationThreshold) throw new BankError('Коэффициент залога (LTV) не может быть выше порога ликвидации');
        if (p.optimal <= 0) throw new BankError('Оптимальная загрузка больше нуля');
        if (existing) Object.assign(existing, p);
        else this.store.data.lendPools.push(p);
        this.store.save();
        return this.poolView(existing || p);
    }

    // ---------- проценты ----------

    rates(p) {
        const supplied = p.supplyShares * p.supplyIndex;
        const borrowed = p.borrowShares * p.borrowIndex;
        const u = supplied > 0 ? Math.min(borrowed / supplied, 1) : 0;
        const borrowRate = u <= p.optimal ? p.baseRate + p.slope1 * (u / p.optimal)
            : p.baseRate + p.slope1 + p.slope2 * ((u - p.optimal) / (1 - p.optimal || 1));
        const supplyRate = borrowRate * u * (1 - p.reserveFactor);
        return { utilization: u, borrowRate, supplyRate, supplied, borrowed, cash: supplied - borrowed };
    }

    // начислить проценты с прошлого раза (индексы растут, доли — нет)
    accrue(p, now = Date.now()) {
        const dt = Math.max(0, now - p.updatedAt) / YEAR;
        if (dt > 0) {
            const { borrowRate, supplyRate } = this.rates(p);
            p.borrowIndex *= 1 + borrowRate * dt;
            p.supplyIndex *= 1 + supplyRate * dt;
            p.updatedAt = now;
        }
        return p;
    }

    accrueAll(now = Date.now()) {
        for (const p of this.store.data.lendPools) this.accrue(p, now);
    }

    // ---------- цены и здоровье ----------

    async prices(assets) {
        const s = this.settings();
        const out = {};
        for (const a of new Set(assets.map(Number))) {
            if (a === s.quoteAsset) {
                out[a] = 1;
                continue;
            }
            const r = await this.rateFn({ have: a, want: s.quoteAsset, sources: s.priceSources });
            out[a] = r.price || null;
        }
        return out;
    }

    position(address) {
        const pos = this.store.data.lendPositions[address] || { supply: {}, borrow: {} };
        const supply = {};
        const borrow = {};
        for (const [a, sh] of Object.entries(pos.supply)) if (sh > 0) supply[a] = sh * this.pool(a).supplyIndex;
        for (const [a, sh] of Object.entries(pos.borrow)) if (sh > 0) borrow[a] = sh * this.pool(a).borrowIndex;
        return { supply, borrow };
    }

    /** Здоровье позиции: по порогу ликвидации (hf) и по коэффициенту залога (для новых займов — hfBorrow). */
    health(pos, prices) {
        let liq = 0;
        let ltv = 0;
        let debt = 0;
        let collateral = 0;
        let unknown = false;
        for (const [a, amt] of Object.entries(pos.supply)) {
            const price = prices[a];
            if (!price) { unknown = true; continue; }
            const p = this.pool(a);
            collateral += amt * price;
            liq += amt * price * p.liquidationThreshold;
            ltv += amt * price * p.collateralFactor;
        }
        for (const [a, amt] of Object.entries(pos.borrow)) {
            const price = prices[a];
            if (!price) { unknown = true; continue; }
            debt += amt * price;
        }
        return {
            collateral, debt, unknown, borrowLimit: ltv,
            hf: debt > 0 ? liq / debt : Infinity, hfBorrow: debt > 0 ? ltv / debt : Infinity,
        };
    }

    async check(address, change, { requireHf = 'hfBorrow' } = {}) {
        const pos = this.position(address);
        const next = { supply: { ...pos.supply }, borrow: { ...pos.borrow } };
        for (const [side, a, delta] of change) next[side][a] = (next[side][a] || 0) + delta;
        const assets = [...Object.keys(next.supply), ...Object.keys(next.borrow)].filter((a) => (next.supply[a] || 0) > 1e-12 || (next.borrow[a] || 0) > 1e-12);
        const prices = await this.prices(assets);
        const h = this.health(next, prices);
        if (Object.values(next.borrow).some((x) => x > 1e-12) && h.unknown) throw new BankError('Нет надёжной цены одного из активов — операция отложена');
        if (h[requireHf] < 1) {
            throw new BankError(`Не хватает залога: здоровье позиции после операции ${h[requireHf].toFixed(3)} (нужно не ниже 1)`);
        }
        return h;
    }

    // ---------- операции (каждая — перевод в блокчейне, учёт меняется только после успешного перевода) ----------

    requireAccounts() {
        const s = this.settings();
        if (!isAddress(s.poolAccount)) throw new BankError('Укажите счёт пула в настройках кредитования');
        return s;
    }

    amountFor(p, v) {
        const a = amountOf(v);
        if (!isAmount(a) || Number(a) <= 0) throw new BankError('Неверная сумма');
        return Number(a);
    }

    shares(address) {
        const all = this.store.data.lendPositions;
        all[address] = all[address] || { supply: {}, borrow: {} };
        return all[address];
    }

    log(entry) {
        this.store.data.lendLog.unshift({ at: Date.now(), ...entry });
        this.store.data.lendLog.length = Math.min(this.store.data.lendLog.length, 1000);
    }

    async move(from, to, asset, amount, title, password) {
        return this.backend.transfer({ from, to, asset, amount: str(amount, this.pool(asset).scale), title: title.slice(0, 60), message: '', encrypt: false }, password);
    }

    async deposit(body, password, user) {
        const s = this.requireAccounts();
        const user1 = text(body.address, 40);
        if (!isAddress(user1)) throw new BankError('Счёт клиента');
        const p = this.accrue(this.pool(body.asset));
        if (!p.enabled) throw new BankError('Пул приостановлен');
        const amount = r8(this.amountFor(p, body.amount), p.scale);
        const tx = await this.move(user1, s.poolAccount, p.asset, amount, 'Депозит в пул', password);
        const sh = amount / p.supplyIndex;
        p.supplyShares += sh;
        const pos = this.shares(user1);
        pos.supply[p.asset] = (pos.supply[p.asset] || 0) + sh;
        this.log({ op: 'deposit', address: user1, asset: p.asset, amount, tx: tx.signature, by: user && user.login });
        this.store.save();
        return { ok: true, tx: tx.signature, position: await this.positionView(user1) };
    }

    async withdraw(body, password, user) {
        const s = this.requireAccounts();
        const user1 = text(body.address, 40);
        const p = this.accrue(this.pool(body.asset));
        const pos = this.shares(user1);
        const have = (pos.supply[p.asset] || 0) * p.supplyIndex;
        const amount = body.all ? r8(have, p.scale) : r8(this.amountFor(p, body.amount), p.scale);
        if (amount > have + 1e-9) throw new BankError(`На депозите только ${str(have, p.scale)}`);
        if (amount > this.rates(p).cash + 1e-9) throw new BankError('В пуле сейчас недостаточно свободных средств — они выданы в займы');
        await this.check(user1, [['supply', p.asset, -amount]]);
        const tx = await this.move(s.poolAccount, user1, p.asset, amount, 'Возврат депозита', password);
        const sh = Math.min(amount / p.supplyIndex, pos.supply[p.asset]);
        pos.supply[p.asset] -= sh;
        p.supplyShares -= sh;
        this.log({ op: 'withdraw', address: user1, asset: p.asset, amount, tx: tx.signature, by: user && user.login });
        this.store.save();
        return { ok: true, tx: tx.signature, position: await this.positionView(user1) };
    }

    async borrow(body, password, user) {
        const s = this.requireAccounts();
        const user1 = text(body.address, 40);
        if (!isAddress(user1)) throw new BankError('Счёт клиента');
        const p = this.accrue(this.pool(body.asset));
        if (!p.enabled) throw new BankError('Пул приостановлен');
        const amount = r8(this.amountFor(p, body.amount), p.scale);
        if (amount > this.rates(p).cash + 1e-9) throw new BankError(`В пуле свободно только ${str(this.rates(p).cash, p.scale)}`);
        const h = await this.check(user1, [['borrow', p.asset, amount]]);
        const tx = await this.move(s.poolAccount, user1, p.asset, amount, 'Займ из пула', password);
        const sh = amount / p.borrowIndex;
        p.borrowShares += sh;
        const pos = this.shares(user1);
        pos.borrow[p.asset] = (pos.borrow[p.asset] || 0) + sh;
        this.log({ op: 'borrow', address: user1, asset: p.asset, amount, tx: tx.signature, hf: h.hf, by: user && user.login });
        this.store.save();
        return { ok: true, tx: tx.signature, position: await this.positionView(user1) };
    }

    async repay(body, password, user) {
        const s = this.requireAccounts();
        const user1 = text(body.address, 40);
        const from = text(body.from, 40) || user1; // погасить может и третье лицо
        const p = this.accrue(this.pool(body.asset));
        const pos = this.shares(user1);
        const debt = (pos.borrow[p.asset] || 0) * p.borrowIndex;
        if (debt <= 0) throw new BankError('Долга в этом активе нет');
        // «весь долг» — с округлением вверх, чтобы не осталось хвоста процентов
        const amount = body.all ? Math.ceil(debt * 10 ** p.scale - 1e-6) / 10 ** p.scale : Math.min(r8(this.amountFor(p, body.amount), p.scale), Math.ceil(debt * 10 ** p.scale) / 10 ** p.scale);
        const tx = await this.move(from, s.poolAccount, p.asset, amount, 'Погашение займа', password);
        const sh = Math.min(amount / p.borrowIndex, pos.borrow[p.asset]);
        pos.borrow[p.asset] -= sh;
        p.borrowShares -= sh;
        if (pos.borrow[p.asset] * p.borrowIndex < 10 ** -p.scale) {
            p.borrowShares -= pos.borrow[p.asset];
            pos.borrow[p.asset] = 0;
        }
        this.log({ op: 'repay', address: user1, from, asset: p.asset, amount, tx: tx.signature, by: user && user.login });
        this.store.save();
        return { ok: true, tx: tx.signature, position: await this.positionView(user1) };
    }

    /**
     * Ликвидация: позиция с HF < 1. Казна гасит часть долга (debtAsset) не больше closeFactor и получает залог
     * (collateralAsset) на сумму погашения + премия. Два перевода: казна → пул (долг), пул → казна (залог).
     */
    async liquidate(body, password, user) {
        const s = this.requireAccounts();
        if (!isAddress(s.treasuryAccount)) throw new BankError('Укажите счёт казны (для ликвидаций) в настройках');
        const user1 = text(body.address, 40);
        this.accrueAll();
        const pos = this.position(user1);
        const debtAsset = Number(body.debtAsset || Object.keys(pos.borrow).sort((a, b) => pos.borrow[b] - pos.borrow[a])[0]);
        const collAsset = Number(body.collateralAsset || Object.keys(pos.supply).sort((a, b) => pos.supply[b] - pos.supply[a])[0]);
        if (!pos.borrow[debtAsset]) throw new BankError('У позиции нет долга в этом активе');
        if (!pos.supply[collAsset]) throw new BankError('У позиции нет залога в этом активе');
        const prices = await this.prices([...Object.keys(pos.supply), ...Object.keys(pos.borrow)]);
        const h = this.health(pos, prices);
        if (h.unknown) throw new BankError('Нет надёжной цены — ликвидация отложена');
        if (h.hf >= 1) throw new BankError(`Позиция здорова (HF ${h.hf.toFixed(3)}) — ликвидировать нельзя`);
        const dp = this.pool(debtAsset);
        const cp = this.pool(collAsset);
        let repay = pos.borrow[debtAsset] * dp.closeFactor;
        if (body.amount) repay = Math.min(repay, this.amountFor(dp, body.amount));
        // залог за погашение с премией; если залога не хватает — погашение уменьшается
        const seizeFor = (x) => x * prices[debtAsset] * (1 + cp.liquidationBonus) / prices[collAsset];
        if (seizeFor(repay) > pos.supply[collAsset]) repay = pos.supply[collAsset] * prices[collAsset] / (1 + cp.liquidationBonus) / prices[debtAsset];
        repay = r8(repay, dp.scale); // погашение — в точности актива долга
        const seize = r8(Math.min(seizeFor(repay), pos.supply[collAsset]), cp.scale);
        if (seize > this.rates(cp).cash + 1e-9) throw new BankError('Залог выдан в займы — в пуле нет свободных средств для ликвидации');
        const t1 = await this.move(s.treasuryAccount, s.poolAccount, debtAsset, repay, 'Ликвидация: погашение', password);
        const shares = this.shares(user1);
        const bsh = Math.min(repay / dp.borrowIndex, shares.borrow[debtAsset]);
        shares.borrow[debtAsset] -= bsh;
        dp.borrowShares -= bsh;
        this.store.save();
        let t2;
        try {
            t2 = await this.move(s.poolAccount, s.treasuryAccount, collAsset, seize, 'Ликвидация: залог', password);
        } catch (e) {
            // долг уже погашен казной — залог заберём вручную; фиксируем, чтобы не потерять
            this.log({ op: 'liquidate_pending', address: user1, debtAsset, repay, collAsset, seize, tx: t1.signature, error: e.message });
            this.store.save();
            throw new BankError('Долг погашен, но перевод залога в казну не прошёл: ' + e.message + '. Повторите ликвидацию залога вручную.');
        }
        const ssh = Math.min(seize / cp.supplyIndex, shares.supply[collAsset]);
        shares.supply[collAsset] -= ssh;
        cp.supplyShares -= ssh;
        this.log({ op: 'liquidate', address: user1, debtAsset, repay, collAsset, seize, hfBefore: h.hf, tx: [t1.signature, t2.signature], by: user && user.login });
        this.store.save();
        return { ok: true, repaid: repay, seized: seize, hfBefore: h.hf, position: await this.positionView(user1) };
    }

    // ---------- обзор и мониторинг ----------

    poolView(p) {
        const r = this.rates(p);
        return {
            ...p, utilization: r.utilization, borrowApr: r.borrowRate, supplyApr: r.supplyRate,
            supplied: str(r.supplied, p.scale), borrowed: str(r.borrowed, p.scale), cash: str(r.cash, p.scale),
        };
    }

    async positionView(address, prices = null) {
        const pos = this.position(address);
        const assets = [...Object.keys(pos.supply), ...Object.keys(pos.borrow)];
        const pr = prices || await this.prices(assets);
        const h = this.health(pos, pr);
        const s = this.settings();
        return {
            address,
            supply: Object.entries(pos.supply).map(([a, x]) => ({ asset: Number(a), amount: str(x, this.pool(a).scale) })),
            borrow: Object.entries(pos.borrow).map(([a, x]) => ({ asset: Number(a), amount: str(x, this.pool(a).scale) })),
            collateralValue: h.collateral, debtValue: h.debt, borrowLimit: h.borrowLimit,
            hf: Number.isFinite(h.hf) ? h.hf : null, priceUnknown: h.unknown,
            state: h.unknown ? 'unknown' : h.hf < 1 ? 'liquidatable' : h.hf < s.warnHf ? 'risk' : 'ok',
        };
    }

    async overview() {
        this.accrueAll();
        const pools = this.store.data.lendPools;
        const prices = await this.prices(pools.map((p) => p.asset));
        const positions = [];
        for (const address of Object.keys(this.store.data.lendPositions)) {
            const v = await this.positionView(address, prices);
            if (v.supply.length || v.borrow.length) positions.push(v);
        }
        positions.sort((a, b) => (a.hf ?? 1e9) - (b.hf ?? 1e9));
        this.store.save();
        return { settings: this.settings(), prices, pools: pools.map((p) => this.poolView(p)), positions, log: this.store.data.lendLog.slice(0, 50) };
    }

    /** Фоновая проверка: начисление процентов, позиции под угрозой, по желанию — автоликвидация. */
    async tick(password) {
        const o = await this.overview();
        const bad = o.positions.filter((p) => p.state === 'liquidatable');
        const done = [];
        if (this.settings().autoLiquidate && this.settings().treasuryAccount) {
            for (const p of bad) {
                try {
                    done.push(await this.liquidate({ address: p.address }, password, { login: 'auto' }));
                } catch (e) {
                    this.log({ op: 'liquidate_failed', address: p.address, error: e.message });
                }
            }
            this.store.save();
        }
        return { atRisk: o.positions.filter((p) => p.state === 'risk').length, liquidatable: bad.length, liquidated: done.length };
    }
}

module.exports = { Lending, POOL_DEFAULTS };
