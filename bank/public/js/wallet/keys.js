// Ключи Erachain на устройстве: 21 счёт из сид-фразы, приватные ключи, шифрование сообщений.
// Тот же расчёт, что у ноды (и lib/erakeys.js на сервере), — но фраза и ключи не покидают устройство.
import nacl from '../vendor/nacl.js';
import { base58, sha256Js } from '../hash.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const ACCOUNTS = 21;

export { base58 };

export function unbase58(str) {
    const s = String(str || '').replace(/\s+/g, '');
    if (!s) throw new Error('Пустая строка Base58');
    let n = 0n;
    for (const c of s) {
        const i = ALPHABET.indexOf(c);
        if (i < 0) throw new Error('Недопустимый символ Base58: ' + c + ' (без 0, O, I и l)');
        n = n * 58n + BigInt(i);
    }
    const bytes = [];
    while (n > 0n) {
        bytes.unshift(Number(n & 255n));
        n >>= 8n;
    }
    for (const c of s) {
        if (c !== '1') break;
        bytes.unshift(0);
    }
    return Uint8Array.from(bytes);
}

export const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let i = 0;
    for (const p of parts) {
        out.set(p, i);
        i += p.length;
    }
    return out;
};

const sha256 = (b) => sha256Js(b);
const sha256d = (b) => sha256(sha256(b));

function int32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n);
    return b;
}

// RIPEMD160 ноды Erachain: байты ≥ 0x80 расширяются знаком и смешиваются через XOR (как в Java)
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

export function eraRipemd160(input) {
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
        X[ptr >> 2] ^= (byte > 127 ? byte - 256 : byte) << ((ptr & 3) << 3);
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
    const out = new Uint8Array(20);
    for (let i = 0; i < 20; i++) out[i] = (md[i >> 2] >>> ((i & 3) << 3)) & 0xff;
    return out;
}

export function addressBytesOf(publicKey) {
    const body = concat(Uint8Array.of(15), eraRipemd160(sha256(publicKey)));
    return concat(body, sha256d(body).subarray(0, 4));
}

export const addressOf = (publicKey) => base58(addressBytesOf(publicKey));

// счёт по ключу счёта (32 байта): пара Ed25519 и адрес
export function accountFromSeed(accSeed, n = null) {
    const kp = nacl.sign.keyPair.fromSeed(accSeed);
    return {
        n, address: addressOf(kp.publicKey), publicKey: kp.publicKey, secretKey: kp.secretKey,
        privateKey: base58(accSeed), publicKeyB58: base58(kp.publicKey),
    };
}

export function seedBytes(seed) {
    const b = unbase58(seed);
    if (b.length > 32) throw new Error('Сид-фраза слишком длинная');
    if (b.length < 30) throw new Error('Сид-фраза слишком короткая — проверьте, что она введена полностью (44 символа)');
    return concat(new Uint8Array(32 - b.length), b);
}

export function generateSeed() {
    return base58(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

// 21 счёт сид-фразы: ключ счёта №n = SHA256(SHA256(n | сид | n))
export function deriveAccounts(seed, count = ACCOUNTS) {
    const sb = seedBytes(seed);
    const list = [];
    for (let i = 0; i < count; i++) list.push(accountFromSeed(sha256d(concat(int32(i), sb, int32(i))), i + 1));
    return list;
}

// приватный ключ счёта: 44 символа (ключ счёта, как в кошельке Erachain) или 88 (ключ NaCl из SDK: ключ+публичный)
export function fromPrivateKey(key) {
    const b = unbase58(key);
    if (b.length === 64) {
        const acc = accountFromSeed(b.subarray(0, 32));
        if (base58(acc.publicKey) !== base58(b.subarray(32))) throw new Error('Ключ из 88 символов повреждён: публичная часть не совпадает');
        return acc;
    }
    if (b.length > 32 || b.length < 30) throw new Error('Приватный ключ счёта — 44 или 88 символов Base58');
    return accountFromSeed(concat(new Uint8Array(32 - b.length), b));
}

// ---------- шифрование сообщений, как AEScrypto ноды ----------

const P = 2n ** 255n - 19n;
const modpow = (b, e) => {
    let r = 1n;
    b %= P;
    while (e > 0n) {
        if (e & 1n) r = (r * b) % P;
        b = (b * b) % P;
        e >>= 1n;
    }
    return r;
};

// Ed25519 (Эдвардс) → X25519 (Монтгомери): u = (1 + y) / (1 − y) mod p
export function edToCurvePublic(pub) {
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? pub[i] & 0x7f : pub[i]);
    const u = ((1n + y) * modpow((1n - y + P) % P, P - 2n)) % P;
    const out = new Uint8Array(32);
    let v = u;
    for (let i = 0; i < 32; i++) {
        out[i] = Number(v & 255n);
        v >>= 8n;
    }
    return out;
}

// скаляр X25519 = SHA-512(ключ счёта)[0..32] (кламп делает scalarMult)
export const edToCurveSecret = (secretKey) => nacl.hash(secretKey.subarray(0, 32)).subarray(0, 32);

const IV = Uint8Array.of(6, 4, 3, 8, 1, 2, 1, 2, 7, 2, 3, 8, 5, 7, 1, 1);

async function aesKey(secretKey, theirPublicKey, usage) {
    const shared = nacl.scalarMult(edToCurveSecret(secretKey), edToCurvePublic(theirPublicKey));
    return globalThis.crypto.subtle.importKey('raw', sha256(shared), { name: 'AES-CBC' }, false, [usage]);
}

// зашифровать для получателя: 0x01 | AES-256-CBC(PKCS7)
export async function encryptMessage(bytes, secretKey, theirPublicKey) {
    const key = await aesKey(secretKey, theirPublicKey, 'encrypt');
    const c = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-CBC', iv: IV }, key, bytes));
    return concat(Uint8Array.of(1), c);
}

export async function decryptMessage(data, secretKey, theirPublicKey) {
    const key = await aesKey(secretKey, theirPublicKey, 'decrypt');
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-CBC', iv: IV }, key, data.subarray(1)));
}
