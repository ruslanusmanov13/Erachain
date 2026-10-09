'use strict';

const { BankError } = require('./validate');

/**
 * Бэкенд, работающий через RPC API ноды Erachain (по умолчанию http://127.0.0.1:9048).
 * Используемые методы ноды:
 *   GET  wallet                                   — состояние кошелька
 *   GET  blocks/height                            — высота цепочки
 *   GET  addresses?password=                      — счета кошелька
 *   GET  addresses/assets/{address}               — балансы по активам
 *   GET  addresses/new?password=                  — открыть новый счёт
 *   GET  assets/{key}                             — сведения об активе
 *   GET  transactions/address/{address}/limit/{n} — история счёта
 *   GET  r_send/{creator}/{recipient}?...         — перевод актива
 */
class NodeBackend {
    constructor(rpcUrl, { timeoutMs = 15000 } = {}) {
        this.rpcUrl = rpcUrl.replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
        this.assetCache = new Map();
    }

    async call(path, query = {}) {
        const url = new URL(this.rpcUrl + '/' + path);
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
        }
        let res;
        try {
            res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (e) {
            throw new BankError('Нода Erachain недоступна: ' + this.rpcUrl, 502);
        }
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            // Некоторые методы (blocks/height, addresses/new) возвращают простой текст
            data = text.trim();
        }
        if (data && typeof data === 'object' && !Array.isArray(data) && 'error' in data) {
            const msg = data.error_message || data.message || data.error;
            throw new BankError('Ошибка ноды: ' + msg);
        }
        if (!res.ok) throw new BankError('Ошибка ноды: HTTP ' + res.status, 502);
        return data;
    }

    async status() {
        const [wallet, height] = await Promise.all([this.call('wallet'), this.call('blocks/height')]);
        return {
            mode: 'node',
            node: this.rpcUrl,
            height: Number(height),
            walletExists: !!wallet.exists,
            walletUnlocked: !!wallet.isunlocked,
        };
    }

    async login(password) {
        const addresses = await this.call('addresses', { password });
        if (!Array.isArray(addresses)) throw new BankError('Не удалось открыть кошелёк', 401);
        return true;
    }

    async asset(key) {
        if (this.assetCache.has(key)) return this.assetCache.get(key);
        let info = { key, name: 'Актив #' + key, scale: 8 };
        try {
            const a = await this.call('assets/' + key);
            info = { key, name: a.name || info.name, scale: a.scale ?? 8 };
        } catch (e) {
            // оставляем имя по умолчанию
        }
        this.assetCache.set(key, info);
        return info;
    }

    async balances(address) {
        const raw = await this.call('addresses/assets/' + address);
        const out = [];
        for (const [key, tuple] of Object.entries(raw || {})) {
            // tuple[0] — "собственность" [приход, остаток]
            const own = Array.isArray(tuple) && Array.isArray(tuple[0]) ? tuple[0][1] : '0';
            const asset = await this.asset(Number(key));
            out.push({ asset: asset.key, name: asset.name, amount: own });
        }
        out.sort((a, b) => a.asset - b.asset);
        return out;
    }

    async accounts(password) {
        const addresses = await this.call('addresses', { password });
        return Promise.all(addresses.map(async (address) => ({
            address,
            balances: await this.balances(address),
        })));
    }

    async openAccount(password) {
        const address = await this.call('addresses/new', { password });
        return { address: String(address) };
    }

    async history(address, limit = 50) {
        const list = await this.call(`transactions/address/${address}/limit/${limit}`);
        return (Array.isArray(list) ? list : []).map((tx) => normalizeTx(tx, address));
    }

    async transfer(t, password) {
        const tx = await this.call(`r_send/${t.from}/${t.to}`, {
            assetKey: t.asset,
            amount: t.amount,
            title: t.title,
            message: t.message,
            feePow: 0,
            encoding: 0,
            password,
        });
        return normalizeTx(tx, t.from);
    }
}

function normalizeTx(tx, owner) {
    const incoming = tx.recipient === owner && tx.creator !== owner;
    return {
        signature: tx.signature,
        type: tx.type_name || tx.record_type || String(tx.type),
        timestamp: typeof tx.timestamp === 'number' ? tx.timestamp : null,
        from: tx.creator,
        to: tx.recipient || null,
        asset: tx.assetKey ?? tx.asset ?? null,
        assetName: tx.asset_name || null,
        amount: tx.amount || null,
        direction: incoming ? 'in' : 'out',
        title: tx.title || '',
        message: tx.message || '',
        fee: tx.fee || '0',
        confirmations: tx.confirmations ?? 0,
    };
}

module.exports = { NodeBackend, normalizeTx };
