'use strict';

const crypto = require('crypto');
const { BankError } = require('./validate');
const { base58Encode, base58Decode, seedBytes } = require('./seed');

/**
 * Счета Erachain из сид-фразы — так же, как в кошельке ноды (org.erachain.core.wallet.Wallet):
 *   ключ счёта №n  = SHA256(SHA256(n | сид | n)), n — 4 байта big-endian, нумерация с 0;
 *   пара ключей    = Ed25519 из ключа счёта (32 байта);
 *   адрес          = Base58(15 | RIPEMD160(SHA256(публичный ключ)) | 4 байта SHA256(SHA256(...))).
 * «Приватный ключ» счёта в Erachain — ключ счёта в Base58 (44 символа), как и сид-фраза.
 * Его можно импортировать в любой кошелёк Erachain.
 */

const ACCOUNTS = 21; // стандарт банка: 21 счёт на одну сид-фразу
const ADDRESS_VERSION = 15;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function int32(n) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
}

function accountSeed(seed, n) {
    const nb = int32(n);
    return sha256(sha256(Buffer.concat([nb, seedBytes(seed), nb])));
}

function publicKey(accSeed) {
    const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, accSeed]), format: 'der', type: 'pkcs8' });
    const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
    return Buffer.from(spki.subarray(spki.length - 32));
}

// RIPEMD160 ноды Erachain (org.erachain.core.crypto.RIPEMD160) — перенесён один в один. Он отличается от
// стандартного: байты ≥ 0x80 при упаковке в слова расширяются знаком ((int) byte << n) и смешиваются через XOR.
// Поэтому стандартный ripemd160 даёт другие адреса — нужен именно этот вариант.
const R_ARG = [
    [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
        11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
        9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6],
    [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
        9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
        8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11],
];
const R_IDX = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
        3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
        4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13],
    [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
        15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
        12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11],
];
const R_F = [
    (b, c, d) => b ^ c ^ d, (b, c, d) => (b & c) | (~b & d), (b, c, d) => (b | ~c) ^ d,
    (b, c, d) => (b & d) | (c & ~d), (b, c, d) => b ^ (c | ~d),
];
const R_K1 = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const R_K2 = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0];
const rol = (x, s) => (x << s) | (x >>> (32 - s));

function eraRipemd160(input) {
    const md = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0];
    const compress = (X) => {
        let [a, b, c, d, e] = md;
        let [A, B, C, D, E] = md;
        for (let i = 0; i < 80; i++) {
            const r = i >> 4;
            let t = (a + R_F[r](b, c, d) + X[R_IDX[0][i]] + R_K1[r]) | 0;
            a = e; e = d; d = rol(c, 10); c = b; b = (rol(t, R_ARG[0][i]) + a) | 0;
            t = (A + R_F[4 - r](B, C, D) + X[R_IDX[1][i]] + R_K2[r]) | 0;
            A = E; E = D; D = rol(C, 10); C = B; B = (rol(t, R_ARG[1][i]) + A) | 0;
        }
        const t = (md[1] + c + D) | 0;
        md[1] = (md[2] + d + E) | 0;
        md[2] = (md[3] + e + A) | 0;
        md[3] = (md[4] + a + B) | 0;
        md[4] = (md[0] + b + C) | 0;
        md[0] = t;
    };
    let X = new Array(16).fill(0);
    let ptr = 0;
    for (const byte of input) {
        const signed = byte > 127 ? byte - 256 : byte; // Java byte
        X[ptr >> 2] ^= signed << ((ptr & 3) << 3);
        if (++ptr === 64) {
            compress(X);
            X = new Array(16).fill(0);
            ptr = 0;
        }
    }
    const len = input.length;
    X[(len >> 2) & 15] ^= 1 << (((len & 3) << 3) + 7);
    if ((len & 63) > 55) {
        compress(X);
        for (let i = 0; i < 14; i++) X[i] = 0;
    }
    X[14] = len << 3;
    X[15] = len >> 29;
    compress(X);
    const out = Buffer.alloc(20);
    for (let i = 0; i < 20; i++) out[i] = (md[i >> 2] >>> ((i & 3) << 3)) & 0xff;
    return out;
}

function addressOf(pub) {
    const short = eraRipemd160(sha256(pub));
    const body = Buffer.concat([Buffer.from([ADDRESS_VERSION]), short]);
    return base58Encode(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
}

function account(accSeed, n = null) {
    const pub = publicKey(accSeed);
    return { n, address: addressOf(pub), publicKey: base58Encode(pub), privateKey: base58Encode(accSeed) };
}

// 21 счёт сид-фразы: [{ n: 1..21, address, publicKey, privateKey }]
function deriveAccounts(seed, count = ACCOUNTS) {
    const list = [];
    for (let i = 0; i < count; i++) list.push(account(accountSeed(seed, i), i + 1));
    return list;
}

// приватный ключ счёта (Base58, 32 байта) → счёт
function fromPrivateKey(key) {
    const s = String(key || '').replace(/\s+/g, '');
    const bytes = s ? base58Decode(s) : null;
    if (!bytes) throw new BankError('В ключе есть недопустимые символы (Base58: без 0, O, I и l)');
    if (bytes.length > 32 || bytes.length < 30) throw new BankError('Приватный ключ счёта — 44 символа Base58');
    return account(Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]));
}

module.exports = { ACCOUNTS, deriveAccounts, fromPrivateKey, accountSeed, addressOf, eraRipemd160 };
