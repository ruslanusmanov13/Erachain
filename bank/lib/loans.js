'use strict';

const crypto = require('crypto');
const { BankError, isAddress, isAmount, amountOf, text } = require('./validate');

/**
 * Кредиты на долговых позициях Erachain (идея кредитного протокола из icreator/protocol — Vires:
 * займы под процент с графиком и обеспечением, здесь — средствами самой сети Erachain):
 *
 *  - выдача: перевод с отрицательным номером актива — актив уходит заёмщику с отметкой «в долг»;
 *  - погашение: заёмщик переводит долг обратно (тоже отрицательный номер);
 *  - взыскание: кредитор забирает долг (отрицательный номер + backward).
 *
 * Сервер ведёт договор: график (аннуитет или дифференцированный), распределение платежей
 * (сначала неустойка, проценты, потом тело), просрочку и неустойку; договор подписывается
 * в блокчейне документом, заёмщик может его заверить (r_vouch).
 */

const STATUS = {
    draft: 'черновик', signed: 'договор подписан', active: 'действует', overdue: 'просрочка',
    closed: 'погашен', defaulted: 'взыскание', cancelled: 'отменён',
};

function round(x, scale) {
    const f = 10 ** scale;
    return Math.round(x * f) / f;
}

function addMonths(ts, n) {
    const d = new Date(ts);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d.getTime();
}

// График платежей: аннуитетный (равные платежи) или дифференцированный (равные части тела)
function buildSchedule({ principal, ratePct, termMonths, type, startDate, scale }) {
    const r = ratePct / 12 / 100;
    const rows = [];
    let rest = principal;
    const annuity = r === 0 ? principal / termMonths : principal * r / (1 - (1 + r) ** -termMonths);
    for (let n = 1; n <= termMonths; n++) {
        const interest = round(rest * r, scale);
        let body = type === 'diff' ? round(principal / termMonths, scale) : round(annuity - interest, scale);
        if (n === termMonths || body > rest) body = round(rest, scale); // последний платёж закрывает остаток
        rest = round(rest - body, scale);
        rows.push({ n, date: addMonths(startDate, n), principal: body, interest, total: round(body + interest, scale), paidPrincipal: 0, paidInterest: 0 });
    }
    return rows;
}

class Loans {
    constructor(backend, store) {
        this.backend = backend;
        this.store = store;
        store.data.loans = store.data.loans || [];
        store.data.loanSeq = store.data.loanSeq || 0;
    }

    get(id) {
        const l = this.store.data.loans.find((x) => x.id === id);
        if (!l) throw new BankError('Договор не найден', 404);
        return l;
    }

    // состояние на дату: остаток долга, просрочка, неустойка, следующий платёж
    state(l, now = Date.now()) {
        const due = l.schedule.filter((r) => r.date <= now);
        const overduePrincipal = round(due.reduce((s, r) => s + r.principal - r.paidPrincipal, 0), l.scale);
        const overdueInterest = round(due.reduce((s, r) => s + r.interest - r.paidInterest, 0), l.scale);
        let penalty = 0;
        for (const r of due) {
            const unpaid = r.total - r.paidPrincipal - r.paidInterest;
            if (unpaid > 0) penalty += unpaid * (l.penaltyPctDay / 100) * Math.floor((now - r.date) / 86400000);
        }
        penalty = round(Math.max(0, penalty - (l.penaltyPaid || 0)), l.scale);
        const restPrincipal = round(l.principal - l.schedule.reduce((s, r) => s + r.paidPrincipal, 0), l.scale);
        const next = l.schedule.find((r) => r.paidPrincipal + r.paidInterest < r.total - 1e-9);
        return {
            restPrincipal, overduePrincipal, overdueInterest, penalty,
            overdue: round(overduePrincipal + overdueInterest, l.scale),
            nextPayment: next ? { n: next.n, date: next.date, amount: round(next.total - next.paidPrincipal - next.paidInterest, l.scale) } : null,
            // для досрочного погашения: тело + проценты текущего периода + просрочка + неустойка
            payoffAmount: round(restPrincipal + overdueInterest + penalty, l.scale),
        };
    }

