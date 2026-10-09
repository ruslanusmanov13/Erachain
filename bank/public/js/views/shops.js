// Магазины: счёт продавца, товары (активы Erachain), заказы с выдачей товара после оплаты, контроль COMPU.
import { get, post, patch, api } from '../api.js';
import { el, card, field, input, select, form, tabs, fmt, short, date, kv, empty, spinner, toast, badge, confirm, openDialog, closeDialog } from '../ui.js';
import { can } from '../state.js';

const CURRS = [{ value: 643, label: 'RUB (643)' }, { value: 1, label: 'ERA (актив 1)' }, { value: 2, label: 'COMPU (актив 2)' }, { value: 840, label: 'USD (840)' }, { value: 978, label: 'EUR (978)' }];
const currName = (c) => ({ 643: '₽', 840: 'USD', 978: 'EUR', 1: 'ERA', 2: 'COMPU' }[c] || '#' + c);
const DELIVERY = {
    waiting_payment: ['ждёт оплаты', 'warn'], awaiting_address: ['нужен адрес покупателя', 'bad'], queue: ['в очереди на выдачу', 'warn'],
    made: ['перевод подписан', 'warn'], sent: ['отправлено, ждёт подтверждения', 'warn'], delivered: ['товар выдан', 'ok'],
    expired: ['не оплачен', ''], cancelled: ['отменён', ''], error: ['ошибка выдачи', 'bad'],
};

async function rerender(box, view) {
    box.replaceWith(await view());
}

function productDialog(m, reload) {
    openDialog(el('h3', {}, 'Товар магазина «' + m.name + '»'), form([
        field('Название', input('title', { required: true, placeholder: 'Подписка на месяц' })),
        field('Актив Erachain, который получит покупатель', input('asset', { type: 'number', min: 1, value: '1' }), 'Номер актива; он должен лежать на счёте магазина'),
        field('Сколько актива за 1 шт.', input('amount', { inputmode: 'decimal', value: '1' })),
        field('Цена за 1 шт.', input('price', { inputmode: 'decimal', required: true })),
        field('Валюта цены', select('curr', CURRS, 643)),
    ], 'Добавить товар', async (d) => {
        await post(`merchants/${m.id}/products`, d);
        closeDialog();
        toast('Товар добавлен');
        reload();
    }));
}

function orderDialog(m, reload) {
    openDialog(el('h3', {}, 'Заказ в «' + m.name + '»'),
        el('p', { class: 'small muted' }, 'Покупателю уйдёт счёт на оплату (Безопасный платёж). Когда он будет оплачен, банк сам отправит товар со счёта магазина.'),
        form([
            field('Товар', select('productId', m.products.map((p) => ({ value: p.id, label: `${p.title} — ${fmt(p.price, 2)} ${currName(p.curr)} (на складе ${fmt(p.stock)})` })))),
            field('Количество', input('qty', { type: 'number', min: 1, value: '1' })),
            field('Покупатель', input('user', { placeholder: '+7 900 123-45-67, e-mail или адрес' }), 'По этому ID банк покупателя найдёт счёт'),
            field('Адрес Erachain для товара (необязательно)', input('deliverTo', { spellcheck: 'false' }), 'Если пусто — товар уйдёт на счёт, с которого оплатили'),
            field('Срок оплаты, минут', input('expire', { type: 'number', min: 1, value: '60' })),
        ], 'Выставить счёт', async (d) => {
            const r = await post(`merchants/${m.id}/order`, d);
            closeDialog();
            toast(`Счёт ${r.order} на ${fmt(r.sum, 2)} отправлен покупателю`);
            reload();
        }));
}

