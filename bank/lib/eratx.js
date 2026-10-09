'use strict';

const crypto = require('crypto');
const { BankError } = require('./validate');
const { base58Decode, base58Encode } = require('./seed');
const { addressOf } = require('./erakeys');

/**
 * Разбор подписанных на устройстве транзакций (формат — public/js/wallet/eratx.js и RSend.toBytes ноды).
 * Сервер проверяет, от чьего имени подписана транзакция, прежде чем отправить её в сеть: кошелёк на
 * устройстве может отправлять только со своих счетов.
 */

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function parseRaw(raw) {
    const b = typeof raw === 'string' ? base58Decode(raw.trim()) : Buffer.from(raw);
    if (!b || b.length < 4 + 8 + 8 + 32 + 1 + 64) throw new BankError('Неверная транзакция');
    let o = 0;
    const type = [...b.subarray(0, 4)];
    o = 4;
    const timestamp = Number(b.readBigInt64BE(o));
    o += 8;
    const flags = b.readBigInt64BE(o);
    o += 8;
    const publicKey = b.subarray(o, o + 32);
    o += 32;
    const tx = { type: type[0], version: type[1], prop1: type[2], prop2: type[3], timestamp, flags, publicKey, creator: addressOf(publicKey) };
    if (type[2] & 32) throw new BankError('Транзакции со ссылкой (exLink) с устройства не поддерживаются');
    tx.feePow = b[o];
    o += 1;
    const sigStart = o;
    tx.signature = b.subarray(o, o + 64);
    o += 64;
    tx.head = b.subarray(0, sigStart);
    if (tx.type === 31) {
        tx.recipient = base58Encode(b.subarray(o, o + 25));
        o += 25;
        if (!(type[2] & 128)) {
            tx.asset = Number(b.readBigInt64BE(o));
            o += 8;
            const unscaled = b.readBigInt64BE(o);
            o += 8;
            let diff = type[3] & 31;
            if (diff > 15) diff -= 32;
            const scale = 8 + diff;
            tx.amount = toDecimal(unscaled, scale);
        }
        tx.backward = !!(type[2] & 64);
        const tl = b[o];
        o += 1;
        tx.title = b.subarray(o, o + tl).toString('utf8');
        o += tl;
        if (!(type[3] & 128)) {
            const len = b.readInt32BE(o);
            o += 4;
            tx.data = b.subarray(o, o + len);
            o += len;
            tx.encrypted = b[o] === 1;
            tx.isText = b[o + 1] === 1;
            o += 2;
        }
    }
    tx.body = b.subarray(sigStart + 64, o || b.length);
    tx.bytes = b;
    tx.signatureB58 = base58Encode(tx.signature);
    return tx;
}

function toDecimal(unscaled, scale) {
    const neg = unscaled < 0n;
    let s = (neg ? -unscaled : unscaled).toString();
    if (scale <= 0) return (neg ? '-' : '') + s + '0'.repeat(-scale);
    s = s.padStart(scale + 1, '0');
    const r = s.slice(0, -scale) + '.' + s.slice(-scale);
    return (neg ? '-' : '') + r.replace(/\.?0+$/, '');
}

// подпись Ed25519 над (байты без подписи + порт сети)
function verifyTx(tx, port) {
    const port4 = Buffer.alloc(4);
    port4.writeInt32BE(port);
    const data = Buffer.concat([tx.head, tx.body, port4]);
    return verifySig(tx.publicKey, data, tx.signature);
}

function verifySig(publicKey, data, signature) {
    try {
        const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey)]), format: 'der', type: 'spki' });
        return crypto.verify(null, Buffer.from(data), key, Buffer.from(signature));
    } catch (e) {
        return false;
    }
}

module.exports = { parseRaw, verifyTx, verifySig, toDecimal };
