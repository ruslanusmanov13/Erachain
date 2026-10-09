'use strict';

const crypto = require('crypto');
const { BankError, text } = require('./validate');

/**
 * Сотрудники банка, роли и журнал действий (идея из MapDB-Spring-MVC: пользователи с ролями
 * USER/ADMIN и хешированными паролями — здесь под задачи банка).
 *
 * Владелец входит сид-фразой (или паролем кошелька ноды). Сотрудники — своим логином и паролем; пароль кошелька
 * им не нужен: администратор открывает «смену», и на время смены пароль кошелька хранится только
 * в памяти сервера. Закрытие смены или перезапуск сервера сразу закрывают доступ к подписи.
 */

const PERMISSIONS = {
    read: 'просмотр счетов и операций',
    sign: 'операции с подписью: переводы, обмен, ордера, документы, выпуск',
    statements: 'выгрузка выписок',
    gateway: 'шлюз: загрузка выписок банка, заявки на вывод, выгрузка поручений',
    settings: 'настройки шлюза',
    staff: 'сотрудники, смена, журнал',
    wallet: 'сид-фраза и ключи кошелька (только владелец)',
};

const ROLES = {
    owner: { name: 'Владелец', perms: Object.keys(PERMISSIONS) },
    admin: { name: 'Администратор', perms: Object.keys(PERMISSIONS).filter((p) => p !== 'wallet') },
    operator: { name: 'Операционист', perms: ['read', 'sign', 'statements', 'gateway'] },
    accountant: { name: 'Бухгалтер', perms: ['read', 'statements', 'gateway'] },
    viewer: { name: 'Наблюдатель', perms: ['read'] },
    // вход по приватному ключу одного счёта: только этот счёт (ограничения — в server.js)
    account: { name: 'Кабинет счёта', perms: ['read', 'sign', 'statements'] },
    // клиент, зарегистрированный по своей сид-фразе: только свои 21 счёт
    client: { name: 'Клиент', perms: ['read', 'sign', 'statements'] },
};
const SERVICE_ROLES = ['owner', 'account', 'client'];

const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
const AUDIT_MAX = 5000;
// поля запроса, которые попадают в журнал (пароли, файлы и фото — никогда)
const AUDIT_FIELDS = ['from', 'to', 'creator', 'voter', 'address', 'asset', 'amount', 'side', 'have', 'want', 'haveAmount',
    'wantAmount', 'order', 'title', 'name', 'person', 'option', 'format', 'login', 'role', 'disabled', 'tokenAsset', 'gatewayAccount'];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, hash) {
    const a = Buffer.from(hashPassword(password, salt).hash, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class Staff {
    constructor(store) {
        this.store = store;
        store.data.staff = store.data.staff || [];
        store.data.audit = store.data.audit || [];
        this.shift = null; // { password, openedBy, openedAt } — только в памяти
    }

    static roles() {
        return Object.entries(ROLES).filter(([k]) => !SERVICE_ROLES.includes(k)).map(([key, r]) => ({ key, name: r.name, perms: r.perms }));
    }

    static can(user, perm) {
        const role = ROLES[user && user.role];
        return !!role && role.perms.includes(perm);
    }

    static require(user, perm) {
        if (!Staff.can(user, perm)) {
            throw new BankError(`Недостаточно прав: нужно «${PERMISSIONS[perm] || perm}». Роль: ${(ROLES[user && user.role] || {}).name || '—'}`, 403);
        }
    }

    owner() {
        return { id: 'owner', login: 'owner', name: 'Владелец кошелька', role: 'owner' };
    }

    authenticate(login, password) {
        const u = this.store.data.staff.find((x) => x.login === String(login || '').trim().toLowerCase());
        // одинаковое время ответа, даже если логина нет
        const ok = u ? verifyPassword(password, u.salt, u.hash) : (verifyPassword(password, '00', '00'), false);
        if (!u || !ok) throw new BankError('Неверный логин или пароль', 401);
        if (u.disabled) throw new BankError('Учётная запись отключена администратором', 403);
        return this.public(u);
    }

    public(u) {
        return { id: u.id, login: u.login, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt };
    }

    list() {
        return this.store.data.staff.map((u) => this.public(u));
    }

    find(id) {
        const u = this.store.data.staff.find((x) => x.id === id);
        if (!u) throw new BankError('Сотрудник не найден', 404);
        return u;
    }

    validatePassword(p) {
        if (typeof p !== 'string' || p.length < 8) throw new BankError('Пароль сотрудника — не короче 8 символов');
        return p;
    }

    create(body) {
        const login = text(body.login, 32).toLowerCase();
        if (!LOGIN_RE.test(login) || login === 'owner') throw new BankError('Логин: 3–32 символа, латиница, цифры, . _ -');
        if (this.store.data.staff.some((u) => u.login === login)) throw new BankError('Такой логин уже есть');
        if (!ROLES[body.role] || SERVICE_ROLES.includes(body.role)) throw new BankError('Выберите роль');
        const { salt, hash } = hashPassword(this.validatePassword(body.password));
        const u = { id: crypto.randomUUID(), login, name: text(body.name, 120) || login, role: body.role, salt, hash, disabled: false, createdAt: Date.now() };
        this.store.data.staff.push(u);
        this.store.save();
        return this.public(u);
    }

    update(id, body) {
        const u = this.find(id);
        if (body.name !== undefined) u.name = text(body.name, 120) || u.login;
        if (body.role !== undefined) {
            if (!ROLES[body.role] || SERVICE_ROLES.includes(body.role)) throw new BankError('Неверная роль');
            u.role = body.role;
        }
        if (body.disabled !== undefined) u.disabled = body.disabled === true;
        if (body.password) Object.assign(u, hashPassword(this.validatePassword(body.password)));
        this.store.save();
        return this.public(u);
    }

    remove(id) {
        this.find(id);
        this.store.data.staff = this.store.data.staff.filter((u) => u.id !== id);
        this.store.save();
        return { ok: true };
    }

    // ---------- смена ----------

    openShift(password, user) {
        this.shift = { password, openedBy: user.login, openedAt: Date.now() };
        return this.shiftInfo();
    }

    closeShift() {
        this.shift = null;
        return this.shiftInfo();
    }

    shiftInfo() {
        return this.shift ? { open: true, openedBy: this.shift.openedBy, openedAt: this.shift.openedAt } : { open: false };
    }

    // пароль кошелька для операции: свой у владельца, иначе — пароль открытой смены
    walletPassword(session) {
        if (session.password) return session.password;
        if (this.shift) return this.shift.password;
        throw new BankError('Смена закрыта: попросите администратора открыть смену', 423);
    }

    // ---------- журнал ----------

    audit(entry) {
        const details = {};
        for (const k of AUDIT_FIELDS) {
            if (entry.body && entry.body[k] !== undefined && entry.body[k] !== '') details[k] = String(entry.body[k]).slice(0, 120);
        }
        if (entry.body && Array.isArray(entry.body.payments)) details.payments = entry.body.payments.length;
        this.store.data.audit.unshift({
            ts: Date.now(), login: entry.user ? entry.user.login : '—', role: entry.user ? entry.user.role : '—',
            ip: entry.ip, action: entry.action, details, ok: entry.ok, error: entry.error || undefined,
        });
        if (this.store.data.audit.length > AUDIT_MAX) this.store.data.audit.length = AUDIT_MAX;
        this.store.save();
    }

    auditLog(limit = 200) {
        return this.store.data.audit.slice(0, Math.min(Math.max(limit, 1), 1000));
    }
}

module.exports = { Staff, ROLES, PERMISSIONS, hashPassword, verifyPassword };
