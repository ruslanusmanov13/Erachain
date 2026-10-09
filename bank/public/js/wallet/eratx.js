// Сборка и подпись транзакций Erachain на устройстве — байт в байт как у ноды (RSend.toBytes, Transaction.sign).
// Подписанная транзакция отправляется в сеть сервером банка (record/broadcast); ключ с устройства не уходит.
//
// Перевод / письмо (R_Send, тип 31, версия 2):
//   [31, 2, prop1, prop2] | timestamp i64 | flags i64 = 0 | публичный ключ 32 | feePow 1 | подпись 64 |
//   получатель 25 | (актив i64 | сумма i64 — если есть сумма) | длина заголовка 1 | заголовок |
//   (длина данных i32 | данные | зашифровано 1 | текст 1 — если есть сообщение)
//   prop1: 128 — без суммы, 64 — взыскание долга (backward); prop2: 128 — без сообщения, младшие 5 бит —
//   масштаб суммы относительно 8 знаков (отрицательный + 32).
// Подписываются байты без подписи + номер порта сети (int32): 9046 — основная сеть, 9066 — тестовая.
import nacl from '../vendor/nacl.js';
import { base58, unbase58, concat } from './keys.js';

const enc = new TextEncoder();

function i64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(v));
    return b;
}

function i32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v);
    return b;
}

// «1.50» → { unscaled: 15n, scale: 1 } — как BigDecimal ноды после разбора строки (без хвостовых нулей дроби)
export function decimal(amount) {
    const s = String(amount).trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error('Неверная сумма: ' + amount);
    let [int, frac = ''] = s.split('.');
    frac = frac.replace(/0+$/, '');
    return { unscaled: BigInt(int + frac), scale: frac.length };
}

export function addressBytes(address) {
    const b = unbase58(address);
    if (b.length !== 25 || b[0] !== 15) throw new Error('Неверный адрес Erachain: ' + address);
    return b;
}

/**
 * Перевод или письмо. account — { secretKey, publicKey } с устройства.
 * t: { recipient, asset?, amount?, title?, message?: Uint8Array|string, encrypted?, isText?, backward?, timestamp, port, feePow? }
 */
export function buildRSend(account, t) {
    const hasAmount = t.amount !== undefined && t.amount !== null && t.amount !== '';
    const message = typeof t.message === 'string' ? enc.encode(t.message) : t.message;
    const hasData = !!(message && message.length);
    let prop1 = hasAmount ? 0 : 128;
    if (t.backward) prop1 |= 64;
    let prop2 = hasData ? 0 : 128;
    let amountPart = new Uint8Array(0);
    if (hasAmount) {
        const { unscaled, scale } = decimal(t.amount);
        let diff = scale - 8;
        if (diff < -8 || diff > 23) throw new Error('Слишком много знаков в сумме');
        if (diff < 0) diff += 32;
        prop2 |= diff;
        amountPart = concat(i64(t.asset), i64(unscaled));
    }
    const titleBytes = enc.encode(t.title || '');
    if (titleBytes.length > 255) throw new Error('Заголовок длиннее 255 байт');
    const head = concat(Uint8Array.of(31, 2, prop1, prop2), i64(t.timestamp), i64(0), account.publicKey, Uint8Array.of(t.feePow || 0));
    const body = concat(
        addressBytes(t.recipient), amountPart, Uint8Array.of(titleBytes.length), titleBytes,
        hasData ? concat(i32(message.length), message, Uint8Array.of(t.encrypted ? 1 : 0), Uint8Array.of(t.isText === false ? 0 : 1)) : new Uint8Array(0),
    );
    const signature = nacl.sign.detached(concat(head, body, i32(t.port)), account.secretKey);
    const bytes = concat(head, signature, body);
    return { signature: base58(signature), raw: base58(bytes), bytes };
}

// подпись произвольных данных (вход в банк: доказательство владения ключом без его передачи)
export function signBytes(account, bytes) {
    return base58(nacl.sign.detached(bytes, account.secretKey));
}
