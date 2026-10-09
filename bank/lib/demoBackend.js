'use strict';

const crypto = require('crypto');
const { BankError } = require('./validate');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ASSETS = { 1: 'ERA', 2: 'COMPU' };
const FEE = '0.00010000'; // условная комиссия в COMPU
const SCALE = 100000000n;

function randomAddress() {
    let s = '7';
    const bytes = crypto.randomBytes(33);
    for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
    return s;
}

function toUnits(amount) {
    const [int, frac = ''] = String(amount).split('.');
    return BigInt(int) * SCALE + BigInt((frac + '00000000').slice(0, 8));
}

function fromUnits(units) {
    const neg = units < 0n;
    const abs = neg ? -units : units;
    return (neg ? '-' : '') + (abs / SCALE).toString() + '.' + (abs % SCALE).toString().padStart(8, '0');
}

/**
 * Демо-бэкенд: имитирует кошелёк ноды в памяти, чтобы приложение можно было
 * опробовать без запущенной ноды Erachain.
 */
class DemoBackend {
    constructor({ password = 'demo12345' } = {}) {
        this.password = password;
        this.height = 1500000;
        this.accountsMap = new Map(); // address -> Map(assetKey -> units)
        this.txs = [];
        const a = this.addAccount({ 1: '1250.5', 2: '10' });
        const b = this.addAccount({ 1: '300', 2: '2.5' });
        this.record(randomAddress(), a, 1, '1250.5', 'Начальное зачисление').height -= 100;
        this.record(randomAddress(), b, 1, '300', 'Начальное зачисление').height -= 100;
        this.timer = setInterval(() => { this.height += 1; }, 30000);
        this.timer.unref();
    }

    addAccount(balances = {}) {
        const address = randomAddress();
        const map = new Map();
        for (const [k, v] of Object.entries(balances)) map.set(Number(k), toUnits(v));
        this.accountsMap.set(address, map);
        return address;
    }

    record(from, to, asset, amount, title, message = '') {
        const tx = {
            signature: crypto.randomBytes(32).toString('base64url'),
            type: 'Send',
            timestamp: Date.now(),
            from, to, asset,
            assetName: ASSETS[asset] || 'Актив #' + asset,
            amount: fromUnits(toUnits(amount)),
            title, message,
            fee: FEE,
            height: this.height + 1, // попадёт в следующий блок
        };
        this.txs.unshift(tx);
        return tx;
    }

    check(password) {
        if (password !== this.password) throw new BankError('Неверный пароль кошелька', 401);
    }

    async status() {
        return { mode: 'demo', node: 'demo', height: this.height, walletExists: true, walletUnlocked: false };
    }

    async login(password) {
        this.check(password);
        return true;
    }

    async accounts(password) {
        this.check(password);
        return [...this.accountsMap.entries()].map(([address, map]) => ({
            address,
            balances: [...map.entries()].sort((x, y) => x[0] - y[0]).map(([asset, units]) => ({
                asset, name: ASSETS[asset] || 'Актив #' + asset, amount: fromUnits(units),
            })),
        }));
    }

    async openAccount(password) {
        this.check(password);
        return { address: this.addAccount({ 1: '0', 2: '0' }) };
    }

    async history(address, limit = 50) {
        if (!this.accountsMap.has(address)) throw new BankError('Счёт не найден в кошельке', 404);
        return this.txs
            .filter((t) => t.from === address || t.to === address)
            .slice(0, limit)
            .map((t) => ({
                ...t,
                direction: t.to === address ? 'in' : 'out',
                confirmations: Math.max(0, this.height - t.height + 1),
            }));
    }

    async transfer(t, password) {
        this.check(password);
        const from = this.accountsMap.get(t.from);
        if (!from) throw new BankError('Счёт отправителя не найден в кошельке', 404);
        const amount = toUnits(t.amount);
        const fee = toUnits(FEE);
        const balance = from.get(t.asset) || 0n;
        const compu = from.get(2) || 0n;
        if (balance < amount + (t.asset === 2 ? fee : 0n)) throw new BankError('Недостаточно средств');
        if (compu < fee) throw new BankError('Недостаточно COMPU для оплаты комиссии');
        from.set(t.asset, balance - amount);
        from.set(2, (from.get(2) || 0n) - fee);
        const to = this.accountsMap.get(t.to);
        if (to) to.set(t.asset, (to.get(t.asset) || 0n) + amount);
        const tx = this.record(t.from, t.to, t.asset, t.amount, t.title, t.message);
        return { ...tx, direction: 'out', confirmations: 0 };
    }
}

module.exports = { DemoBackend, toUnits, fromUnits };
