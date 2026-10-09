'use strict';

const crypto = require('crypto');
const { BankError, isAddress, text } = require('./validate');
const { base58Encode } = require('./seed');

/**
 * Отчёты банка с фиксацией в блокчейне (по мотивам erachainds).
 *
 * По расписанию (раз в сутки, в заданное время) банк собирает отчёт за прошедшие сутки: остатки счетов,
 * операции СБП, счета на оплату, выдачи магазинов, сделки маркет-мейкера, шлюз, журнал действий.
 * Отчёт сохраняется у банка, а его SHA-256 записывается в блокчейн Erachain документом со счёта банка.
 * Каждый отчёт содержит хеш предыдущего — цепочка: подменить или удалить отчёт задним числом незаметно
 * нельзя. Любой, у кого есть файл отчёта, проверит его по хешу в блокчейне.
 */

const DEFAULT_SETTINGS = {
    enabled: false,
    account: '',          // счёт, с которого записывается хеш (нужен COMPU на комиссию)
    time: '00:10',        // когда собирать отчёт за прошедшие сутки (местное время банка)
    utcOffsetMin: 180,    // часовой пояс банка (по умолчанию Москва)
    keep: 400,            // сколько отчётов хранить у банка
};
const DAY = 86400000;
const MAX_CATCH_UP = 7;

// канонический JSON: ключи по алфавиту — один и тот же отчёт всегда даёт один и тот же хеш
function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') {
        return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const hashOf = (report) => base58Encode(sha256(canonical(report)));

class Anchors {
    /** collect(from, to, password) → разделы отчёта; собирает сервер (у него доступ ко всем данным). */
    constructor(backend, store, collect) {
        this.backend = backend;
        this.store = store;
        this.collect = collect;
        const d = store.data;
        d.anchorSettings = { ...DEFAULT_SETTINGS, ...(d.anchorSettings || {}) };
        d.reports = d.reports || [];
    }

    settings() {
        return this.store.data.anchorSettings;
    }

