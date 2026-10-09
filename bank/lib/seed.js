'use strict';

const crypto = require('crypto');
const { BankError } = require('./validate');

/**
 * Сид-фраза кошелька Erachain — 32 случайных байта в Base58 (как в официальном кошельке Erachain,
 * поэтому её можно восстановить и там). Из неё нода выводит все счета банка.
 *
 * Схема доступа:
 *  - сид-фраза — главный ключ владельца: создаётся один раз при первом запуске, записывается на бумагу
 *    и вводится только для входа владельца или восстановления;
 *  - сервер не хранит ни сид, ни пароль кошелька в открытом виде. Он хранит пароль кошелька,
 *    зашифрованный ключом из сид-фразы: без сид-фразы расшифровать его нельзя, а с ней владелец
 *    входит, даже если забыл пароль кошелька;
 *  - сотрудники сид-фразу не видят и не вводят: у них свой логин и пароль и права по роли.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SEED_BYTES = 32;

function base58Encode(bytes) {
    let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
    let s = '';
    while (n > 0n) {
        s = ALPHABET[Number(n % 58n)] + s;
        n /= 58n;
    }
    for (const b of bytes) {
        if (b !== 0) break;
        s = '1' + s;
    }
    return s;
}

function base58Decode(str) {
    let n = 0n;
    for (const c of str) {
        const i = ALPHABET.indexOf(c);
        if (i < 0) return null;
        n = n * 58n + BigInt(i);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
    let zeros = 0;
    while (zeros < str.length && str[zeros] === '1') zeros++;
    return Buffer.concat([Buffer.alloc(zeros), body]);
}

// пробелы, переносы и дефисы — только для удобства записи
function normalizeSeed(seed) {
    return String(seed || '').replace(/[\s-]+/g, '');
}

function seedBytes(seed) {
    const s = normalizeSeed(seed);
    const bytes = s ? base58Decode(s) : null;
    if (!bytes) throw new BankError('В сид-фразе есть недопустимые символы (Base58: без 0, O, I и l)');
    // Erachain дополняет короткие сиды нулями слева — так же, как нода
    if (bytes.length > SEED_BYTES) throw new BankError('Сид-фраза слишком длинная — проверьте, не склеились ли две');
    if (bytes.length < SEED_BYTES - 2) throw new BankError('Сид-фраза слишком короткая — проверьте, что она введена полностью (44 символа)');
    return Buffer.concat([Buffer.alloc(SEED_BYTES - bytes.length), bytes]);
}

function generateSeed() {
    return base58Encode(crypto.randomBytes(SEED_BYTES));
}

// сид-фраза показывается одной строкой Base58 — как в кошельке Erachain
function formatSeed(seed) {
    return normalizeSeed(seed);
}

function sameSeed(a, b) {
    const x = seedBytes(a);
    const y = seedBytes(b);
    return crypto.timingSafeEqual(x, y);
}

function hmac(key, ...parts) {
    const h = crypto.createHmac('sha256', key);
    for (const p of parts) h.update(p);
    return h.digest();
}

// шифрование «поток HMAC-SHA256 + HMAC-тег» (encrypt-then-MAC); работает и на демо-странице
function seal(key, plain) {
    const iv = crypto.randomBytes(16);
    const data = Buffer.from(plain, 'utf8');
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 32) {
        const block = hmac(key, Buffer.from('enc'), iv, Buffer.from(String(i / 32)));
        for (let j = 0; j < 32 && i + j < data.length; j++) out[i + j] = data[i + j] ^ block[j];
    }
    const tag = hmac(key, Buffer.from('mac'), iv, out);
    return { iv: iv.toString('hex'), data: out.toString('hex'), tag: tag.toString('hex') };
}

function open(key, box) {
    const iv = Buffer.from(box.iv, 'hex');
    const data = Buffer.from(box.data, 'hex');
    const tag = hmac(key, Buffer.from('mac'), iv, data);
    const want = Buffer.from(box.tag, 'hex');
    if (tag.length !== want.length || !crypto.timingSafeEqual(tag, want)) return null;
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 32) {
        const block = hmac(key, Buffer.from('enc'), iv, Buffer.from(String(i / 32)));
        for (let j = 0; j < 32 && i + j < data.length; j++) out[i + j] = data[i + j] ^ block[j];
    }
    return out.toString('utf8');
}

// «Личность» по сид-фразе: пароль кошелька, зашифрованный ключом из фразы и отдельно — ключом каждого
// из 21 счёта (для входа в кабинет одного счёта по его приватному ключу). Ни фраза, ни ключи не хранятся.
const scryptKey = (bytes, salt) => crypto.scryptSync(bytes, Buffer.from(salt, 'hex'), 32);

function sealIdentity(seed, walletPassword) {
    const { deriveAccounts } = require('./erakeys');
    const salt = crypto.randomBytes(16).toString('hex');
    const norm = normalizeSeed(seed);
    const accounts = deriveAccounts(norm).map((a) => {
        const s = crypto.randomBytes(16).toString('hex');
        return { n: a.n, address: a.address, salt: s, ...seal(scryptKey(base58Decode(a.privateKey), s), walletPassword) };
    });
    return {
        salt, ...seal(scryptKey(seedBytes(norm), salt), walletPassword), boundAt: Date.now(),
        hint: norm.slice(0, 4) + '…' + norm.slice(-4), // чтобы узнать, какая фраза привязана
        accounts,
    };
}

// пароль кошелька по сид-фразе или null
function openBySeed(identity, seed) {
    return open(scryptKey(seedBytes(seed), identity.salt), identity);
}

// по приватному ключу счёта: { account: { n, address }, walletPassword } или null
function openByKey(identity, acc) {
    const box = (identity.accounts || []).find((a) => a.address === acc.address);
    if (!box) return null;
    const walletPassword = open(scryptKey(base58Decode(acc.privateKey), box.salt), box);
    return walletPassword ? { account: { n: box.n, address: box.address }, walletPassword } : null;
}

// первый счёт фразы — по нему фраза узнаётся без перебора
function firstAddress(seed) {
    return require('./erakeys').deriveAccounts(seed, 1)[0].address;
}

class OwnerKey {
    constructor(store) {
        this.store = store;
    }

    bound() {
        return !!this.store.data.ownerKey;
    }

    identity() {
        return this.store.data.ownerKey || null;
    }

    info() {
        const k = this.store.data.ownerKey;
        return k ? { bound: true, boundAt: k.boundAt, hint: k.hint, accounts: (k.accounts || []).length } : { bound: false, accounts: 0 };
    }

    bind(seed, walletPassword) {
        this.store.data.ownerKey = sealIdentity(seed, walletPassword);
        this.store.save();
        return this.info();
    }

    hasAccount(address) {
        const k = this.store.data.ownerKey;
        return !!(k && (k.accounts || []).some((a) => a.address === address));
    }

    addresses() {
        const k = this.store.data.ownerKey;
        return k ? (k.accounts || []).map((a) => a.address) : [];
    }

    // вход по приватному ключу счёта владельца: { account, walletPassword } или null
    unlockAccount(privateKey) {
        const { fromPrivateKey } = require('./erakeys');
        const acc = fromPrivateKey(privateKey);
        const k = this.store.data.ownerKey;
        if (!k) throw new BankError('Вход по ключу счёта ещё не настроен: владелец должен включить вход по сид-фразе', 409);
        return openByKey(k, acc);
    }

    // это фраза владельца? (по первому счёту; у старых привязок без счетов — пробуем расшифровать)
    isOwnerSeed(seed) {
        const k = this.store.data.ownerKey;
        if (!k) return false;
        if (k.accounts && k.accounts.length) return k.accounts[0].address === firstAddress(seed);
        return openBySeed(k, seed) !== null;
    }

    // пароль кошелька по сид-фразе или null, если фраза не та
    unlock(seed) {
        const k = this.store.data.ownerKey;
        if (!k) throw new BankError('Вход по сид-фразе ещё не настроен: войдите паролем кошелька и привяжите фразу в «Настройки → Сид-фраза»', 409);
        return openBySeed(k, seed);
    }

    unbind() {
        delete this.store.data.ownerKey;
        this.store.save();
        return this.info();
    }
}

module.exports = {
    OwnerKey, sealIdentity, openBySeed, openByKey, firstAddress,
    generateSeed, formatSeed, normalizeSeed, seedBytes, sameSeed, base58Encode, base58Decode,
};
