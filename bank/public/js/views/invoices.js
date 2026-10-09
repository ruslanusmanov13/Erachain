import { get, post, put } from '../api.js';
import { el, card, field, input, select, form, tabs, fmt, short, date, kv, empty, spinner, toast, badge, confirm, openDialog, closeDialog } from '../ui.js';
import { accountSelect, can, loadAccounts } from '../state.js';

const CURRS = [{ value: 643, label: 'RUB (643)' }, { value: 840, label: 'USD (840)' }, { value: 978, label: 'EUR (978)' }, { value: 1, label: 'ERA (актив 1)' }, { value: 2, label: 'COMPU (актив 2)' }];
const ISSUED = {
    issued: ['ждёт оплаты', 'warn'], pending: ['ждёт подтверждения в сети', 'warn'], partial: ['оплачен частично', 'warn'], paid: ['оплачен', 'ok'],
    untrusted: ['оплата от недоверенного банка', 'bad'], wrong_asset: ['оплата не той валютой', 'bad'], late: ['оплачен после срока', 'bad'],
};

let lastUser = '';

function payDialog(inv, reload) {
    const needAmount = inv.sum === null;
    const body = [
        el('h3', {}, inv.title || 'Счёт ' + inv.order),
        kv([
            ['Заказ', inv.order], ['Сумма', needAmount ? 'любая (пополнение)' : `${fmt(inv.sum, 2)} ${inv.currName}`],
            ['Магазин', el('span', { class: 'mono small' }, inv.shop)], ['Покупатель', inv.user],
            ['Назначение', inv.description], ['Реквизиты', inv.details], ['Выставлен', date(inv.date)], ['Действует до', date(inv.expiresAt)],
        ]),
    ];
    if (inv.paid && ['paid', 'sent'].includes(inv.paid.status)) {
        body.push(inv.paid.status === 'paid' ? badge('оплачен ' + date(inv.paid.paidAt), 'ok') : badge('перевод отправлен, ждёт подтверждения', 'warn'),
            el('p', { class: 'tiny mono' }, inv.paid.txId));
    } else if (inv.expired) {
        body.push(el('p', { class: 'note' }, 'Срок счёта истёк — попросите магазин выставить новый.'));
    } else if (can('sign')) {
        body.push(form([
            field('Оплатить со счёта', accountSelect('from')),
            needAmount ? field(`Сумма, ${inv.currName}`, input('amount', { inputmode: 'decimal', required: true })) : null,
            el('p', { class: 'tiny muted' }, 'Магазин получит перевод с уведомлением об оплате в блокчейне и будет оповещён по адресу обратного вызова.'),
        ], `Оплатить${needAmount ? '' : ' ' + fmt(inv.sum, 2) + ' ' + inv.currName}`, async (d) => {
            const r = await post('invoices/pay', { signature: inv.signature, user: inv.user, from: d.from, amount: d.amount });
            await loadAccounts();
            openDialog(el('h3', {}, r.status === 'paid' ? 'Счёт оплачен' : 'Перевод отправлен'), kv([
                ['Сумма', `${fmt(r.amount, 2)} ${inv.currName}`], ['Транзакция', el('span', { class: 'mono tiny' }, r.txId)],
                ['Магазин', r.callbackUrl ? 'будет оповещён, когда перевод подтвердится в сети' : 'узнает об оплате из блокчейна'],
            ]), el('button', { class: 'btn primary', type: 'button', onclick: () => { closeDialog(); reload(); } }, 'Готово'));
        }, { confirm: (d) => `Оплатить счёт ${inv.order} магазину ${short(inv.shop)} на ${needAmount ? d.amount : fmt(inv.sum, 2)} ${inv.currName}?` }));
    }
    body.push(el('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Закрыть'));
    openDialog(...body);
}

async function payView() {
    const results = el('div', {});
    const search = async (user) => {
        lastUser = user;
        results.replaceChildren(spinner());
        try {
            const list = await post('invoices/find', { user });
            results.replaceChildren(list.length ? card(el('div', { class: 'list' }, list.map((inv) => {
                const state = inv.paid && inv.paid.status === 'paid' ? badge('оплачен', 'ok') : inv.paid && inv.paid.status === 'sent' ? badge('подтверждается', 'warn')
                    : inv.expired ? badge('истёк') : badge('к оплате', 'warn');
                const item = el('div', { class: 'list-item clickable' },
                    el('div', { class: 'icon-circle' }, '₽'),
                    el('div', { class: 'grow' }, el('div', { class: 'title' }, inv.title || inv.order),
                        el('div', { class: 'sub' }, `${inv.order} · ${date(inv.date)} · магазин ${short(inv.shop)}`)),
                    el('div', { class: 'right' }, el('b', { class: 'num' }, inv.sum === null ? 'любая' : fmt(inv.sum, 2) + ' ' + inv.currName), el('br'), state));
                item.addEventListener('click', () => payDialog(inv, () => search(user)));
                return item;
            }))) : card(empty('Счетов для этого клиента нет')));
        } catch (e) {
            results.replaceChildren(card(el('p', { class: 'error' }, e.message)));
        }
    };
    const f = form([
        el('p', { class: 'small muted' }, 'Магазины выставляют счета на ID покупателя — телефон, e-mail или адрес Erachain. Найдите счета клиента и оплатите их.'),
        field('ID клиента', input('user', { required: true, value: lastUser, placeholder: '79001234567', inputmode: 'tel' })),
    ], 'Найти счета', async (d) => search(d.user.trim()));
    if (lastUser) search(lastUser);
    return el('div', { class: 'stack' }, card(f), results);
}

