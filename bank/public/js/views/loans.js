import { get, post } from '../api.js';
import { el, card, field, input, select, form, tabs, fmt, short, date, kv, empty, spinner, toast, badge, confirm } from '../ui.js';
import { state, accountSelect, can, loadAccounts } from '../state.js';

const KIND = { draft: '', signed: 'warn', active: 'ok', overdue: 'bad', closed: 'ok', defaulted: 'bad', cancelled: '' };
const d0 = (ts) => (ts ? new Date(ts).toLocaleDateString('ru-RU') : '—');

function scheduleTable(rows, scale = 2) {
    return el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
        el('tr', {}, el('th', {}, '№'), el('th', {}, 'Дата'), el('th', { class: 'right' }, 'Платёж'), el('th', { class: 'right' }, 'Тело'), el('th', { class: 'right' }, 'Проценты'), el('th', { class: 'right' }, 'Оплачено')),
        rows.map((r) => {
            const paid = (r.paidPrincipal || 0) + (r.paidInterest || 0);
            return el('tr', { class: paid >= r.total - 1e-9 && r.total > 0 ? 'in' : r.date < Date.now() && paid < r.total ? 'out' : '' },
                el('td', {}, String(r.n)), el('td', {}, d0(r.date)), el('td', { class: 'right num' }, fmt(r.total, scale)),
                el('td', { class: 'right num' }, fmt(r.principal, scale)), el('td', { class: 'right num' }, fmt(r.interest, scale)),
                el('td', { class: 'right num' }, paid ? fmt(paid, scale) : '—'));
        })));
}

async function listView() {
    const list = await get('loans');
    if (!list.length) return card(empty('Кредитов пока нет — оформите первый договор во вкладке «Новый»'));
    const active = list.filter((l) => ['active', 'overdue', 'defaulted'].includes(l.status));
    const sumBy = (f) => active.reduce((s, l) => s + f(l), 0);
    return el('div', { class: 'stack' },
        el('div', { class: 'grid-2' },
            card(el('div', { class: 'tiny muted' }, 'Портфель (остаток долга)'), el('div', { class: 'big-num num' }, fmt(sumBy((l) => l.state.restPrincipal)))),
            card(el('div', { class: 'tiny muted' }, 'Просрочено'), el('div', { class: 'big-num num out' }, fmt(sumBy((l) => l.state.overdue))))),
        card(el('div', { class: 'list' }, list.map((l) => el('a', { class: 'list-item clickable', href: '#/loans/' + l.id },
            el('div', { class: 'icon-circle ' + (l.status === 'overdue' ? 'out' : '') }, '%'),
            el('div', { class: 'grow' },
                el('div', { class: 'title' }, `${l.number} · ${fmt(l.principal, l.scale)} ${l.assetName}`),
                el('div', { class: 'sub' }, `${l.borrowerName || short(l.borrower)} · ${l.ratePct}% · ${l.termMonths} мес.${l.state.nextPayment && ['active', 'overdue'].includes(l.status) ? ' · платёж ' + d0(l.state.nextPayment.date) : ''}`)),
            badge(l.statusText, KIND[l.status] || ''))))));
}

