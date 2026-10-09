// Кошелёк на устройстве: ключи только в памяти телефона, сид-фраза — по желанию под PIN (PBKDF2 + AES-GCM).
// Банк получает только публичные ключи и подписанные транзакции.
import { get, post } from '../api.js';
import { deriveAccounts, unbase58, encryptMessage, decryptMessage, base58 } from './keys.js';
import { buildRSend, signBytes } from './eratx.js';

let keys = null; // [{ n, address, publicKey, secretKey, privateKey, publicKeyB58 }] — только в памяти
const enc = new TextEncoder();

export const deviceKeys = () => keys;
export const isWalletRole = (me) => !!(me && me.user && me.user.role === 'wallet');
export function lockKeys() {
    keys = null;
}

export async function walletLogin(accounts) {
    const ch = await post('wallet/challenge');
    const r = await post('wallet/login', {
        publicKeys: accounts.map((a) => a.publicKeyB58), nonce: ch.nonce,
        signature: signBytes(accounts[0], enc.encode(ch.message)),
    });
    keys = accounts;
    return r;
}

// разблокировать кошелёк текущей сессии (после перезагрузки страницы): фраза должна дать те же счета
export function unlockWithSeed(seed, expectedFirst) {
    const list = deriveAccounts(seed);
    if (expectedFirst && list[0].address !== expectedFirst) throw new Error('Это другая сид-фраза — она не подходит к открытому кошельку');
    keys = list;
    return list;
}

// ---------- сид-фраза под PIN на устройстве ----------

const VAULT = 'eraWalletVault';

export function vaultInfo() {
    try {
        const v = JSON.parse(localStorage.getItem(VAULT) || 'null');
        return v && v.data ? { address: v.address, savedAt: v.savedAt } : null;
    } catch (e) {
        return null;
    }
}

async function pinKey(pin, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function saveVault(seed, pin) {
    if (!/^\d{4,12}$/.test(String(pin))) throw new Error('PIN — от 4 до 12 цифр');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), enc.encode(seed)));
    const address = deriveAccounts(seed, 1)[0].address;
    localStorage.setItem(VAULT, JSON.stringify({ salt: base58(salt), iv: base58(iv), data: base58(data), address, savedAt: Date.now() }));
    return { address };
}

export async function openVault(pin) {
    const v = JSON.parse(localStorage.getItem(VAULT) || 'null');
    if (!v) throw new Error('На этом устройстве кошелёк не сохранён');
    try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase58(v.iv) }, await pinKey(pin, unbase58(v.salt)), unbase58(v.data));
        return new TextDecoder().decode(plain);
    } catch (e) {
        throw new Error('Неверный PIN');
    }
}

export function clearVault() {
    try {
        localStorage.removeItem(VAULT);
    } catch (e) { /* ignore */ }
}

// ---------- подпись и отправка ----------

let net = null;
let lastTs = 0;

async function params() {
    if (!net || Date.now() - net.at > 600000) {
        const p = await get('wallet/params');
        net = { port: p.port, offset: p.serverTime - Date.now(), at: Date.now() };
    }
    return net;
}

// время транзакции — по часам сервера и строго возрастает (нода отклоняет повтор времени со счёта)
function nextTs(offset) {
    lastTs = Math.max(Date.now() + offset, lastTs + 1);
    return lastTs;
}

function keyFor(address) {
    const k = keys && keys.find((a) => a.address === address);
    if (!k) throw Object.assign(new Error('Кошелёк заблокирован — введите PIN или сид-фразу'), { locked: true });
    return k;
}

/** Перевод или письмо, подписанные на устройстве. Сервер проверяет подпись и отправляет в сеть. */
export async function sendSigned({ from, to, asset, amount, title, message, encrypt }) {
    const acc = keyFor(from);
    const p = await params();
    let data = message ? enc.encode(message) : null;
    if (data && encrypt) {
        const { publicKey } = await get('pubkey/' + to);
        if (!publicKey) throw new Error('Получатель ещё не совершал операций — его ключ шифрования неизвестен. Отправьте без шифрования.');
        data = await encryptMessage(data, acc.secretKey, unbase58(publicKey));
    }
    const tx = buildRSend(acc, {
        recipient: to, asset, amount, title: title || '', message: data, encrypted: !!(data && encrypt), timestamp: nextTs(p.offset), port: p.port,
    });
    return post('wallet/broadcast', { raw: tx.raw });
}

/** Расшифровать сообщение: на устройстве своим ключом, иначе (счёт в кошельке банка) — силами ноды. */
export async function decryptTx(signature) {
    if (!keys) return (await post(`tx/${signature}/decrypt`)).message;
    const d = await get(`tx/${signature}/data`);
    if (!d.data) return d.message || '';
    const mine = keys.find((a) => a.address === d.to) || keys.find((a) => a.address === d.from);
    if (!mine) throw new Error('Это сообщение не для ваших счетов');
    // общий секрет одинаков с обеих сторон: свой ключ + ключ собеседника
    const otherPub = mine.address === d.to && d.from !== d.to ? d.creatorPublicKey : (await get('pubkey/' + d.to)).publicKey;
    if (!otherPub) throw new Error('Ключ собеседника неизвестен');
    const bytes = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(await decryptMessage(bytes, mine.secretKey, unbase58(otherPub)));
}