async function issueView() {
    const s = await get('invoices/settings');
    return card(form([
        el('p', { class: 'small muted' }, 'Счёт отправляется телеграммой в банк покупателя. После оплаты в блокчейн придёт уведомление — проверьте его во вкладке «Выставленные».'),
        field('Счёт магазина (получатель денег)', accountSelect('from')),
        field('Счёт-канал банка покупателя', input('channel', { value: s.channel, spellcheck: 'false', placeholder: 'Адрес Erachain банка' })),
        field('ID покупателя', input('user', { required: true, placeholder: 'Телефон, e-mail или адрес Erachain' })),
        el('div', { class: 'grid-2' },
            field('Номер заказа', input('order', { placeholder: 'Например, ZK-1043' })),
            field('Срок, минут', input('expire', { type: 'number', min: 1, value: '1440' }))),
        el('div', { class: 'grid-2' },
            field('Сумма', input('sum', { inputmode: 'decimal', placeholder: 'Пусто — любая' })),
            field('Валюта', select('curr', CURRS, 643))),
        field('Заголовок (виден покупателю)', input('title', { maxlength: 120, placeholder: 'Оплата заказа в магазине' })),
        field('Назначение / НДС', input('description', { maxlength: 300, value: 'Без НДС' })),
        field('Адрес обратного вызова (https)', input('callback', { placeholder: 'https://shop.ru/erachain/callback?signature=' })),
    ], 'Выставить счёт', async (d, f) => {
        const r = await post('invoices/issue', { ...d, curr: Number(d.curr) });
        f.reset();
        toast('Счёт ' + r.order + ' отправлен');
    }));
}

async function issuedView() {
    const list = await get('invoices/issued');
    const box = el('div', { class: 'stack' });
    const check = el('button', { class: 'btn soft block', type: 'button' }, 'Проверить оплаты');
    check.addEventListener('click', async () => {
        check.disabled = true;
        try {
            const r = await post('invoices/check');
            toast(r.updated ? `Новых уведомлений: ${r.updated}` : 'Новых оплат нет');
            box.replaceWith(await issuedView());
        } catch (e) {
            toast(e.message);
            check.disabled = false;
        }
    });
    box.append(card(check), list.length ? card(el('div', { class: 'list' }, list.map((inv) => {
        const [label, kind] = ISSUED[inv.status] || [inv.status, ''];
        return el('div', { class: 'list-item' }, el('div', { class: 'grow stack' },
            el('div', { class: 'row between' }, el('b', {}, `${inv.order} · ${inv.sum === null ? 'любая сумма' : fmt(inv.sum, 2)}`), badge(label, kind)),
            el('div', { class: 'tiny muted' }, `${date(inv.createdAt)} · покупатель ${inv.user}${inv.paidSum ? ' · получено ' + fmt(inv.paidSum, 2) : ''}`),
            ...inv.notices.map((n) => {
                const problem = !n.trusted ? 'банк не в списке доверенных' : n.assetOk === false ? 'не та валюта' : n.late ? 'после срока счёта'
                    : n.noticeSum !== null && n.noticeSum !== undefined && n.noticeSum > (n.amount ?? n.sum) ? `в уведомлении ${fmt(n.noticeSum, 2)} — засчитан фактический перевод` : '';
                const conf = (n.confirmations ?? 1) > 0 ? '' : ' · ждёт подтверждения';
                return el('div', { class: 'tiny ' + (n.trusted && n.assetOk !== false && !n.late ? 'in' : 'out') },
                    `${problem ? '⚠' : '✓'} ${fmt(n.amount ?? n.sum, 2)} от ${short(n.from)}${conf}${problem ? ' — ' + problem : ''}`);
            })));
    }))) : card(empty('Вы ещё не выставляли счета')));
    return box;
}

async function settingsView() {
    const s = await get('invoices/settings');
    const curr = Object.entries(s.currencies).map(([iso, asset]) => `${iso}=${asset}`).join(', ');
    return card(form([
        el('h2', {}, 'Настройки счетов'),
        field('Счёт-канал этого банка', input('channel', { value: s.channel, spellcheck: 'false' }), 'Сюда магазины присылают счета для ваших клиентов'),
        field('Валюты → активы Erachain', input('currencies', { value: curr }), 'ISO-код=номер актива через запятую, например 643=1048'),
        field('Доверенные банки (уведомлениям от них магазин верит)', el('textarea', { name: 'trusted', rows: 3, spellcheck: 'false' }, s.trustedBanks.join('\n'))),
        field('Подтверждений сети для зачёта оплаты', input('minConfirmations', { type: 'number', min: 0, max: 100, value: String(s.minConfirmations ?? 1) }),
            'Блок Erachain — около 5 минут. 0 — засчитывать сразу (не рекомендуется)'),
    ], 'Сохранить', async (d) => {
        const currencies = {};
        for (const pair of d.currencies.split(',').map((x) => x.trim()).filter(Boolean)) {
            const [iso, asset] = pair.split('=').map((x) => x.trim());
            currencies[iso] = asset;
        }
        await put('invoices/settings', { channel: d.channel.trim(), currencies, trustedBanks: d.trusted.split(/[\s,;]+/).filter(Boolean), minConfirmations: Number(d.minConfirmations) });
        toast('Сохранено');
    }));
}

export default {
    title: 'Счета на оплату',
    async render(params) {
        const views = { pay: payView, issue: issueView, issued: issuedView, settings: settingsView };
        const mode = views[params[0]] ? params[0] : 'pay';
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
        const items = [['pay', 'Оплатить'], ['issue', 'Выставить'], ['issued', 'Выставленные']];
        if (can('settings')) items.push(['settings', 'Настройки']);
        return el('div', {}, tabs(items, mode, show), body);
    },
};
