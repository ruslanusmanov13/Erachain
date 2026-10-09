'use strict';

// Адреса Erachain — Base58 (25 байт), начинаются с "7", обычно 34 символа.
const ADDRESS_RE = /^7[1-9A-HJ-NP-Za-km-z]{32,34}$/;
// Сумма: положительное число, до 8 знаков после точки (масштаб ERA/COMPU).
const AMOUNT_RE = /^(0|[1-9]\d{0,15})(\.\d{1,8})?$/;

function isAddress(value) {
    return typeof value === 'string' && ADDRESS_RE.test(value);
}

function isAmount(value) {
    if (typeof value !== 'string' || !AMOUNT_RE.test(value)) return false;
    return Number(value) > 0;
}

function isAssetKey(value) {
    return Number.isInteger(value) && value > 0;
}

class BankError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function validateTransfer(body) {
    const transfer = {
        from: body.from,
        to: typeof body.to === 'string' ? body.to.trim() : body.to,
        asset: Number(body.asset),
        amount: typeof body.amount === 'string' ? body.amount.trim().replace(',', '.') : String(body.amount ?? ''),
        title: typeof body.title === 'string' ? body.title.slice(0, 250) : '',
        message: typeof body.message === 'string' ? body.message.slice(0, 4000) : '',
    };
    if (!isAddress(transfer.from)) throw new BankError('Неверный счёт отправителя');
    if (!isAddress(transfer.to)) throw new BankError('Неверный адрес получателя');
    if (transfer.from === transfer.to) throw new BankError('Нельзя перевести на тот же счёт');
    if (!isAssetKey(transfer.asset)) throw new BankError('Неверный актив');
    if (!isAmount(transfer.amount)) throw new BankError('Неверная сумма');
    return transfer;
}

module.exports = { isAddress, isAmount, isAssetKey, validateTransfer, BankError };
