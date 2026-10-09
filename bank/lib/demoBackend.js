'use strict';

const crypto = require('crypto');
const { BankError } = require('./validate');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const FEE = '0.00010000'; // условная комиссия сети в COMPU
const SCALE = 100000000n;

function base58(bytes) {
    let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
    let s = '';
    while (n > 0n) {
        s = ALPHABET[Number(n % 58n)] + s;
        n /= 58n;
    }
    return s;
}

function randomAddress() {
    let s = '7';
    for (const b of crypto.randomBytes(33)) s += ALPHABET[b % ALPHABET.length];
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
 * Демо-бэкенд: имитирует ноду Erachain и её кошелёк в памяти, чтобы приложение можно было
 * опробовать без запущенной ноды. Правила упрощены (комиссия фиксирована, блок раз в 30 с).
 */
class DemoBackend {
    constructor({ password = 'demo12345', blockMs = 30000 } = {}) {
        this.password = password;
        this.height = 1500000;
        this.accountsMap = new Map(); // address -> Map(assetKey -> units)
        this.txs = [];
        this.seq = 0;
        this.assetsMap = new Map();
        this.pollsMap = new Map();
        this.personsMap = new Map();
        this.orders = [];
        this.tradesList = [];
        this.telegrams = [];
        this.documents = [];

        this.addAsset({ key: 1, name: 'ERA', description: 'Единица учёта Erachain, дающая право на операции в сети', scale: 8, quantity: 0, maker: 'genesis' });
        this.addAsset({ key: 2, name: 'COMPU', description: 'Вычислительная единица для оплаты комиссий сети', scale: 8, quantity: 0, maker: 'genesis' });
        this.addAsset({ key: 1048, name: 'Цифровой рубль (токен)', description: 'Токен, обеспеченный рублями на счёте оператора шлюза', scale: 2, quantity: 0, maker: 'gateway' });

        const a = this.addAccount({ 1: '1250.5', 2: '10', 1048: '15000' });
        const b = this.addAccount({ 1: '300', 2: '2.5' });
        this.mainAccount = a;
        // счёт шлюза: хранит выпуск токена «цифровой рубль»
        this.gatewayAccount = this.addAccount({ 2: '50', 1048: '1000000' });
        const client = randomAddress();
        this.record('transfer', { from: randomAddress(), to: a, asset: 1, amount: '1250.5', title: 'Начальное зачисление' }).height -= 100;
        this.record('transfer', { from: randomAddress(), to: b, asset: 1, amount: '300', title: 'Начальное зачисление' }).height -= 100;

        this.record('transfer', {
            from: client, to: this.gatewayAccount, asset: 1048, amount: '2500', title: 'Вывод на карту',
            message: 'ВЫВОД;Петров Пётр Петрович;500100732259;40817810099910004312;044525225',
        }).height -= 10;
        this.personsMap.set(1, { key: 1, name: 'Иванов Иван Иванович', description: 'Генеральный директор', maker: a, birthday: Date.parse('1980-05-12'), gender: 0, height: 180, accounts: [a] });
        this.pollsMap.set(1, {
            key: 1, name: 'Утверждение бюджета на 2027 год', description: 'Голосование держателей ERA', maker: a,
            options: ['За', 'Против', 'Воздержался'], votes: new Map(),
        });
        const external = randomAddress();
        this.orders.push(this.makeOrder(external, 1, 2, '100', '5'));
        this.orders.push(this.makeOrder(external, 2, 1, '3', '62'));

        this.timer = setInterval(() => { this.height += 1; }, blockMs);
        if (this.timer.unref) this.timer.unref(); // в браузере (демо-страница) unref нет
    }

    // ---------- служебное ----------

    addAsset(a) {
        this.assetsMap.set(a.key, { type: 'Цифровой актив', unlimited: !a.quantity, released: '0', ...a, timestamp: Date.now() });
    }

    addAccount(balances = {}) {
        const address = randomAddress();
        const map = new Map();
        for (const [k, v] of Object.entries(balances)) map.set(Number(k), toUnits(v));
        this.accountsMap.set(address, map);
        return address;
    }

    nextSeqNo() {
        this.seq += 1;
        return `${this.height + 1}-${this.seq}`;
    }

    record(kind, fields) {
        const tx = {
            kind,
            signature: base58(crypto.randomBytes(64)),
            seqNo: this.nextSeqNo(),
            timestamp: Date.now(),
            height: this.height + 1, // попадёт в следующий блок
            fee: FEE,
            title: '',
            message: '',
            ...fields,
        };
        this.txs.unshift(tx);
        return tx;
    }

    check(password) {
        if (password !== this.password) throw new BankError('Неверный пароль кошелька', 401);
    }

    own(address) {
        const acc = this.accountsMap.get(address);
        if (!acc) throw new BankError('Счёт не найден в кошельке', 404);
        return acc;
    }

    payFee(address) {
        const acc = this.own(address);
        const fee = toUnits(FEE);
        if ((acc.get(2) || 0n) < fee) throw new BankError('Недостаточно COMPU для оплаты комиссии');
        acc.set(2, acc.get(2) - fee);
    }

    move(from, to, asset, amount) {
        const src = this.own(from);
        const units = toUnits(amount);
        const fee = toUnits(FEE);
        if ((src.get(asset) || 0n) < units + (asset === 2 ? fee : 0n)) throw new BankError('Недостаточно средств');
        this.payFee(from);
        src.set(asset, src.get(asset) - units);
        const dst = this.accountsMap.get(to);
        if (dst) dst.set(asset, (dst.get(asset) || 0n) + units);
    }

    confirmations(tx) {
        return Math.max(0, this.height - tx.height + 1);
    }

    brief(tx) {
        return { ok: true, signature: tx.signature, seqNo: tx.seqNo, type: tx.kind, fee: FEE };
    }

    assetName(key) {
        return (this.assetsMap.get(key) || {}).name || 'Актив #' + key;
    }

    listOf(map, from) {
        let items = [...map.values()].sort((x, y) => y.key - x.key);
        if (from) items = items.filter((i) => i.key < Number(from));
        items = items.slice(0, 25).map((i) => ({ key: i.key, name: i.name, maker: i.maker }));
        return { items, next: items.length === 25 ? items[24].key : null, total: map.size };
    }

    // ---------- Сеть ----------

    async status() {
        return { mode: 'demo', node: 'demo', height: this.height, version: 'demo' };
    }

    async network() {
        return {
            mode: 'demo', node: 'demo', height: this.height, version: 'demo', buildDate: '',
            state: 'синхронизирована', peers: 12,
            lastBlock: { height: this.height, creator: this.mainAccount, timestamp: Date.now(), transactions: this.txs.filter((t) => t.height === this.height).length, signature: base58(crypto.randomBytes(64)) },
        };
    }

    // ---------- Кошелёк и счета ----------

    async login(password) {
        this.check(password);
        return true;
    }

    async accounts(password) {
        this.check(password);
        return [...this.accountsMap.entries()].map(([address, map]) => ({
            address,
            balances: [...map.entries()].sort((x, y) => x[0] - y[0]).map(([asset, units]) => ({
                asset, name: this.assetName(asset), amount: fromUnits(units), debt: '0', hold: '0', spend: '0',
            })),
        }));
    }

    async openAccount(password) {
        this.check(password);
        return { address: this.addAccount({ 1: '0', 2: '0' }) };
    }

    async history(address, limit = 50) {
        this.own(address);
        return this.txs
            .filter((t) => t.from === address || t.to === address)
            .slice(0, limit)
            .map((t) => ({
                signature: t.signature, seqNo: t.seqNo, type: t.typeName || t.kind, timestamp: t.timestamp,
                from: t.from, to: t.to || null, asset: t.asset ?? null,
                assetName: t.asset ? this.assetName(t.asset) : null, amount: t.amount ? fromUnits(toUnits(t.amount)) : null,
                direction: t.to === address && t.from !== address ? 'in' : 'out',
                title: t.title, message: t.message, fee: t.fee, confirmations: this.confirmations(t),
            }));
    }

    async transfer(t, password) {
        this.check(password);
        if (!this.assetsMap.has(t.asset)) throw new BankError('Актив не существует');
        this.move(t.from, t.to, t.asset, t.amount);
        const tx = this.record('transfer', { typeName: 'Перевод', from: t.from, to: t.to, asset: t.asset, amount: t.amount, title: t.title, message: t.message });
        return (await this.history(t.from, 50)).find((x) => x.signature === tx.signature);
    }

    async multiTransfer(m, password) {
        this.check(password);
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
        return [
            { key: 0, name: 'Движимые вещи и товары', desc: '' },
            { key: 1, name: 'Цифровой актив', desc: 'Внутренний актив, не требует внешних действий при передаче' },
            { key: 2, name: 'Недвижимость', desc: '' },
            { key: 4, name: 'Долговые обязательства', desc: '' },
            { key: 11, name: 'Акции', desc: '' },
        ];
    }

    async assets(from) {
        return this.listOf(this.assetsMap, from);
    }

    async asset(key) {
        const a = this.assetsMap.get(Number(key));
        if (!a) throw new BankError('Актив не найден', 404);
        return { key: a.key, name: a.name, description: a.description, maker: a.maker, type: a.type, scale: a.scale, quantity: a.quantity, released: a.released, unlimited: a.unlimited, unique: false, seqNo: a.seqNo || null, timestamp: a.timestamp };
    }

    async issueAsset(a, password) {
        this.check(password);
        this.payFee(a.creator);
        const key = Math.max(...this.assetsMap.keys()) + 1;
        const tx = this.record('issue_asset', { typeName: 'Выпуск актива', from: a.creator, title: a.name });
        const types = await this.assetTypes();
        this.addAsset({ key, name: a.name, description: a.description, scale: a.scale, quantity: a.quantity, maker: a.creator, seqNo: tx.seqNo, type: (types.find((t) => t.key === a.assetType) || {}).name || 'Актив' });
        // выпущенное количество зачисляется создателю
        if (a.quantity > 0) {
            const acc = this.own(a.creator);
            acc.set(key, toUnits(String(a.quantity)));
            this.assetsMap.get(key).released = String(a.quantity);
        }
        return { ...this.brief(tx), key };
    }

    // ---------- Голосования ----------

    async polls(from) {
        return this.listOf(this.pollsMap, from);
    }

    async poll(key, asset = 1) {
        const p = this.pollsMap.get(Number(key));
        if (!p) throw new BankError('Голосование не найдено', 404);
        const persons = new Array(p.options.length).fill(0);
        const votes = new Array(p.options.length).fill(0n);
        let total = 0n;
        for (const [voter, option] of p.votes) {
            const bal = (this.accountsMap.get(voter) || new Map()).get(Number(asset)) || 0n;
            votes[option] += bal;
            total += bal;
            if ([...this.personsMap.values()].some((pr) => pr.accounts.includes(voter))) persons[option] += 1;
        }
        return {
            key: p.key, name: p.name, description: p.description, maker: p.maker,
            options: p.options.map((name, i) => ({ option: i, name, persons: persons[i], votes: fromUnits(votes[i]) })),
            personsTotal: persons.reduce((s, x) => s + x, 0), votesTotal: fromUnits(total), resultsAsset: Number(asset),
            voters: p.votes.size,
        };
    }

    async createPoll(p, password) {
        this.check(password);
        this.payFee(p.creator);
        const key = Math.max(0, ...this.pollsMap.keys()) + 1;
        const tx = this.record('issue_poll', { typeName: 'Создание голосования', from: p.creator, title: p.name });
        this.pollsMap.set(key, { key, name: p.name, description: p.description, maker: p.creator, options: p.options, votes: new Map() });
        return { ...this.brief(tx), key };
    }

    async vote(v, password) {
        this.check(password);
        const p = this.pollsMap.get(v.poll);
        if (!p) throw new BankError('Голосование не найдено', 404);
        if (v.option >= p.options.length) throw new BankError('Такого варианта нет');
        this.payFee(v.voter);
        p.votes.set(v.voter, v.option);
        const tx = this.record('vote', { typeName: 'Голос', from: v.voter, title: `${p.name}: ${p.options[v.option]}` });
        return this.brief(tx);
    }

    // ---------- Биржа ----------

    makeOrder(creator, have, want, haveAmount, wantAmount) {
        return {
            seqNo: this.nextSeqNo(), creator, have, want,
            amount: toUnits(haveAmount), left: toUnits(haveAmount), wantAmount: toUnits(wantAmount),
            status: 'открыт', active: true, timestamp: Date.now(),
        };
    }

    price(o) {
        return Number(o.wantAmount) / Number(o.amount);
    }

    async orderBook(have, want) {
        have = Number(have);
        want = Number(want);
        const view = (o, reverse) => {
            const leftWant = o.left * o.wantAmount / o.amount;
            return reverse
                ? { seqNo: o.seqNo, amount: fromUnits(leftWant), price: (Number(o.amount) / Number(o.wantAmount)).toFixed(8), total: fromUnits(o.left), creator: o.creator }
                : { seqNo: o.seqNo, amount: fromUnits(o.left), price: this.price(o).toFixed(8), total: fromUnits(leftWant), creator: o.creator };
        };
        const active = this.orders.filter((o) => o.active);
        return {
            have, want,
            sell: active.filter((o) => o.have === have && o.want === want).sort((x, y) => this.price(x) - this.price(y)).map((o) => view(o, false)),
            buy: active.filter((o) => o.have === want && o.want === have).sort((x, y) => this.price(x) - this.price(y)).map((o) => view(o, true)),
        };
    }

    async trades(have, want) {
        return this.tradesList
            .filter((t) => (t.have === Number(have) && t.want === Number(want)) || (t.have === Number(want) && t.want === Number(have)))
            .slice(0, 30)
            .map((t) => ({ timestamp: t.timestamp, side: t.have === Number(have) ? 'sell' : 'buy', amount: t.amount, price: t.price, total: t.total }));
    }

    async myOrders(address) {
        return this.orders.filter((o) => o.creator === address).reverse().map((o) => ({
            seqNo: o.seqNo, have: o.have, want: o.want, amount: fromUnits(o.amount), left: fromUnits(o.left),
            wantAmount: fromUnits(o.wantAmount), price: this.price(o).toFixed(8), status: o.status, active: o.active,
        }));
    }

    async createOrder(o, password) {
        this.check(password);
        const acc = this.own(o.creator);
        const units = toUnits(o.haveAmount);
        if ((acc.get(o.have) || 0n) < units) throw new BankError('Недостаточно средств для ордера');
        this.payFee(o.creator);
        acc.set(o.have, acc.get(o.have) - units);
        const order = this.makeOrder(o.creator, o.have, o.want, o.haveAmount, o.wantAmount);
        this.orders.push(order);
        // встречные ордера по цене не хуже
        for (const c of this.orders.filter((x) => x.active && x !== order && x.have === o.want && x.want === o.have)) {
            if (!order.active) break;
            // цена встречного ордера (в активе have за единицу want) должна быть не хуже нашей
            if (Number(c.wantAmount) * Number(order.wantAmount) > Number(c.amount) * Number(order.amount)) continue;
            const wantFromC = order.left * order.wantAmount / order.amount; // сколько want мы хотим за остаток
            const take = wantFromC < c.left ? wantFromC : c.left; // сколько want берём из встречного
            const give = take * c.wantAmount / c.amount; // сколько have отдаём
            c.left -= take;
            order.left -= give;
            acc.set(o.want, (acc.get(o.want) || 0n) + take);
            const cAcc = this.accountsMap.get(c.creator);
            if (cAcc) cAcc.set(c.want, (cAcc.get(c.want) || 0n) + give);
            this.tradesList.unshift({ timestamp: Date.now(), have: o.have, want: o.want, amount: fromUnits(give), total: fromUnits(take), price: (Number(take) / Number(give)).toFixed(8) });
            for (const x of [c, order]) {
                if (x.left <= 0n) Object.assign(x, { left: 0n, active: false, status: 'исполнен' });
                else x.status = 'частично исполнен';
            }
        }
        const tx = this.record('order', { typeName: 'Ордер на бирже', from: o.creator, title: `${this.assetName(o.have)} → ${this.assetName(o.want)}` });
        return { ...this.brief(tx), seqNo: order.seqNo };
    }

    async cancelOrder(c, password) {
        this.check(password);
        const o = this.orders.find((x) => x.seqNo === c.order && x.creator === c.creator);
        if (!o || !o.active) throw new BankError('Ордер не найден или уже закрыт', 404);
        this.payFee(c.creator);
        const acc = this.own(c.creator);
        acc.set(o.have, (acc.get(o.have) || 0n) + o.left);
        Object.assign(o, { active: false, status: 'отменён' });
        return this.brief(this.record('cancel_order', { typeName: 'Отмена ордера', from: c.creator, title: o.seqNo }));
    }

    // ---------- Сообщения ----------

    async messages(address) {
        return this.telegrams
            .filter((m) => m.from === address || m.to === address)
            .map((m) => ({ ...m, direction: m.to === address ? 'in' : 'out' }));
    }

    async sendMessage(m, password) {
        this.check(password);
        this.own(m.from);
        const msg = { signature: base58(crypto.randomBytes(64)), timestamp: Date.now(), from: m.from, to: m.to, title: m.title, message: m.message, encrypted: m.encrypt };
        this.telegrams.unshift(msg);
        // демо: если получатель в кошельке — он видит сообщение; иначе имитируем автоответ
        if (!this.accountsMap.has(m.to)) {
            this.telegrams.unshift({ signature: base58(crypto.randomBytes(64)), timestamp: Date.now() + 1, from: m.to, to: m.from, title: 'Re: ' + (m.title || 'сообщение'), message: 'Получено, спасибо!', encrypted: false });
        }
        return { signature: msg.signature, status: 'ok' };
    }

    // ---------- Документы ----------

    async signDocument(d, password) {
        this.check(password);
        this.payFee(d.creator);
        const tx = this.record('document', { typeName: 'Документ', from: d.creator, title: d.title, message: d.message });
        this.documents.unshift({ ...d, signature: tx.signature, seqNo: tx.seqNo, timestamp: tx.timestamp });
        return this.brief(tx);
    }

    async verifyDocument(hash) {
        return this.documents
            .filter((d) => Object.keys(d.hashes).includes(hash))
            .map((d) => ({ signature: d.signature, seqNo: d.seqNo, timestamp: d.timestamp, creator: d.creator, title: d.title, type: 'Документ' }));
    }

    // ---------- Персоны и справочники ----------

    async persons(from) {
        return this.listOf(this.personsMap, from);
    }

    async person(key) {
        const p = this.personsMap.get(Number(key));
        if (!p) throw new BankError('Персона не найдена', 404);
        return { key: p.key, name: p.name, description: p.description, maker: p.maker, birthday: p.birthday, gender: p.gender, height: p.height, seqNo: null, accounts: p.accounts };
    }

    async issuePerson(p, password) {
        this.check(password);
        this.payFee(p.creator);
        const key = Math.max(0, ...this.personsMap.keys()) + 1;
        const tx = this.record('issue_person', { typeName: 'Регистрация персоны', from: p.creator, title: p.name });
        this.personsMap.set(key, { key, name: p.name, description: p.description, maker: p.creator, birthday: p.birthday, gender: p.gender, height: p.height, accounts: [] });
        return { ...this.brief(tx), key };
    }

    async certifyPerson(c, password) {
        this.check(password);
        const p = this.personsMap.get(c.person);
        if (!p) throw new BankError('Персона не найдена', 404);
        this.payFee(c.creator);
        p.accounts.push('ключ ' + c.pubkey.slice(0, 8) + '…');
        return this.brief(this.record('certify', { typeName: 'Удостоверение ключа', from: c.creator, title: p.name }));
    }

    async catalog(kind) {
        const data = {
            statuses: [
                { key: 1, name: 'Право %1 ур. в объед. %2', maker: 'genesis' },
                { key: 2, name: 'Член объединения %1', maker: 'genesis' },
            ],
            templates: [
                { key: 1, name: 'Пустой шаблон', maker: 'genesis' },
                { key: 2, name: 'Договор купли-продажи', maker: 'genesis' },
                { key: 3, name: 'Доверенность', maker: 'genesis' },
            ],
        };
        return { items: data[kind] || [], next: null, total: (data[kind] || []).length };
    }
}

module.exports = { DemoBackend, toUnits, fromUnits, base58 };
