'use strict';

const crypto = require('crypto');
const { BankError, text } = require('./validate');
const { sealIdentity, openBySeed, openByKey, firstAddress, normalizeSeed, seedBytes } = require('./seed');
const { deriveAccounts, fromPrivateKey } = require('./erakeys');

/**
 * Клиенты банка: регистрация по сид-фразе. У клиента своя фраза и свои 21 счёт; ключи счетов
 * импортируются в кошелёк ноды, а сервер хранит только пароль кошелька, зашифрованный ключом из фразы
 * клиента и ключами его счетов (как у владельца). Ни фраза, ни приватные ключи не хранятся.
 */
class Clients {
    constructor(store) {
        this.store = store;
        store.data.clients = store.data.clients || [];
    }

    list() {
        return this.store.data.clients.map((c) => this.public(c));
    }

    public(c) {
        return { id: c.id, name: c.name, createdAt: c.createdAt, hint: c.hint, address: c.accounts[0].address, accounts: c.accounts.length, disabled: !!c.disabled };
    }

    get(id) {
        const c = this.store.data.clients.find((x) => x.id === id);
        if (!c) throw new BankError('Клиент не найден', 404);
        return c;
    }

    bySeed(seed) {
        const first = firstAddress(seed);
        return this.store.data.clients.find((c) => c.accounts[0].address === first) || null;
    }

    addresses(c) {
        return c.accounts.map((a) => a.address);
    }

    // проверка перед регистрацией: формат фразы, имя
    prepare(body) {
        seedBytes(body.seed);
        const seed = normalizeSeed(body.seed);
        if (this.bySeed(seed)) throw new BankError('Эта сид-фраза уже зарегистрирована — войдите по ней', 409);
        return { seed, name: text(body.name, 120), keys: deriveAccounts(seed) };
    }

    add({ seed, name }, walletPassword) {
        const c = { id: crypto.randomUUID(), name: name || '', createdAt: Date.now(), ...sealIdentity(seed, walletPassword) };
        this.store.data.clients.push(c);
        this.store.save();
        return c;
    }

    // { client, walletPassword } по фразе; null — фраза не зарегистрирована
    unlock(seed) {
        const c = this.bySeed(seed);
        if (!c) return null;
        const walletPassword = openBySeed(c, seed);
        if (!walletPassword) return null;
        if (c.disabled) throw new BankError('Доступ клиента приостановлен банком', 403);
        return { client: c, walletPassword };
    }

    // по приватному ключу счёта клиента
    unlockAccount(privateKey) {
        const acc = fromPrivateKey(privateKey);
        for (const c of this.store.data.clients) {
            const r = openByKey(c, acc);
            if (r) {
                if (c.disabled) throw new BankError('Доступ клиента приостановлен банком', 403);
                return { ...r, client: c };
            }
        }
        return null;
    }

    owns(address) {
        return this.store.data.clients.find((c) => c.accounts.some((a) => a.address === address)) || null;
    }

    setDisabled(id, disabled) {
        const c = this.get(id);
        c.disabled = disabled === true;
        this.store.save();
        return this.public(c);
    }
}

module.exports = { Clients };
