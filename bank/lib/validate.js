'use strict';

// Адреса Erachain — Base58 (25 байт), начинаются с "7", обычно 34 символа.
const ADDRESS_RE = /^7[1-9A-HJ-NP-Za-km-z]{32,34}$/;
// Публичный ключ — Base58 32 байта.
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{40,46}$/;
// Сумма: положительное число, до 8 знаков после точки (масштаб ERA/COMPU).
const AMOUNT_RE = /^(0|[1-9]\d{0,15})(\.\d{1,8})?$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

class BankError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function isAddress(value) {
    return typeof value === 'string' && ADDRESS_RE.test(value);
}

function isAmount(value) {
    if (typeof value !== 'string' || !AMOUNT_RE.test(value)) return false;
    return Number(value) > 0;
}

function isAssetKey(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function amountOf(value) {
    return typeof value === 'string' ? value.trim().replace(',', '.') : String(value ?? '');
}

function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requireAddress(value, what) {
    if (!isAddress(value)) throw new BankError('Неверный адрес: ' + what);
    return value;
}

function requireAmount(value, what = 'сумма') {
    const a = amountOf(value);
    if (!isAmount(a)) throw new BankError('Неверная ' + what);
    return a;
}

function requireKey(value, what) {
    const k = Number(value);
    if (!isAssetKey(k)) throw new BankError('Неверный ключ: ' + what);
    return k;
}

function validateTransfer(body) {
    const t = {
        from: requireAddress(body.from, 'отправитель'),
        to: requireAddress(typeof body.to === 'string' ? body.to.trim() : body.to, 'получатель'),
        asset: requireKey(body.asset, 'актив'),
        amount: requireAmount(body.amount),
        title: text(body.title, 250),
        message: text(body.message, 4000),
        encrypt: body.encrypt === true,
    };
    if (t.from === t.to) throw new BankError('Нельзя перевести на тот же счёт');
    return t;
}

function validateMultiTransfer(body) {
    const from = requireAddress(body.from, 'отправитель');
    const asset = requireKey(body.asset, 'актив');
    const title = text(body.title, 250);
    if (!Array.isArray(body.payments) || !body.payments.length) throw new BankError('Список выплат пуст');
    if (body.payments.length > 500) throw new BankError('Не больше 500 выплат за раз');
    const payments = body.payments.map((p, i) => {
        const to = typeof p.to === 'string' ? p.to.trim() : p.to;
        if (!isAddress(to)) throw new BankError(`Строка ${i + 1}: неверный адрес`);
        const amount = amountOf(p.amount);
        if (!isAmount(amount)) throw new BankError(`Строка ${i + 1}: неверная сумма`);
        return { to, amount, title: text(p.title, 250) || title };
    });
    return { from, asset, title, payments };
}

function validateAssetIssue(body) {
    const a = {
        creator: requireAddress(body.creator, 'создатель'),
        name: text(body.name, 250),
        description: text(body.description, 4000),
        scale: Number(body.scale ?? 0),
        assetType: Number(body.assetType ?? 1),
        quantity: Number(body.quantity ?? 0),
    };
    if (!a.name) throw new BankError('Укажите название актива');
    if (!Number.isInteger(a.scale) || a.scale < 0 || a.scale > 16) throw new BankError('Точность: от 0 до 16 знаков');
    if (!Number.isInteger(a.assetType) || a.assetType < 0) throw new BankError('Неверный тип актива');
    if (!Number.isSafeInteger(a.quantity) || a.quantity < 0) throw new BankError('Количество: целое число ≥ 0 (0 — без ограничения)');
    return a;
}

function validatePoll(body) {
    const p = {
        creator: requireAddress(body.creator, 'создатель'),
        name: text(body.name, 250),
        description: text(body.description, 4000),
        options: Array.isArray(body.options) ? body.options.map((o) => text(o, 250)).filter(Boolean) : [],
    };
    if (p.name.length < 12) throw new BankError('Название голосования — не короче 12 символов');
    if (p.options.length < 2) throw new BankError('Нужно минимум два варианта ответа');
    if (p.options.length > 100) throw new BankError('Слишком много вариантов');
    return p;
}

function validateVote(body, key) {
    const v = {
        poll: requireKey(key, 'голосование'),
        voter: requireAddress(body.voter, 'голосующий'),
        option: Number(body.option),
    };
    if (!Number.isInteger(v.option) || v.option < 0) throw new BankError('Выберите вариант');
    return v;
}

function validateOrder(body) {
    const o = {
        creator: requireAddress(body.creator, 'счёт'),
        have: requireKey(body.have, 'отдаю'),
        want: requireKey(body.want, 'получаю'),
        haveAmount: requireAmount(body.haveAmount, 'сумма продажи'),
        wantAmount: requireAmount(body.wantAmount, 'сумма покупки'),
    };
    if (o.have === o.want) throw new BankError('Активы пары должны различаться');
    return o;
}

function validateCancel(body) {
    // ордер задаётся номером SeqNo ("1234-1") или подписью транзакции создания (Base58)
    const order = text(body.order, 120);
    if (!/^\d+-\d+$/.test(order) && !BASE58_RE.test(order)) throw new BankError('Неверный номер ордера');
    return { creator: requireAddress(body.creator, 'счёт'), order };
}

function validateMessage(body) {
    const m = {
        from: requireAddress(body.from, 'отправитель'),
        to: requireAddress(typeof body.to === 'string' ? body.to.trim() : body.to, 'получатель'),
        title: text(body.title, 250),
        message: text(body.message, 4000),
        encrypt: body.encrypt === true,
    };
    if (!m.message && !m.title) throw new BankError('Сообщение пустое');
    return m;
}

function validateDocument(body) {
    const d = {
        creator: requireAddress(body.creator, 'подписант'),
        title: text(body.title, 250),
        message: text(body.message, 20000),
        hashes: {},
        recipients: [],
    };
    if (!d.title) throw new BankError('Укажите название документа');
    if (body.hashes && typeof body.hashes === 'object') {
        for (const [hash, desc] of Object.entries(body.hashes)) {
            if (!BASE58_RE.test(hash) || hash.length < 40 || hash.length > 46) throw new BankError('Неверный хеш файла');
            d.hashes[hash] = text(desc, 250);
        }
    }
    if (Array.isArray(body.recipients)) {
        d.recipients = body.recipients.map((r) => (typeof r === 'string' ? r.trim() : r)).filter(Boolean);
        for (const r of d.recipients) requireAddress(r, 'получатель документа');
    }
    if (!d.message && !Object.keys(d.hashes).length) throw new BankError('Добавьте текст или файл');
    return d;
}

function validateCertify(body) {
    const c = {
        creator: requireAddress(body.creator, 'удостоверяющий'),
        person: requireKey(body.person, 'персона'),
        pubkey: text(body.pubkey, 60),
        days: Number(body.days ?? 1),
    };
    if (!PUBKEY_RE.test(c.pubkey)) throw new BankError('Неверный публичный ключ');
    if (!Number.isInteger(c.days) || c.days < 1 || c.days > 36500) throw new BankError('Срок: от 1 дня');
    return c;
}

function validatePersonIssue(body) {
    const p = {
        creator: requireAddress(body.creator, 'регистратор'),
        name: text(body.name, 250),
        description: text(body.description, 4000),
        birthday: Date.parse(body.birthday),
        gender: Number(body.gender ?? 0),
        height: Number(body.height ?? 170),
        owner: text(body.owner, 60),
        image64: typeof body.image64 === 'string' ? body.image64.replace(/^data:image\/\w+;base64,/, '') : '',
    };
    // фото обязательно: в основной сети 10–32 КБ (нода проверяет точные границы)
    const imageBytes = Math.floor(p.image64.length * 3 / 4);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(p.image64) || imageBytes < 5 * 1024 || imageBytes > 128 * 1024) {
        throw new BankError('Нужна фотография 10–32 КБ (JPEG)');
    }
    if (p.name.split(/\s+/).length < 2) throw new BankError('Укажите полное имя (имя и фамилию)');
    if (!Number.isFinite(p.birthday)) throw new BankError('Неверная дата рождения');
    if (![0, 1, 2].includes(p.gender)) throw new BankError('Неверный пол');
    if (!Number.isInteger(p.height) || p.height < 40 || p.height > 260) throw new BankError('Рост: 40–260 см');
    if (p.owner && !PUBKEY_RE.test(p.owner)) throw new BankError('Неверный публичный ключ владельца');
    return p;
}

module.exports = {
    BankError, isAddress, isAmount, isAssetKey, amountOf, text,
    validateTransfer, validateMultiTransfer, validateAssetIssue, validatePoll, validateVote,
    validateOrder, validateCancel, validateMessage, validateDocument, validateCertify, validatePersonIssue,
};
