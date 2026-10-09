import { get, post } from '../api.js';
import { el, card, field, input, select, form, tabs, fmt, short, date, kv, empty, spinner, toast } from '../ui.js';
import { state, loadAccounts, accountSelect, balanceOf } from '../state.js';
import { txResult, personalNote } from './common.js';

function mine() {
    // активы по всем счетам кошелька
    const totals = new Map();
    for (const a of state.accounts) {
        for (const b of a.balances) {
            const t = totals.get(b.asset) || { asset: b.asset, name: b.name, amount: 0, accounts: 0 };
            t.amount += Number(b.amount);
            if (Number(b.amount)) t.accounts += 1;
            totals.set(b.asset, t);
        }
    }
    const list = [...totals.values()].sort((x, y) => x.asset - y.asset);
    if (!list.length) return card(empty('На счетах пока нет активов'));
    return card(el('div', { class: 'list' }, list.map((t) => el('a', { class: 'list-item clickable', href: '#/assets/' + t.asset },
        el('div', { class: 'icon-circle' }, t.name.slice(0, 1).toUpperCase()),
        el('div', { class: 'grow' }, el('div', { class: 'title' }, t.name), el('div', { class: 'sub' }, `№${t.asset} · на счетах: ${t.accounts}`)),
        el('div', { class: 'right num' }, el('b', {}, fmt(t.amount)))))));
}

function catalog() {
    const list = el('div', { class: 'list' });
    const more = el('button', { class: 'btn block hidden', type: 'button' }, 'Показать ещё');
    let next = 0;
    const load = async () => {
        more.disabled = true;
        try {
            const page = await get('assets' + (next ? '?from=' + next : ''));
            for (const a of page.items) {
                state.assetNames.set(a.key, a.name);
                list.append(el('a', { class: 'list-item clickable', href: '#/assets/' + a.key },
                    el('div', { class: 'icon-circle' }, (a.name || '?').slice(0, 1).toUpperCase()),
                    el('div', { class: 'grow' }, el('div', { class: 'title' }, a.name), el('div', { class: 'sub' }, `№${a.key} · выпустил ${short(a.maker)}`))));
            }
            next = page.next;
            more.classList.toggle('hidden', !next || !page.items.length);
            if (!list.children.length) list.append(empty('Активов нет'));
        } catch (e) {
            toast(e.message);
        } finally {
            more.disabled = false;
        }
    };
    more.addEventListener('click', load);
    load();
    const search = form([field('Найти актив по номеру', input('key', { inputmode: 'numeric', placeholder: 'Например, 1048' }))], 'Открыть', async (d) => {
        if (!/^\d+$/.test(d.key.trim())) throw new Error('Введите номер актива');
        location.hash = '#/assets/' + d.key.trim();
    });
    return el('div', { class: 'stack' }, card(search), card(list, more));
}

async function issue() {
    const types = await get('assets/types').catch(() => []);
    const typeOptions = types.map((t) => ({ value: t.key, label: t.name }));
    return card(form([
        personalNote(),
        field('Счёт-эмитент', accountSelect('creator')),
        field('Название', input('name', { maxlength: 250, required: true, placeholder: 'Например: Цифровой рубль ООО «Ромашка»' })),
        field('Описание', el('textarea', { name: 'description', rows: 3, maxlength: 4000, placeholder: 'Чем обеспечен актив, права держателя, контакты эмитента' })),
        field('Тип актива', select('assetType', typeOptions.length ? typeOptions : [{ value: 1, label: 'Цифровой актив' }], 1)),
        el('div', { class: 'grid-2' },
            field('Точность (знаков после запятой)', input('scale', { type: 'number', min: 0, max: 16, value: '2' })),
            field('Количество', input('quantity', { type: 'number', min: 0, value: '0' }), '0 — без ограничения: эмитент выпускает переводами')),
    ], 'Выпустить актив', async (d, f) => {
        const r = await post('assets', {
            creator: d.creator, name: d.name, description: d.description,
            assetType: Number(d.assetType), scale: Number(d.scale), quantity: Number(d.quantity),
        });
        f.reset();
        await loadAccounts();
        txResult('Актив выпущен', r);
    }, { confirm: (d) => `Выпустить актив «${d.name}»?\nКоличество: ${Number(d.quantity) ? d.quantity : 'без ограничения'}, точность: ${d.scale}.\nЗа выпуск списывается комиссия сети.` }));
}

async function details(key) {
    const a = await get('assets/' + key);
    state.assetNames.set(a.key, a.name);
    const holders = state.accounts.filter((acc) => Number(balanceOf(acc, a.key)));
    return el('div', { class: 'stack' },
        card(
            el('h2', {}, a.name),
            kv([
                ['Номер', a.key], ['Тип', a.type], ['Эмитент', a.maker ? el('span', { class: 'mono small' }, a.maker) : null],
                ['Количество', a.unlimited || !a.quantity ? 'без ограничения' : fmt(a.quantity, a.scale)],
                ['Точность', a.scale + ' знаков'], ['Выпущен', a.timestamp ? date(a.timestamp) : null], ['Транзакция', a.seqNo],
            ]),
            a.description ? el('p', { class: 'small pre-line' }, a.description) : null),
        card(el('h2', {}, 'На моих счетах'),
            holders.length
                ? el('div', { class: 'list' }, holders.map((acc) => el('div', { class: 'list-item' },
                    el('div', { class: 'grow mono small' }, short(acc.address)), el('b', { class: 'num' }, fmt(balanceOf(acc, a.key))))))
                : empty('Нет на счетах кошелька'),
            el('div', { class: 'row wrap' },
                el('a', { class: 'btn soft', href: '#/transfer' }, 'Перевести'),
                el('a', { class: 'btn', href: `#/exchange/${a.key}/${a.key === 2 ? 1 : 2}` }, 'Торговать на бирже'))),
    );
}

export default {
    title: 'Активы',
    async render(params) {
        if (params[0] && /^\d+$/.test(params[0])) return details(params[0]);
        const mode = ['catalog', 'issue'].includes(params[0]) ? params[0] : 'mine';
        const body = el('div', {});
        const show = async (k) => {
            body.replaceChildren(spinner());
            body.replaceChildren(k === 'catalog' ? catalog() : k === 'issue' ? await issue() : mine());
        };
        show(mode);
        return el('div', {}, tabs([['mine', 'Мои активы'], ['catalog', 'Каталог'], ['issue', 'Выпуск']], mode, show), body);
    },
};
