import { get, post } from '../api.js';
import { el, card, field, input, form, tabs, fmt, date, empty, spinner, toast, confirm } from '../ui.js';
import { state, loadAccounts, accountSelect, resolveAssetName } from '../state.js';
import { txResult } from './common.js';

function bookTable(rows, haveName, wantName, kind) {
    if (!rows.length) return empty(kind === 'sell' ? 'Нет заявок на продажу' : 'Нет заявок на покупку');
    return el('table', { class: 'data' },
        el('tr', {}, el('th', {}, `Цена, ${wantName}`), el('th', { class: 'right' }, `Кол-во, ${haveName}`), el('th', { class: 'right' }, `Сумма, ${wantName}`)),
        rows.map((o) => el('tr', {},
            el('td', { class: 'num ' + (kind === 'sell' ? 'out' : 'in') }, fmt(o.price)),
            el('td', { class: 'right num' }, fmt(o.amount)),
            el('td', { class: 'right num' }, fmt(o.total)))));
}

function orderForm(side, have, want, haveName, wantName, onDone) {
    const amount = input('amount', { inputmode: 'decimal', placeholder: '0', required: true });
    const price = input('price', { inputmode: 'decimal', placeholder: '0', required: true });
    const total = el('div', { class: 'small muted num' });
    const update = () => {
        const t = Number(amount.value.replace(',', '.')) * Number(price.value.replace(',', '.'));
        total.textContent = Number.isFinite(t) && t > 0 ? `Сумма: ${fmt(t)} ${wantName}` : '';
    };
    amount.addEventListener('input', update);
    price.addEventListener('input', update);
    return form([
        field('Счёт', accountSelect('creator')),
        el('div', { class: 'grid-2' }, field(`Количество, ${haveName}`, amount), field(`Цена за 1, ${wantName}`, price)),
        total,
    ], side === 'sell' ? `Продать ${haveName}` : `Купить ${haveName}`, async (d, f) => {
        const qty = Number(d.amount.replace(',', '.'));
        const pr = Number(d.price.replace(',', '.'));
        if (!(qty > 0) || !(pr > 0)) throw new Error('Укажите количество и цену');
        const sum = +(qty * pr).toFixed(8);
        const toStr = (n) => String(+n.toFixed(8));
        // продажа: отдаём have, получаем want; покупка — наоборот
        const body = side === 'sell'
            ? { creator: d.creator, have, want, haveAmount: toStr(qty), wantAmount: toStr(sum) }
            : { creator: d.creator, have: want, want: have, haveAmount: toStr(sum), wantAmount: toStr(qty) };
        const r = await post('exchange/orders', body);
        f.reset();
        total.textContent = '';
        await loadAccounts();
        txResult('Ордер выставлен', r);
        onDone();
    }, { confirm: (d) => `${side === 'sell' ? 'Продать' : 'Купить'} ${d.amount} ${haveName} по цене ${d.price} ${wantName}?` });
}

async function myOrders(box, haveName) {
    box.replaceChildren(spinner());
    const all = (await Promise.all(state.accounts.map((a) => get('exchange/orders/' + a.address).then((l) => l.map((o) => ({ ...o, creator: a.address }))).catch(() => [])))).flat();
    if (!all.length) {
        box.replaceChildren(empty('У вас нет ордеров'));
        return;
    }
    const names = new Map();
    for (const o of all) for (const k of [o.have, o.want]) if (!names.has(k)) names.set(k, await resolveAssetName(k));
    box.replaceChildren(el('div', { class: 'list' }, all.map((o) => {
        const cancel = o.active ? el('button', { class: 'btn small danger', type: 'button' }, 'Отменить') : null;
        if (cancel) {
            cancel.addEventListener('click', async () => {
                if (!(await confirm(`Отменить ордер ${o.seqNo}? Остаток вернётся на счёт.`))) return;
                cancel.disabled = true;
                try {
                    await post('exchange/cancel', { creator: o.creator, order: o.seqNo });
                    toast('Ордер отменён');
                    await myOrders(box, haveName);
                } catch (e) {
                    toast(e.message);
                    cancel.disabled = false;
                }
            });
        }
        return el('div', { class: 'list-item' },
            el('div', { class: 'grow' },
                el('div', { class: 'title' }, `${fmt(o.amount)} ${names.get(o.have)} → ${fmt(o.wantAmount)} ${names.get(o.want)}`),
                el('div', { class: 'sub' }, `№${o.seqNo} · ${o.status}${o.left !== null && o.active ? ' · осталось ' + fmt(o.left) : ''}`)),
            cancel);
    })));
}

export default {
    title: 'Биржа',
    async render(params) {
        const have = Number(params[0]) || 1;
        const want = Number(params[1]) || 2;
        const [haveName, wantName] = await Promise.all([resolveAssetName(have), resolveAssetName(want)]);

        const pair = form([el('div', { class: 'grid-2' },
            field('Актив', input('have', { inputmode: 'numeric', value: String(have) })),
            field('За актив', input('want', { inputmode: 'numeric', value: String(want) })))],
        'Открыть пару', async (d) => {
            if (!/^\d+$/.test(d.have) || !/^\d+$/.test(d.want) || d.have === d.want) throw new Error('Укажите два разных номера активов');
            location.hash = `#/exchange/${d.have}/${d.want}`;
        });

        const book = el('div', { class: 'stack' }, spinner());
        const trades = el('div', {});
        const mine = el('div', {});
        const loadBook = async () => {
            try {
                const data = await get(`exchange/${have}/${want}`);
                book.replaceChildren(
                    el('div', { class: 'small muted' }, 'Продают'), el('div', { class: 'scroll-x' }, bookTable(data.sell, haveName, wantName, 'sell')),
                    el('div', { class: 'small muted' }, 'Покупают'), el('div', { class: 'scroll-x' }, bookTable(data.buy, haveName, wantName, 'buy')));
                trades.replaceChildren(data.trades.length
                    ? el('table', { class: 'data' }, el('tr', {}, el('th', {}, 'Время'), el('th', { class: 'right' }, 'Цена'), el('th', { class: 'right' }, 'Кол-во')),
                        data.trades.map((t) => el('tr', {}, el('td', { class: 'small' }, date(t.timestamp)),
                            el('td', { class: 'right num ' + (t.side === 'sell' ? 'out' : 'in') }, fmt(t.price)), el('td', { class: 'right num' }, fmt(t.amount)))))
                    : empty('Сделок пока не было'));
            } catch (e) {
                book.replaceChildren(el('p', { class: 'error' }, e.message));
            }
        };
        const refresh = () => {
            loadBook();
            myOrders(mine, haveName);
        };
        refresh();

        const trade = el('div', {}, orderForm('buy', have, want, haveName, wantName, refresh));
        return el('div', { class: 'stack' },
            card(el('h2', {}, `${haveName} / ${wantName}`), pair),
            card(tabs([['buy', 'Купить'], ['sell', 'Продать']], 'buy', (k) => trade.replaceChildren(orderForm(k, have, want, haveName, wantName, refresh))), trade),
            card(el('h2', {}, 'Стакан заявок'), book),
            card(el('h2', {}, 'Последние сделки'), el('div', { class: 'scroll-x' }, trades)),
            card(el('h2', {}, 'Мои ордера'), mine));
    },
};