async function shopsView() {
    const [list, alerts] = await Promise.all([get('merchants'), get('merchants/alerts').catch(() => [])]);
    const box = el('div', { class: 'stack' });
    const reload = () => rerender(box, shopsView);
    if (alerts.length) {
        box.append(card(el('h3', {}, '⚠ Мало COMPU на комиссии'),
            el('p', { class: 'small muted' }, 'Без COMPU нода не примет перевод: выдача товара и выплаты встанут. Пополните эти счета.'),
            el('div', { class: 'list' }, alerts.map((a) => el('div', { class: 'list-item' }, el('div', { class: 'grow' },
                el('div', { class: 'title' }, a.label), el('div', { class: 'sub mono tiny' }, a.address)),
                badge(`${fmt(a.compu, 4)} / ${fmt(a.min, 4)}`, 'bad'))))));
    }
    for (const m of list) {
        const products = m.products.length ? el('div', { class: 'list' }, m.products.map((p) => el('div', { class: 'list-item' },
            el('div', { class: 'grow' }, el('div', { class: 'title' }, p.title),
                el('div', { class: 'sub' }, `${fmt(p.price, 2)} ${currName(p.curr)} → ${fmt(p.amount)} актива #${p.asset} · на складе ${fmt(p.stock)}`)),
            can('settings') ? el('button', { class: 'btn small', type: 'button', onclick: async () => {
                if (!(await confirm(`Убрать товар «${p.title}»?`))) return;
                await api('DELETE', `merchants/${m.id}/products/${p.id}`);
                reload();
            } }, '✕') : null))) : empty('Товаров пока нет');
        box.append(card(
            el('div', { class: 'row between' }, el('h2', {}, m.name), m.lowCompu ? badge('мало COMPU', 'bad') : m.disabled ? badge('приостановлен', '') : badge('работает', 'ok')),
            kv([
                ['Счёт магазина', el('span', { class: 'mono small' }, (m.n ? `№${m.n} · ` : '') + m.address)],
                ['COMPU на комиссии', `${fmt(m.compu, 4)} (порог ${fmt(m.minCompu, 4)})`],
                ['Заказы', `${m.stats.orders} · выдано ${m.stats.delivered}${m.stats.pending ? ' · в работе ' + m.stats.pending : ''}${m.stats.errors ? ' · ошибок ' + m.stats.errors : ''}`],
            ]),
            products,
            el('div', { class: 'grid-2' },
                can('sign') && m.products.length && !m.disabled ? el('button', { class: 'btn primary block', type: 'button', onclick: () => orderDialog(m, reload) }, 'Новый заказ') : null,
                can('settings') ? el('button', { class: 'btn soft block', type: 'button', onclick: () => productDialog(m, reload) }, '+ Товар') : null,
                can('settings') ? el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
                    const v = prompt('Порог COMPU для предупреждения', String(m.minCompu));
                    if (v === null) return;
                    try {
                        await patch(`merchants/${m.id}`, { minCompu: v });
                        reload();
                    } catch (e) {
                        toast(e.message);
                    }
                } }, 'Порог COMPU') : null,
                can('settings') ? el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
                    await patch(`merchants/${m.id}`, { disabled: !m.disabled });
                    reload();
                } }, m.disabled ? 'Возобновить' : 'Приостановить') : null)));
    }
    if (!list.length) box.append(card(empty('Магазинов пока нет')));
    if (can('settings')) {
        box.append(card(form([
            el('h3', {}, 'Новый магазин'),
            field('Название', input('name', { required: true })),
            field('Счёт магазина (необязательно)', input('address', { spellcheck: 'false' }),
                'Пусто — банк возьмёт следующий свободный счёт сид-фразы (№2…№21, кроме служебных). Можно указать счёт клиента банка.'),
            field('Порог COMPU', input('minCompu', { inputmode: 'decimal', value: '1' })),
        ], 'Создать магазин', async (d) => {
            const m = await post('merchants', d);
            toast(`Магазин создан на счёте ${m.n ? '№' + m.n : short(m.address)}`);
            reload();
        })));
    }
    return box;
}

async function ordersView() {
    const list = await get('merchants/orders');
    const box = el('div', { class: 'stack' });
    const reload = () => rerender(box, ordersView);
    const run = el('button', { class: 'btn soft block', type: 'button' }, 'Проверить оплаты и выдать товар');
    run.addEventListener('click', async () => {
        run.disabled = true;
        try {
            const r = await post('merchants/deliver', {});
            toast(r.delivered.length ? `Выдано заказов: ${r.delivered.length}` : 'Обработано');
            reload();
        } catch (e) {
            toast(e.message);
            run.disabled = false;
        }
    });
    if (can('gateway')) box.append(card(run, el('p', { class: 'tiny muted' }, 'При открытой смене банк делает это сам каждые 20 секунд.')));
    box.append(list.length ? card(el('div', { class: 'list' }, list.map((o) => {
        const d = o.deliver;
        const [label, kind] = DELIVERY[d.state] || [d.state, ''];
        const actions = [];
        if (d.state === 'awaiting_address' && can('gateway')) {
            actions.push(el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
                const a = prompt('Адрес Erachain покупателя для выдачи товара');
                if (!a) return;
                try {
                    await post(`merchants/orders/${o.signature}/address`, { address: a.trim() });
                    toast('Адрес сохранён — товар уйдёт при следующей проверке');
                    reload();
                } catch (e) {
                    toast(e.message);
                }
            } }, 'Указать адрес'));
        }
        if (d.state === 'error' && can('gateway')) {
            actions.push(el('button', { class: 'btn small', type: 'button', onclick: async () => {
                try {
                    await post(`merchants/orders/${o.signature}/retry`, {});
                    reload();
                } catch (e) {
                    toast(e.message);
                }
            } }, 'Повторить выдачу'));
        }
        return el('div', { class: 'list-item' }, el('div', { class: 'grow stack' },
            el('div', { class: 'row between' }, el('b', {}, `${o.order} · ${fmt(o.sum, 2)} ${currName(o.curr)}`), badge(label, kind)),
            el('div', { class: 'tiny muted' }, `${date(o.createdAt)} · ${o.title}`),
            el('div', { class: 'tiny' }, `К выдаче ${fmt(d.amount)} актива #${d.asset}${d.to ? ' → ' + short(d.to) : ''} · покупатель ${o.user}`),
            d.message ? el('div', { class: 'tiny out' }, d.message) : null,
            d.txId && d.state === 'delivered' ? el('div', { class: 'tiny mono muted' }, 'перевод ' + short(d.txId)) : null,
            actions.length ? el('div', { class: 'row' }, ...actions) : null));
    }))) : card(empty('Заказов пока нет')));
    return box;
}

export default {
    title: 'Магазины',
    async render(params) {
        const views = { shops: shopsView, orders: ordersView };
        const mode = views[params[0]] ? params[0] : 'shops';
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
        return el('div', { class: 'stack' },
            el('p', { class: 'small muted' }, 'Продавец получает свой счёт в банке. Покупатель оплачивает счёт — банк сам отправляет ему товар (актив Erachain) со счёта магазина.'),
            tabs([['shops', 'Магазины'], ['orders', 'Заказы']], mode, show), body);
    },
};