async function newView() {
    const preview = el('div', {});
    const f = form([
        el('p', { class: 'small muted' }, 'Кредит выдаётся средствами блокчейна Erachain: актив переходит заёмщику с отметкой «в долг», а погашения и взыскание записываются в сети.'),
        field('Кредитор (счёт банка)', accountSelect('lender')),
        field('Заёмщик — счёт Erachain', input('borrower', { required: true, spellcheck: 'false' })),
        field('Заёмщик — ФИО или организация', input('borrowerName', { maxlength: 160 })),
        el('div', { class: 'grid-2' },
            field('Актив', select('asset', [...new Map(state.accounts.flatMap((a) => a.balances).map((b) => [b.asset, b])).values()].map((b) => ({ value: b.asset, label: `${b.name} (№${b.asset})` })), 1048)),
            field('Точность, знаков', input('scale', { type: 'number', min: 0, max: 8, value: '2' }))),
        el('div', { class: 'grid-2' },
            field('Сумма', input('principal', { inputmode: 'decimal', required: true, value: '100000' })),
            field('Ставка, % годовых', input('ratePct', { inputmode: 'decimal', value: '18' }))),
        el('div', { class: 'grid-2' },
            field('Срок, месяцев', input('termMonths', { type: 'number', min: 1, max: 360, value: '12' })),
            field('График', select('type', [{ value: 'annuity', label: 'Аннуитетный' }, { value: 'diff', label: 'Дифференцированный' }], 'annuity'))),
        field('Неустойка, % в день', input('penaltyPctDay', { inputmode: 'decimal', value: '0.1' })),
        field('Обеспечение', input('collateral', { maxlength: 300, placeholder: 'Залог, поручительство (необязательно)' })),
        preview,
    ], 'Создать договор', async (d) => {
        const assetName = state.assetNames.get(Number(d.asset)) || '#' + d.asset;
        const l = await post('loans', { ...d, asset: Number(d.asset), assetName });
        toast('Договор ' + l.number + ' создан');
        location.hash = '#/loans/' + l.id;
    });
    const update = async () => {
        const d = Object.fromEntries(new FormData(f).entries());
        try {
            const p = await post('loans/preview', d);
            preview.replaceChildren(el('p', { class: 'small' }, `Переплата: ${fmt(p.totalInterest)}, всего к возврату: ${fmt(p.total)}`), scheduleTable(p.schedule, Number(d.scale) || 2));
        } catch (e) {
            preview.replaceChildren();
        }
    };
    f.addEventListener('input', () => { clearTimeout(update.t); update.t = setTimeout(update, 300); });
    update();
    return card(f);
}