    view(l) {
        const st = this.state(l);
        let status = l.status;
        if (status === 'active' && st.overdue > 0) status = 'overdue';
        return { ...l, status, statusText: STATUS[status], state: st };
    }

    list() {
        return this.store.data.loans.map((l) => this.view(l));
    }

    async create(body) {
        const lender = text(body.lender, 40);
        const borrower = text(body.borrower, 40);
        if (!isAddress(lender)) throw new BankError('Выберите счёт кредитора');
        if (!isAddress(borrower) || borrower === lender) throw new BankError('Неверный счёт заёмщика');
        const asset = Number(body.asset);
        if (!Number.isSafeInteger(asset) || asset <= 0) throw new BankError('Выберите актив');
        const a = amountOf(body.principal);
        if (!isAmount(a)) throw new BankError('Неверная сумма кредита');
        const ratePct = Number(String(body.ratePct ?? '').replace(',', '.'));
        if (!(ratePct >= 0 && ratePct <= 300)) throw new BankError('Ставка: от 0 до 300 % годовых');
        const termMonths = parseInt(body.termMonths, 10);
        if (!(termMonths >= 1 && termMonths <= 360)) throw new BankError('Срок: от 1 до 360 месяцев');
        const penaltyPctDay = Number(String(body.penaltyPctDay ?? '0.1').replace(',', '.'));
        if (!(penaltyPctDay >= 0 && penaltyPctDay <= 1)) throw new BankError('Неустойка: от 0 до 1 % в день');
        const type = body.type === 'diff' ? 'diff' : 'annuity';
        const scale = Number.isInteger(Number(body.scale)) ? Math.min(Math.max(Number(body.scale), 0), 8) : 2;
        const principal = round(Number(a), scale);
        this.store.data.loanSeq += 1;
        const l = {
            id: crypto.randomUUID(), number: `КД-${new Date().getFullYear()}-${String(this.store.data.loanSeq).padStart(4, '0')}`,
            lender, borrower, borrowerName: text(body.borrowerName, 160), asset, assetName: text(body.assetName, 60) || '#' + asset, scale,
            principal, ratePct, termMonths, type, penaltyPctDay, collateral: text(body.collateral, 300),
            createdAt: Date.now(), status: 'draft', payments: [], penaltyPaid: 0,
        };
        l.schedule = buildSchedule({ principal, ratePct, termMonths, type, startDate: Date.now(), scale });
        l.totalInterest = round(l.schedule.reduce((s, r) => s + r.interest, 0), scale);
        this.store.data.loans.unshift(l);
        this.store.save();
        return this.view(l);
    }

    contractText(l) {
        return [
            `Кредитный договор ${l.number}`,
            `Кредитор: ${l.lender}`,
            `Заёмщик: ${l.borrowerName ? l.borrowerName + ', ' : ''}${l.borrower}`,
            `Сумма: ${l.principal} ${l.assetName} (актив Erachain №${l.asset}), выдаётся в долг средствами блокчейна Erachain.`,
            `Ставка: ${l.ratePct}% годовых, срок ${l.termMonths} мес., график ${l.type === 'diff' ? 'дифференцированный' : 'аннуитетный'}.`,
            `Неустойка за просрочку: ${l.penaltyPctDay}% в день от просроченной суммы.`,
            l.collateral ? `Обеспечение: ${l.collateral}` : '',
            'График платежей:',
            ...l.schedule.map((r) => `${r.n}. ${new Date(r.date).toLocaleDateString('ru-RU')}: ${r.total} (тело ${r.principal}, проценты ${r.interest})`),
            'Платёж зачисляется в порядке: неустойка, проценты, основной долг. При неисполнении кредитор вправе взыскать долг.',
        ].filter(Boolean).join('\n');
    }

