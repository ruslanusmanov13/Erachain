'use strict';

const { BankError } = require('./validate');

/**
 * Бэкенд, работающий через RPC API ноды Erachain (по умолчанию http://127.0.0.1:9048).
 * Ключи хранятся в кошельке ноды; каждый подписывающий вызов передаёт пароль кошелька
 * (нода разблокирует кошелёк только на время вызова).
 */
class NodeBackend {
    constructor(rpcUrl, { timeoutMs = 20000 } = {}) {
        this.rpcUrl = rpcUrl.replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
        this.assetCache = new Map();
    }

    async call(path, { query = {}, body } = {}) {
        const url = new URL(this.rpcUrl + '/' + path);
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
        }
        let res;
        try {
            res = await fetch(url, {
                method: body === undefined ? 'GET' : 'POST',
                headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (e) {
            throw new BankError('Нода Erachain недоступна: ' + this.rpcUrl, 502);
        }
        const raw = await res.text();
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            // Некоторые методы (blocks/height, addresses/new) возвращают простой текст
            data = raw.trim();
            if (!res.ok || data.startsWith('<')) throw new BankError('Ошибка ноды: HTTP ' + res.status, 502);
        }
        if (data && typeof data === 'object' && !Array.isArray(data) && 'error' in data) {
            const msg = data.error_message || data.message || data.error;
            throw new BankError('Нода: ' + msg + (data.value ? ` (${data.value})` : ''));
        }
        if (!res.ok) throw new BankError('Ошибка ноды: HTTP ' + res.status, 502);
        return data;
    }

    // ---------- Сеть ----------

    async status() {
        const [height, version] = await Promise.all([
            this.call('blocks/height'),
            this.call('core/version').catch(() => ({})),
        ]);
        return { mode: 'node', node: this.rpcUrl, height: Number(height), version: version.version || '' };
    }

    async network() {
        const [height, version, status, peers, last] = await Promise.all([
            this.call('blocks/height'),
            this.call('core/version').catch(() => ({})),
            this.call('core/status').catch(() => null),
            this.call('peers').catch(() => []),
            this.call('blocks/last').catch(() => null),
        ]);
        const states = { 0: 'нет соединений', 1: 'синхронизация', 2: 'синхронизирована' };
        return {
            mode: 'node',
            node: this.rpcUrl,
            height: Number(height),
            version: version.version || '',
            buildDate: version.buildDate || '',
            state: states[status] || String(status ?? '—'),
            peers: Array.isArray(peers) ? peers.length : 0,
            lastBlock: last ? {
                height: last.height,
                creator: last.creator,
                timestamp: last.timestamp,
                transactions: last.transactionsCount ?? (last.transactions || []).length,
                signature: last.signature,
            } : null,
        };
    }

    // ---------- Кошелёк и счета ----------

    async login(password) {
        const addresses = await this.call('addresses', { query: { password } });
        if (!Array.isArray(addresses)) throw new BankError('Не удалось открыть кошелёк', 401);
        return true;
    }

    async assetInfo(key) {
        if (this.assetCache.has(key)) return this.assetCache.get(key);
        let info = { key, name: 'Актив #' + key, scale: 8 };
        try {
            const a = await this.call('assets/' + key);
            info = { key, name: a.name || info.name, scale: a.scale ?? 8 };
            this.assetCache.set(key, info);
        } catch (e) {
            // не кешируем ошибку — актив может появиться позже
        }
        return info;
    }

    async balances(address) {
        const raw = await this.call('addresses/assets/' + address);
        const out = [];
        for (const [key, t] of Object.entries(raw || {})) {
            // позиции баланса: [собственность, долг, хранение, расход, залог], каждая — [оборот, остаток]
            const pos = (i) => (Array.isArray(t) && Array.isArray(t[i]) ? t[i][1] : '0');
            const asset = await this.assetInfo(Number(key));
            out.push({ asset: asset.key, name: asset.name, amount: pos(0), debt: pos(1), hold: pos(2), spend: pos(3) });
        }
        out.sort((a, b) => a.asset - b.asset);
        return out;
    }

    async accounts(password) {
        const addresses = await this.call('addresses', { query: { password } });
        return Promise.all(addresses.map(async (address) => ({ address, balances: await this.balances(address) })));
    }

    async openAccount(password) {
        const address = await this.call('addresses/new', { query: { password } });
        return { address: String(address) };
    }

    async history(address, limit = 50) {
        const [confirmed, pending] = await Promise.all([
            this.call('transactions/find', { query: { address, desc: true, noforge: true, limit } }),
            this.call('transactions/unconfirmedof/' + address).catch(() => []),
        ]);
        const all = [...(Array.isArray(pending) ? pending : []), ...(Array.isArray(confirmed) ? confirmed : [])];
        return all.slice(0, limit).map((tx) => normalizeTx(tx, address));
    }

    async transfer(t, password) {
        const tx = await this.call(`r_send/${t.from}/${t.to}`, {
            query: {
                assetKey: t.asset, amount: t.amount, title: t.title, message: t.message,
                encrypt: t.encrypt || undefined, feePow: 0, encoding: 0, password,
            },
        });
        return normalizeTx(tx, t.from);
    }

    async multiTransfer(m, password) {
        // выплаты отправляются последовательно: результат по каждой строке
        const results = [];
        for (const p of m.payments) {
            try {
                const tx = await this.transfer({ from: m.from, to: p.to, asset: m.asset, amount: p.amount, title: p.title, message: '' }, password);
                results.push({ to: p.to, amount: p.amount, ok: true, signature: tx.signature });
            } catch (e) {
                results.push({ to: p.to, amount: p.amount, ok: false, error: e.message });
            }
        }
        return { total: results.length, sent: results.filter((r) => r.ok).length, results };
    }

    // ---------- Активы ----------

    async assetTypes() {
        const list = await this.call('assets/types');
        return (Array.isArray(list) ? list : []).map((t) => ({ key: t.key, name: t.name_full || t.name, desc: t.desc || '' }));
    }

    async listItems(kind, from) {
        const page = await this.call(`${kind}/listfrom/${from || 0}`, { query: { page: 25, desc: true } });
        let items = (page.pageItems || []).map((i) => ({ key: i.key, name: i.name, maker: i.maker || '' }));
        if (from) items = items.filter((i) => i.key !== Number(from));
        return { items, next: items.length ? items[items.length - 1].key : null, total: page.listSize ?? null };
    }

    async assets(from) {
        return this.listItems('assets', from);
    }

    async asset(key) {
        const a = await this.call('assets/' + key);
        return {
            key: a.key, name: a.name, description: stripHtml(a.description), maker: a.maker,
            type: a.type_name_full || a.type_name, scale: a.scale, quantity: a.quantity,
            released: a.released, unlimited: !!a.isUnlimited, unique: !!a.isUnique,
            seqNo: a.tx_seqNo || null, timestamp: a.tx_timestamp || null,
        };
    }

    async issueAsset(a, password) {
        const tx = await this.call('assets/issue', {
            body: { creator: a.creator, name: a.name, description: a.description, scale: a.scale, assetType: a.assetType, quantity: a.quantity, feePow: 0, password },
        });
        return txBrief(tx);
    }

    // ---------- Голосования ----------

    async polls(from) {
        return this.listItems('polls', from);
    }

    async poll(key, asset = 1) {
        const p = await this.call('polls/' + key, { query: { asset } });
        return {
            key: p.key, name: p.name, description: stripHtml(p.description), maker: p.maker,
            options: (p.options || []).map((name, i) => {
                const r = (p.results || [])[i] || {};
                return { option: i, name, persons: r.persons ?? null, votes: r.votes ?? null };
            }),
            personsTotal: p.personsTotal ?? null,
            votesTotal: p.votesTotal ?? p.totalVotes ?? '0',
            resultsAsset: p.resultsAsset ?? asset,
        };
    }

    async createPoll(p, password) {
        const tx = await this.call('polls/issue', {
            body: { creator: p.creator, name: p.name, description: p.description, options: p.options, feePow: 0, password },
        });
        return txBrief(tx);
    }

    async vote(v, password) {
        const tx = await this.call(`polls/vote/${v.poll}/${v.option}/${v.voter}`, { query: { feePow: 0, password } });
        return txBrief(tx);
    }

    // ---------- Биржа ----------

    async orderBook(have, want) {
        const book = await this.call(`trade/ordersbook/${have}/${want}`, { query: { limit: 30 } });
        // pairAmount — сколько актива have, pairPrice — цена в want, pairTotal — сумма в want
        const side = (list) => (list || []).map((o) => ({
            seqNo: o.seqNo || null,
            amount: o.pairAmount ?? o.leftHave ?? null,
            price: o.pairPrice ?? o.price ?? null,
            total: o.pairTotal ?? o.leftWant ?? null,
            creator: o.creator || null,
        }));
        return { have: Number(have), want: Number(want), sell: side(book.have), buy: side(book.want) };
    }

    async trades(have, want) {
        const list = await this.call(`trade/trades/${have}/${want}`, { query: { limit: 30 } });
        return (Array.isArray(list) ? list : []).map((t) => ({
            timestamp: t.timestamp ?? null,
            side: t.type === 'sell' ? 'sell' : 'buy',
            amount: t.amountHave != null ? String(t.amountHave) : null,
            price: t.price != null ? String(t.price) : null,
            total: t.amountWant != null ? String(t.amountWant) : null,
        }));
    }

    async myOrders(address) {
        const list = await this.call(`trade/allordersbyaddress/${address}`, { query: { limit: 50, desc: true } });
        return (Array.isArray(list) ? list : []).map((o) => ({
            seqNo: o.seqNo || null,
            have: o.haveAssetKey ?? null,
            want: o.wantAssetKey ?? null,
            amount: o.amountHave ?? null,
            left: o.leftHave ?? null,
            wantAmount: o.amountWant ?? null,
            price: o.price ?? null,
            ...orderStatus(o.statusName),
        }));
    }

    async createOrder(o, password) {
        const tx = await this.call(`trade/create/${o.creator}/${o.have}/${o.want}/${o.haveAmount}/${o.wantAmount}`, { query: { feePow: 0, password } });
        return txBrief(tx);
    }

    async cancelOrder(c, password) {
        const tx = await this.call(`trade/cancel/${c.creator}/${c.order}`, { query: { password } });
        return txBrief(tx);
    }

    // ---------- Сообщения (телеграммы) ----------

    async messages(address) {
        const list = await this.call('telegrams/address/' + address);
        return (Array.isArray(list) ? list : []).map((item) => {
            const tx = item.transaction || item;
            return {
                signature: tx.signature,
                timestamp: tx.timestamp ?? null,
                from: tx.creator,
                to: tx.recipient,
                title: tx.title || '',
                message: tx.isText === false || tx.encrypted ? '' : (tx.message || ''),
                encrypted: !!tx.encrypted,
                direction: tx.recipient === address ? 'in' : 'out',
            };
        }).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    async sendMessage(m, password) {
        const res = await this.call(`telegrams/send/${m.from}/${m.to}`, {
            query: { title: m.title, message: m.message, encrypt: m.encrypt || undefined, encoding: 0, feePow: 0, password },
        });
        return { signature: res.signature, status: res.status || 'ok' };
    }

    // ---------- Документы ----------

    async signDocument(d, password) {
        const body = { creator: d.creator, title: d.title, message: d.message || undefined, test: false, feePow: 0, password };
        if (Object.keys(d.hashes).length) body.hashes = d.hashes;
        if (d.recipients.length) body.recipients = { list: d.recipients };
        const tx = await this.call('r_note/make', { body });
        return txBrief(tx);
    }

    async verifyDocument(hash) {
        const res = await this.call('transactions/search', { query: { q: hash, limit: 20 } });
        const list = Array.isArray(res) && Array.isArray(res[2]) ? res[2] : [];
        return list.map((tx) => ({
            signature: tx.signature, seqNo: tx.seqNo || null, timestamp: tx.timestamp ?? null,
            creator: tx.creator, title: tx.title || '', type: tx.type_name || '',
        }));
    }

    // ---------- Персоны и справочники ----------

    async persons(from) {
        return this.listItems('persons', from);
    }

    async person(key) {
        const p = await this.call('persons/' + key);
        return {
            key: p.key, name: p.name, description: stripHtml(p.description), maker: p.maker,
            birthday: p.birthday ?? null, gender: p.gender ?? null, height: p.height ?? null,
            seqNo: p.tx_seqNo || null,
        };
    }

    async issuePerson(p, password) {
        const tx = await this.call('persons/issue', {
            body: {
                creator: p.creator, name: p.name, description: p.description, birthday: p.birthday,
                gender: p.gender, height: p.height, birthLatitude: 0, birthLongitude: 0,
                race: '', skinColor: '', eyeColor: '', hairСolor: '',
                owner: p.owner || undefined, image64: p.image64, feePow: 0, password,
            },
        });
        return txBrief(tx);
    }

    async certifyPerson(c, password) {
        const tx = await this.call(`persons/certify/${c.creator}/${c.person}/${c.pubkey}`, { query: { days: c.days, feePow: 0, password } });
        return txBrief(tx);
    }

    async catalog(kind, from) {
        return this.listItems(kind, from);
    }
}

const ORDER_STATUS = {
    open: ['открыт', true], fulfilled: ['частично исполнен', true], unconfirmed: ['ожидает подтверждения', true],
    completed: ['исполнен', false], canceled: ['отменён', false], orphaned: ['отклонён', false],
};

function orderStatus(name) {
    const key = String(name || '').split(/[\s#]/)[0].toLowerCase();
    const [status, active] = ORDER_STATUS[key] || [String(name || '—'), false];
    return { status, active };
}

function stripHtml(s) {
    return typeof s === 'string' ? s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() : '';
}

function txBrief(tx) {
    if (!tx || typeof tx !== 'object') return { ok: true };
    return { ok: true, signature: tx.signature || null, seqNo: tx.seqNo || null, type: tx.type_name || '', fee: tx.fee || null };
}

function normalizeTx(tx, owner) {
    const incoming = tx.recipient === owner && tx.creator !== owner;
    return {
        signature: tx.signature,
        seqNo: tx.seqNo || null,
        type: tx.type_name || tx.record_type || String(tx.type),
        timestamp: typeof tx.timestamp === 'number' ? tx.timestamp : null,
        from: tx.creator,
        to: tx.recipient || null,
        asset: tx.assetKey ?? tx.asset ?? null,
        assetName: tx.asset_name || null,
        amount: tx.amount || null,
        direction: incoming ? 'in' : 'out',
        title: tx.title || '',
        message: tx.isText === false || tx.encrypted ? '' : (tx.message || ''),
        fee: tx.fee || '0',
        confirmations: tx.confirmations ?? 0,
    };
}

module.exports = { NodeBackend, normalizeTx, stripHtml };
