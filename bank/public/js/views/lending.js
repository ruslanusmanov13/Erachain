// Залоговое кредитование (модель Vires): пулы, депозиты, займы под залог, здоровье позиций, ликвидация.
import { get, post, put } from '../api.js';
import { el, card, field, input, select, form, tabs, fmt, short, date, kv, empty, spinner, toast, badge, confirm } from '../ui.js';
import { state, accountSelect, can, loadAccounts } from '../state.js';

const pct = (x) => (x * 100).toFixed(2) + ' %';
const name = (a) => state.assetNames.get(Number(a)) || '#' + a;
const STATE = { ok: ['в порядке', 'ok'], risk: ['под угрозой', 'warn'], liquidatable: ['к ликвидации', 'bad'], unknown: ['нет цены', 'warn'] };
const OPS = { deposit: 'Депозит', withdraw: 'Вывод депозита', borrow: 'Займ', repay: 'Погашение', liquidate: 'Ликвидация' };

const hfBadge = (p) => {
    const [l, k] = STATE[p.state] || [p.state, ''];
    return badge(`${p.hf === null ? 'HF ∞' : 'HF ' + p.hf.toFixed(2)} · ${l}`, k);
};

async function poolsView() {
    const o = await get('lending');
    const q = name(o.settings.quoteAsset);
    const box = el('div', { class: 'stack' });
    box.append(card(el('p', { class: 'small muted' },
        'Вкладчики кладут активы в пул и получают доход; депозит служит залогом для займа. Ставка займа растёт с загрузкой пула. ' +
        'Здоровье позиции HF = залог × порог ликвидации / долг: при HF < 1 казна банка гасит часть долга и забирает залог с премией.')));
    for (const p of o.pools) {
        box.append(card(
            el('div', { class: 'row between' }, el('h2', {}, 'Пул ' + name(p.asset)), p.enabled ? badge('открыт', 'ok') : badge('приостановлен', '')),
            kv([
                ['Депозиты', fmt(p.supplied)], ['Выдано в займы', fmt(p.borrowed)], ['Свободно', fmt(p.cash)],
                ['Загрузка', pct(p.utilization)], ['Ставка займа', pct(p.borrowApr) + ' годовых'], ['Доход вкладчика', pct(p.supplyApr) + ' годовых'],
                ['Залог (LTV) · порог ликвидации', `${pct(p.collateralFactor)} · ${pct(p.liquidationThreshold)}`],
                ['Премия ликвидатора · доля банка', `${pct(p.liquidationBonus)} · ${pct(p.reserveFactor)}`],
                ['Цена', o.prices[p.asset] ? `${fmt(o.prices[p.asset], 8)} ${q}` : 'нет надёжной цены'],
            ])));
    }
    if (!o.pools.length) box.append(card(empty('Пулов пока нет — создайте во вкладке «Настройки»')));
    return box;
}

async function positionsView() {
    const o = await get('lending');
    const q = name(o.settings.quoteAsset);
    const box = el('div', { class: 'stack' });
    const reload = async () => box.replaceWith(await positionsView());
    box.append(o.positions.length ? card(el('div', { class: 'list' }, o.positions.map((p) => el('div', { class: 'list-item' }, el('div', { class: 'grow stack' },
        el('div', { class: 'row between' }, el('b', { class: 'mono small' }, short(p.address)), hfBadge(p)),
        el('div', { class: 'tiny' }, 'Депозит: ' + (p.supply.map((x) => `${fmt(x.amount)} ${name(x.asset)}`).join(', ') || '—')),
        el('div', { class: 'tiny' }, 'Долг: ' + (p.borrow.filter((x) => Number(x.amount) > 0).map((x) => `${fmt(x.amount)} ${name(x.asset)}`).join(', ') || '—')),
        el('div', { class: 'tiny muted' }, `Залог ${fmt(p.collateralValue, 2)} ${q} · долг ${fmt(p.debtValue, 2)} ${q} · лимит займа ${fmt(p.borrowLimit, 2)} ${q}`),
        p.state === 'liquidatable' && can('sign') ? el('div', {}, el('button', { class: 'btn small danger', type: 'button', onclick: async (e) => {
            if (!(await confirm('Ликвидировать позицию? Казна погасит часть долга и заберёт залог с премией.'))) return;
            e.target.disabled = true;
            try {
                const r = await post('lending/liquidate', { address: p.address });
                toast(`Погашено ${fmt(r.repaid)}, взято залога ${fmt(r.seized)}`);
                reload();
            } catch (err) {
                toast(err.message);
                e.target.disabled = false;
            }
        } }, 'Ликвидировать')) : null))))) : card(empty('Позиций пока нет')));
    if (o.log.length) {
        box.append(card(el('h3', {}, 'Операции'), el('div', { class: 'list' }, o.log.slice(0, 20).map((x) => el('div', { class: 'list-item' }, el('div', { class: 'grow' },
            el('div', { class: 'small' }, `${OPS[x.op] || x.op} · ${short(x.address)}${x.amount !== undefined ? ` · ${fmt(x.amount)} ${name(x.asset)}` : ''}${x.repay ? ` · погашено ${fmt(x.repay)} ${name(x.debtAsset)}, залог ${fmt(x.seize)} ${name(x.collAsset)}` : ''}`),
            el('div', { class: 'tiny muted' }, date(x.at) + (x.error ? ' · ' + x.error : ''))))))));
    }
    return box;
}