    // подписание договора кредитором: документ в блокчейне, получатель — заёмщик
    async sign(id, password) {
        const l = this.get(id);
        if (l.status !== 'draft') throw new BankError('Договор уже подписан');
        const r = await this.backend.signDocument({
            creator: l.lender, title: `Кредитный договор ${l.number}`, message: this.contractText(l), hashes: {}, recipients: [l.borrower],
        }, password);
        Object.assign(l, { status: 'signed', contractTx: r.signature, contractSeqNo: r.seqNo, signedAt: Date.now() });
        this.store.save();
        return this.view(l);
    }

    // заверение договора заёмщиком (если его счёт в кошельке ноды — например, клиент на обслуживании)
    async vouch(id, password) {
        const l = this.get(id);
        if (!l.contractSeqNo) throw new BankError('Сначала подпишите договор');
        const r = await this.backend.vouch(l.borrower, l.contractSeqNo, password);
        Object.assign(l, { vouchTx: r.signature, vouchedAt: Date.now() });
        this.store.save();
        return this.view(l);
    }

    async issue(id, password) {
        const l = this.get(id);
        if (!['draft', 'signed'].includes(l.status)) throw new BankError('Кредит уже выдан или закрыт');
        const tx = await this.backend.debtTransfer({
            from: l.lender, to: l.borrower, asset: l.asset, amount: String(l.principal), title: `Выдача по договору ${l.number}`, message: '',
        }, password);
        // график считается от даты выдачи
        l.schedule = buildSchedule({ principal: l.principal, ratePct: l.ratePct, termMonths: l.termMonths, type: l.type, startDate: Date.now(), scale: l.scale });
        Object.assign(l, { status: 'active', issueTx: tx.signature, issuedAt: Date.now() });
        this.store.save();
        return this.view(l);
    }

    // распределение платежа: неустойка → наступившие платежи (проценты, затем тело) → досрочно в тело будущих периодов
    allocate(l, amount, now = Date.now()) {
        let left = round(amount, l.scale);
        const take = (want) => {
            const x = round(Math.min(left, Math.max(0, want)), l.scale);
            left = round(left - x, l.scale);
            return x;
        };
        const toPenalty = take(this.state(l, now).penalty);
        l.penaltyPaid = round((l.penaltyPaid || 0) + toPenalty, l.scale);
        let toInterest = 0;
        let toPrincipal = 0;
        for (const r of l.schedule.filter((x) => x.date <= now)) {
            const i = take(r.interest - r.paidInterest);
            r.paidInterest = round(r.paidInterest + i, l.scale);
            const p = take(r.principal - r.paidPrincipal);
            r.paidPrincipal = round(r.paidPrincipal + p, l.scale);
            toInterest += i;
            toPrincipal += p;
        }
        for (const r of l.schedule.filter((x) => x.date > now)) {
            const p = take(r.principal - r.paidPrincipal);
            r.paidPrincipal = round(r.paidPrincipal + p, l.scale);
            toPrincipal += p;
            // период погашен досрочно целиком — проценты по нему не начисляются
            if (r.paidPrincipal >= r.principal) {
                r.interest = r.paidInterest;
                r.total = round(r.principal + r.interest, l.scale);
            }
        }
        return { toPenalty, toInterest: round(toInterest, l.scale), toPrincipal: round(toPrincipal, l.scale), change: left };
    }

    closeIfPaid(l) {
        if (this.state(l).restPrincipal <= 0) Object.assign(l, { status: 'closed', closedAt: Date.now() });
    }