async function detailView(id) {
    const l = await get('loans/' + id);
    const st = l.state;
    const reload = async () => document.getElementById('view').replaceChildren(await detailView(id));
    const act = (label, path, confirmText, body, cls = 'soft') => {
        const b = el('button', { class: 'btn ' + cls, type: 'button' }, label);
        b.addEventListener('click', async () => {
            if (confirmText && !(await confirm(confirmText))) return;
            b.disabled = true;
            try {
                const r = await post(`loans/${id}/${path}`, body ? body() : {});
                if (r.added !== undefined) toast(r.added ? `Найдено платежей: ${r.added}` : 'Новых платежей нет');
                await loadAccounts().catch(() => {});
                await reload();
            } catch (e) {
                toast(e.message);
                b.disabled = false;
            }
        });
        return b;
    };
    const actions = el('div', { class: 'row wrap' });
    if (can('sign')) {
        if (l.status === 'draft') actions.append(act('Подписать договор', 'sign', `Подписать договор ${l.number} и записать в блокчейн?`));
        if (l.status === 'signed' && !l.vouchTx && state.accounts.some((a) => a.address === l.borrower)) actions.append(act('Заверить заёмщиком', 'vouch', 'Заверить договор со счёта заёмщика (он в кошельке ноды)?'));
        if (['draft', 'signed'].includes(l.status)) actions.append(act('Выдать кредит', 'issue', `Выдать ${fmt(l.principal, l.scale)} ${l.assetName} в долг на счёт ${short(l.borrower)}?`, null, 'primary'));
    }
    if (['active', 'overdue', 'defaulted'].includes(l.status)) {
        actions.append(act('Найти платежи заёмщика', 'scan'));
        if (can('sign') && (st.overdue > 0 || st.penalty > 0)) {
            actions.append(act(`Взыскать ${fmt(st.overdue + st.penalty, l.scale)}`, 'confiscate', 'Взыскать просроченную задолженность со счёта заёмщика? Операция записывается в блокчейн.', null, 'danger'));
        }
    }
    if (['draft', 'signed'].includes(l.status)) actions.append(act('Отменить', 'cancel', 'Отменить договор?', null, 'danger'));

    const repay = ['active', 'overdue', 'defaulted'].includes(l.status) && can('sign') && state.accounts.some((a) => a.address === l.borrower)
        ? card(el('h2', {}, 'Платёж со счёта заёмщика'), form([
            el('p', { class: 'small muted' }, `Ближайший платёж: ${st.nextPayment ? fmt(st.nextPayment.amount, l.scale) + ' до ' + d0(st.nextPayment.date) : '—'}. Полное погашение: ${fmt(st.payoffAmount, l.scale)}.`),
            field('Сумма', input('amount', { inputmode: 'decimal', value: String(st.overdue + st.penalty > 0 ? st.overdue + st.penalty : st.nextPayment ? st.nextPayment.amount : st.payoffAmount) })),
        ], 'Внести платёж', async (d) => {
            await post(`loans/${id}/repay`, { amount: d.amount });
            toast('Платёж внесён');
            await reload();
        })) : null;

    return el('div', { class: 'stack' },
        card(
            el('div', { class: 'row between' }, el('h2', {}, l.number), badge(l.statusText, KIND[l.status] || '')),
            kv([
                ['Заёмщик', `${l.borrowerName ? l.borrowerName + ' · ' : ''}${l.borrower}`], ['Сумма', `${fmt(l.principal, l.scale)} ${l.assetName}`],
                ['Условия', `${l.ratePct}% годовых, ${l.termMonths} мес., ${l.type === 'diff' ? 'дифференцированный' : 'аннуитетный'}, неустойка ${l.penaltyPctDay}% в день`],
                ['Обеспечение', l.collateral], ['Переплата по графику', fmt(l.totalInterest, l.scale)],
                ['Договор в блокчейне', l.contractSeqNo ? `№ ${l.contractSeqNo}` : null], ['Заверён заёмщиком', l.vouchTx ? 'да' : null],
                ['Выдан', l.issuedAt ? d0(l.issuedAt) : null],
            ]),
            actions),
        ['active', 'overdue', 'defaulted', 'closed'].includes(l.status) ? el('div', { class: 'grid-2' },
            card(el('div', { class: 'tiny muted' }, 'Остаток долга'), el('div', { class: 'big-num num' }, fmt(st.restPrincipal, l.scale))),
            card(el('div', { class: 'tiny muted' }, 'Просрочено + неустойка'), el('div', { class: 'big-num num ' + (st.overdue > 0 ? 'out' : '') }, fmt(st.overdue + st.penalty, l.scale)))) : null,
        repay,
        card(el('h2', {}, 'График платежей'), scheduleTable(l.schedule, l.scale)),
        l.payments.length ? card(el('h2', {}, 'Платежи'), el('div', { class: 'list' }, l.payments.map((p) => el('div', { class: 'list-item' },
            el('div', { class: 'grow' },
                el('div', { class: 'title num' }, `${fmt(p.amount, l.scale)} ${l.assetName}`),
                el('div', { class: 'sub' }, `${date(p.date)} · ${{ repay: 'платёж', found: 'найден в истории', confiscation: 'взыскание' }[p.kind] || p.kind}`
                    + ` · проценты ${fmt(p.toInterest, l.scale)}, тело ${fmt(p.toPrincipal, l.scale)}${p.toPenalty ? ', неустойка ' + fmt(p.toPenalty, l.scale) : ''}`))))))
            : null);
}

export default {
    title: 'Кредиты',
    async render(params) {
        if (params[0] && params[0] !== 'new' && params[0] !== 'list') return detailView(params[0]);
        const mode = params[0] === 'new' ? 'new' : 'list';
        const body = el('div', {}, spinner());
        const show = async (k) => {
            body.replaceChildren(spinner());
            try {
                body.replaceChildren(await (k === 'new' ? newView() : listView()));
            } catch (e) {
                body.replaceChildren(card(el('p', { class: 'error' }, e.message)));
            }
        };
        show(mode);
        return el('div', {}, tabs([['list', 'Договоры'], ['new', 'Новый']], mode, show), body);
    },
};