async function operateView() {
    const [o] = await Promise.all([get('lending'), state.accounts.length ? null : loadAccounts()]);
    const assets = o.pools.map((p) => ({ value: p.asset, label: name(p.asset) }));
    if (!assets.length) return card(empty('Сначала создайте пул'));
    const out = el('div', {});
    return el('div', { class: 'stack' }, card(form([
        el('h2', {}, 'Операция клиента'),
        field('Операция', select('op', Object.entries(OPS).filter(([k]) => k !== 'liquidate').map(([value, label]) => ({ value, label })), 'deposit')),
        field('Счёт клиента', accountSelect('address')),
        field('Актив', select('asset', assets, assets[0].value)),
        field('Сумма', input('amount', { inputmode: 'decimal', placeholder: 'пусто — всё (для вывода и погашения)' })),
    ], 'Выполнить', async (d) => {
        const all = !d.amount && (d.op === 'withdraw' || d.op === 'repay');
        const r = await post('lending/' + d.op, { address: d.address, asset: Number(d.asset), amount: d.amount || undefined, all });
        toast(OPS[d.op] + ': готово');
        out.replaceChildren(card(el('div', { class: 'row between' }, el('b', {}, 'Позиция'), hfBadge(r.position)),
            kv([['Депозит', r.position.supply.map((x) => `${fmt(x.amount)} ${name(x.asset)}`).join(', ') || '—'],
                ['Долг', r.position.borrow.filter((x) => Number(x.amount) > 0).map((x) => `${fmt(x.amount)} ${name(x.asset)}`).join(', ') || '—'],
                ['Лимит займа', fmt(r.position.borrowLimit, 2) + ' ' + name(o.settings.quoteAsset)]])));
    }, { confirm: (d) => (d.op === 'borrow' ? `Выдать займ ${d.amount} ${name(d.asset)}?` : null) })), out);
}

async function settingsView() {
    const [o] = await Promise.all([get('lending'), state.accounts.length ? null : loadAccounts()]);
    const s = o.settings;
    const box = el('div', { class: 'stack' });
    const reload = async () => box.replaceWith(await settingsView());
    box.append(card(form([
        el('h2', {}, 'Счета и цены'),
        field('Счёт пула (здесь лежат депозиты и залоги)', accountSelect('poolAccount', s.poolAccount)),
        field('Казна (гасит долг при ликвидации и получает залог)', accountSelect('treasuryAccount', s.treasuryAccount)),
        field('Котируемый актив для цен', input('quoteAsset', { inputmode: 'numeric', value: String(s.quoteAsset) }), 'Цены — от агрегатора курсов (раздел «Курсы и маркет-мейкер»)'),
        el('label', { class: 'check-row' }, el('input', { type: 'checkbox', name: 'autoLiquidate', checked: s.autoLiquidate }), 'Ликвидировать автоматически (при открытой смене)'),
    ], 'Сохранить', async (d, f) => {
        await put('lending/settings', { poolAccount: d.poolAccount, treasuryAccount: d.treasuryAccount, quoteAsset: Number(d.quoteAsset), autoLiquidate: f.querySelector('[name=autoLiquidate]').checked });
        toast('Сохранено');
    })));
    box.append(card(form([
        el('h2', {}, 'Пул актива'),
        field('Актив', input('asset', { inputmode: 'numeric', placeholder: 'номер актива' }), 'Если пул уже есть — параметры обновятся'),
        el('div', { class: 'grid-2' },
            field('Залог (LTV)', input('collateralFactor', { inputmode: 'decimal', value: '0.6' })),
            field('Порог ликвидации', input('liquidationThreshold', { inputmode: 'decimal', value: '0.75' })),
            field('Премия ликвидатора', input('liquidationBonus', { inputmode: 'decimal', value: '0.05' })),
            field('Доля банка', input('reserveFactor', { inputmode: 'decimal', value: '0.1' })),
            field('Базовая ставка', input('baseRate', { inputmode: 'decimal', value: '0.02' })),
            field('Наклон до оптимума', input('slope1', { inputmode: 'decimal', value: '0.1' })),
            field('Оптимальная загрузка', input('optimal', { inputmode: 'decimal', value: '0.8' })),
            field('Наклон выше оптимума', input('slope2', { inputmode: 'decimal', value: '1' })),
            field('Точность актива', input('scale', { inputmode: 'numeric', value: '8' }))),
    ], 'Сохранить пул', async (d) => {
        await post('lending/pools', d);
        toast('Пул сохранён');
        reload();
    })));
    return box;
}

export default {
    title: 'Залоговое кредитование',
    async render(params) {
        const views = { pools: poolsView, positions: positionsView, operate: operateView, settings: settingsView };
        const mode = views[params[0]] ? params[0] : 'pools';
        const body = el('div', {}, spinner());
        const show = async (k) => {
            body.replaceChildren(spinner());
            try {
                body.replaceChildren(await views[k]());
            } catch (e) {
                body.replaceChildren(card(el('p', { class: 'error' }, e.message)));
            }
        };
        show(mode);
        const items = [['pools', 'Пулы'], ['positions', 'Позиции']];
        if (can('sign')) items.push(['operate', 'Операция']);
        if (can('settings')) items.push(['settings', 'Настройки']);
        return el('div', {}, tabs(items, mode, show), body);
    },
};