    updateSettings(body) {
        const s = this.settings();
        if (body.account !== undefined) {
            const a = text(body.account, 40);
            if (a && !isAddress(a)) throw new BankError('Неверный счёт для записи хешей');
            s.account = a;
        }
        if (body.time !== undefined) {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time))) throw new BankError('Время — ЧЧ:ММ');
            s.time = String(body.time);
        }
        if (body.utcOffsetMin !== undefined) {
            const n = Number(body.utcOffsetMin);
            if (!Number.isInteger(n) || n < -720 || n > 840) throw new BankError('Часовой пояс: смещение в минутах от UTC');
            s.utcOffsetMin = n;
        }
        if (body.enabled !== undefined) {
            if (body.enabled && !s.account) throw new BankError('Сначала выберите счёт для записи хешей');
            s.enabled = !!body.enabled;
        }
        this.store.save();
        return s;
    }

    // сутки банка: [начало, конец) по местному времени
    dayRange(dateStr) {
        const off = this.settings().utcOffsetMin * 60000;
        const start = Date.parse(dateStr + 'T00:00:00Z') - off;
        if (!Number.isFinite(start)) throw new BankError('Дата — ГГГГ-ММ-ДД');
        return [start, start + DAY];
    }

    localDate(ts) {
        return new Date(ts + this.settings().utcOffsetMin * 60000).toISOString().slice(0, 10);
    }

    list() {
        return this.store.data.reports.map(({ report, ...r }) => r);
    }

    get(id) {
        const r = this.store.data.reports.find((x) => x.id === id);
        if (!r) throw new BankError('Отчёт не найден', 404);
        return r;
    }

    /** Собрать отчёт за сутки dateStr и записать его хеш в блокчейн. Повтор за те же сутки — только с force. */
    async run(dateStr, password, { force = false } = {}) {
        const s = this.settings();
        if (!isAddress(s.account)) throw new BankError('Выберите счёт для записи хешей в настройках отчётов');
        const [from, to] = this.dayRange(dateStr);
        if (to > Date.now() && !force) throw new BankError('Сутки ещё не закончились');
        const existing = this.store.data.reports.find((r) => r.date === dateStr && r.kind === 'daily');
        if (existing && !force) return existing;
        const prev = this.store.data.reports.find((r) => r.hash && r.id !== (existing && existing.id));
        const report = {
            type: 'erachain-bank-report', version: 1, kind: 'daily', date: dateStr, period: { from, to },
            createdAt: Date.now(), prevHash: prev ? prev.hash : null,
            ...(await this.collect(from, to, password)),
        };
        const hash = hashOf(report);
        const rec = {
            id: crypto.randomBytes(5).toString('hex'), kind: 'daily', date: dateStr, hash, prevHash: report.prevHash,
            createdAt: report.createdAt, status: 'made', account: s.account, report, summary: report.summary || null,
        };
        this.store.data.reports.unshift(rec);
        if (this.store.data.reports.length > s.keep) this.store.data.reports.length = s.keep;
        this.store.save();
        await this.anchor(rec, password);
        return rec;
    }

    async anchor(rec, password) {
        try {
            const res = await this.backend.signDocument({
                creator: rec.account, title: `Отчёт банка за ${rec.date}`,
                message: JSON.stringify({ type: 'erachain-bank-report', kind: rec.kind, date: rec.date, hash: rec.hash, prev: rec.prevHash }),
                hashes: { [rec.hash]: `report-${rec.date}.json` }, recipients: [],
            }, password);
            Object.assign(rec, { status: 'anchored', signature: res.signature || null, seqNo: res.seqNo || null, anchoredAt: Date.now(), error: null });
        } catch (e) {
            // нода недоступна или нет COMPU — повторим на следующем проходе
            Object.assign(rec, { status: 'made', error: e.message, tries: (rec.tries || 0) + 1 });
        }
        this.store.save();
        return rec;
    }

    /** Расписание: отчёты за пропущенные сутки, повтор записи, подтверждения. */
    async tick(password, now = Date.now()) {
        const s = this.settings();
        const done = [];
        if (!s.enabled) return done;
        const [h, m] = s.time.split(':').map(Number);
        // последние сутки, за которые пора собирать отчёт
        const today = this.localDate(now);
        const [todayStart] = this.dayRange(today);
        const due = now >= todayStart + (h * 60 + m) * 60000 ? today : this.localDate(now - DAY);
        let day = this.localDate(this.dayRange(due)[0] - DAY);
        const days = [];
        // первый запуск — только последние сутки; дальше догоняем пропуски (сервер был выключен) до недели
        const limit = this.store.data.reports.length ? MAX_CATCH_UP : 1;
        for (let i = 0; i < limit; i++) {
            if (this.store.data.reports.some((r) => r.date === day)) break;
            days.unshift(day);
            day = this.localDate(this.dayRange(day)[0] - DAY);
        }
        for (const d of days) done.push(await this.run(d, password));
        for (const r of this.store.data.reports.filter((x) => x.status === 'made' && !done.includes(x)).slice(0, 5)) await this.anchor(r, password);
        for (const r of this.store.data.reports.filter((x) => x.status === 'anchored' && x.signature)) {
            const st = await this.backend.txStatus(r.signature).catch(() => null);
            if (st && st.found && st.confirmations > 0) Object.assign(r, { status: 'confirmed', seqNo: st.seqNo || r.seqNo, height: st.height });
            else if (st && !st.found && Date.now() - r.anchoredAt > 15 * 60000) Object.assign(r, { status: 'made', signature: null, error: 'Запись не попала в сеть — повторим' });
        }
        this.store.save();
        return done;
    }

    /** Проверка файла отчёта: хеш, запись в блокчейне, место в цепочке. */
    async verify(content) {
        let report;
        try {
            report = typeof content === 'string' ? JSON.parse(content) : content;
        } catch (e) {
            throw new BankError('Это не файл отчёта (JSON)');
        }
        if (!report || report.type !== 'erachain-bank-report') throw new BankError('Это не файл отчёта банка');
        const hash = hashOf(report);
        const local = this.store.data.reports.find((r) => r.hash === hash) || null;
        const sameDay = this.store.data.reports.find((r) => r.date === report.date && r.kind === report.kind) || null;
        const chain = await this.backend.verifyDocument(hash).catch(() => []);
        return {
            hash, date: report.date, onChain: chain, anchored: chain.length > 0,
            known: !!local, changed: !local && !!sameDay, prevHash: report.prevHash || null,
            prevKnown: report.prevHash ? this.store.data.reports.some((r) => r.hash === report.prevHash) : null,
        };
    }

    file(id) {
        const r = this.get(id);
        return { filename: `report-${r.date}.json`, content: Buffer.from(JSON.stringify(r.report, null, 2), 'utf8') };
    }
}

module.exports = { Anchors, canonical, hashOf };