    // платёж заёмщика со счёта в кошельке ноды (возврат долга в блокчейне)
    async repay(id, body, password) {
        const l = this.get(id);
        if (!['active', 'defaulted'].includes(l.status)) throw new BankError('Кредит не действует');
        const a = amountOf(body.amount);
        if (!isAmount(a)) throw new BankError('Неверная сумма платежа');
        const st = this.state(l);
        const amount = Math.min(Number(a), st.payoffAmount);
        const tx = await this.backend.debtTransfer({
            from: l.borrower, to: l.lender, asset: l.asset, amount: String(round(amount, l.scale)), title: `Погашение по договору ${l.number}`, message: '',
        }, password);
        const split = this.allocate(l, amount);
        l.payments.unshift({ date: Date.now(), amount: round(amount, l.scale), tx: tx.signature, kind: 'repay', ...split });
        this.closeIfPaid(l);
        this.store.save();
        return this.view(l);
    }

    // погашения, сделанные заёмщиком самостоятельно: ищем в истории счёта кредитора переводы с номером договора
    async scan(id, password) {
        const l = this.get(id);
        const history = await this.backend.history(l.lender, 200, password);
        let added = 0;
        for (const tx of history.slice().reverse()) {
            if (tx.direction !== 'in' || tx.from !== l.borrower || Number(tx.asset) !== l.asset || !tx.amount) continue;
            if (!(tx.title || '').includes(l.number) || l.payments.some((p) => p.tx === tx.signature)) continue;
            const split = this.allocate(l, Number(tx.amount), tx.timestamp || Date.now());
            l.payments.unshift({ date: tx.timestamp || Date.now(), amount: Number(tx.amount), tx: tx.signature, kind: 'found', ...split });
            added += 1;
        }
        this.closeIfPaid(l);
        this.store.save();
        return { added, loan: this.view(l) };
    }

    // взыскание долга кредитором (backward): по умолчанию — вся просрочка с неустойкой
    async confiscate(id, body, password) {
        const l = this.get(id);
        if (!['active', 'defaulted'].includes(l.status)) throw new BankError('Кредит не действует');
        const st = this.state(l);
        const amount = body.amount ? Number(amountOf(body.amount)) : round(st.overdue + st.penalty, l.scale);
        if (!(amount > 0)) throw new BankError('Нет просроченной задолженности — укажите сумму взыскания');
        if (amount > st.restPrincipal + st.overdueInterest + st.penalty + 1e-9) throw new BankError('Сумма больше задолженности');
        const tx = await this.backend.debtTransfer({
            from: l.lender, to: l.borrower, asset: l.asset, amount: String(round(amount, l.scale)), title: `Взыскание по договору ${l.number}`, message: '', backward: true,
        }, password);
        const split = this.allocate(l, amount);
        l.payments.unshift({ date: Date.now(), amount: round(amount, l.scale), tx: tx.signature, kind: 'confiscation', ...split });
        l.status = 'defaulted';
        this.closeIfPaid(l);
        this.store.save();
        return this.view(l);
    }

    cancel(id) {
        const l = this.get(id);
        if (!['draft', 'signed'].includes(l.status)) throw new BankError('Выданный кредит отменить нельзя');
        l.status = 'cancelled';
        this.store.save();
        return this.view(l);
    }

    // расчёт без сохранения — для предпросмотра в форме
    static preview(body) {
        const principal = Number(amountOf(body.principal));
        const ratePct = Number(String(body.ratePct ?? '').replace(',', '.'));
        const termMonths = parseInt(body.termMonths, 10);
        if (!(principal > 0) || !(ratePct >= 0) || !(termMonths >= 1 && termMonths <= 360)) throw new BankError('Заполните сумму, ставку и срок');
        const scale = Number.isInteger(Number(body.scale)) ? Number(body.scale) : 2;
        const schedule = buildSchedule({ principal, ratePct, termMonths, type: body.type === 'diff' ? 'diff' : 'annuity', startDate: Date.now(), scale });
        return { schedule, totalInterest: round(schedule.reduce((s, r) => s + r.interest, 0), scale), total: round(schedule.reduce((s, r) => s + r.total, 0), scale) };
    }
}

module.exports = { Loans, buildSchedule, STATUS };
