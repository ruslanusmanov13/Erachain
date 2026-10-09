import { get, post, put, isNative, serverUrl } from '../api.js';
import { el, card, field, input, tabs, fmt, short, date, kv, empty, spinner, toast, copy, badge, form, qrCode, openDialog, closeDialog } from '../ui.js';
import { state, accountSelect, can } from '../state.js';

const KIND = {
    SBP_ACTIVE: 'warn', SBP_DONE: 'warn', ERA_QUEUE: 'warn', ERA_SENDING: 'warn', ERA_SEND: 'warn', ERA_DONE: 'ok',
    EXPIRED: '', FAIL_MAKE: 'bad', FAIL_SBP: 'bad', FAIL_RATE: 'bad', FAIL_ERA: 'bad',
};

const payLink = () => (isNative() ? serverUrl() : location.origin) + '/pay.html';

function orderDialog(o, demo, reload) {
    const qrBox = el('div', {});
    if (o.status === 'SBP_ACTIVE' && o.payload) {
        if (o.image && o.image.content) qrBox.append(el('img', { class: 'qr', src: `data:${o.image.mediaType || 'image/png'};base64,${o.image.content}`, alt: 'QR-код СБП', width: '220', height: '220' }));
        else qrCode(o.payload, 220).then((svg) => qrBox.append(svg));
    }
    const actions = el('div', { class: 'row wrap end' });
    if (o.status === 'SBP_ACTIVE' && demo) {
        actions.append(el('button', { class: 'btn', type: 'button', onclick: async () => { await post(`sbp/orders/${o.id}/emulate`); await post('sbp/check'); closeDialog(); reload(); } }, 'Оплатить (демо)'));
    }
    if (['FAIL_ERA', 'FAIL_RATE'].includes(o.status) && can('gateway')) {
        actions.append(el('button', { class: 'btn soft', type: 'button', onclick: async () => { try { await post(`sbp/orders/${o.id}/retry`); toast('Поставлено в очередь'); closeDialog(); reload(); } catch (e) { toast(e.message); } } }, 'Повторить начисление'));
    }
    actions.append(el('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, 'Закрыть'));
    openDialog(
        el('h3', {}, `${fmt(o.amountRub, 2)} ₽ → ${fmt(o.amountChain)} ${o.assetName}`),
        badge(o.statusText, KIND[o.status] || ''),
        qrBox,
        kv([
            ['Получатель', el('span', { class: 'mono small' }, o.receiver)],
            ['Курс', `${fmt(o.rubPerUnit, 2)} ₽ за 1 ${o.assetName}`],
            ['Создан', `${date(o.createdAt)} · ${o.source === 'office' ? 'в отделении, ' + (o.createdBy || '') : 'на странице оплаты'}`],
            ['QR (СБП)', o.qrcId ? el('span', { class: 'mono tiny' }, o.qrcId) : null],
            ['Операция СБП', o.trxIdSbp ? el('span', { class: 'mono tiny' }, o.trxIdSbp) : null],
            ['Транзакция Erachain', o.txId ? el('span', { class: 'mono tiny' }, o.txId) : null],
            ['Подтверждений', o.confirmations || null],
            ['Сообщение', o.message],
        ]),
        o.payload && o.status === 'SBP_ACTIVE' ? el('button', { class: 'btn block', type: 'button', onclick: () => copy(o.payload, 'Ссылка на оплату скопирована') }, 'Копировать ссылку на оплату') : null,
        actions);
}

async function ordersView() {
    const [{ orders, stats }, settings] = await Promise.all([get('sbp/orders'), get('sbp/settings')]);
    const demo = settings.mode === 'demo';
    const box = el('div', { class: 'stack' });
    const reload = async () => box.replaceWith(await ordersView());
    const tiles = el('div', { class: 'grid-2' },
        card(el('div', { class: 'tiny muted' }, 'Оплачено по СБП'), el('div', { class: 'big-num num' }, fmt(stats.paidRub, 2) + ' ₽')),
        card(el('div', { class: 'tiny muted' }, 'Начислено в Erachain'), el('div', { class: 'big-num num' }, fmt(stats.creditedRub, 2) + ' ₽')));
    const notes = [];
    if (stats.queue) notes.push(el('p', { class: 'note' }, `В очереди на начисление: ${stats.queue}. Начисление идёт автоматически, пока открыта смена.`));
    if (stats.failed) notes.push(el('p', { class: 'note' }, `С ошибками: ${stats.failed} — откройте заказ, чтобы разобрать.`));
    const check = el('button', { class: 'btn small', type: 'button' }, 'Проверить оплаты сейчас');
    check.addEventListener('click', async () => {
        check.disabled = true;
        try { await post('sbp/check'); await reload(); } catch (e) { toast(e.message); check.disabled = false; }
    });
    box.append(tiles, ...notes,
        card(el('div', { class: 'row between' }, el('h2', {}, 'Заказы'), can('gateway') ? check : null),
            orders.length ? el('div', { class: 'list' }, orders.map((o) => {
                const item = el('div', { class: 'list-item clickable' },
                    el('div', { class: 'icon-circle ' + (o.status === 'ERA_DONE' ? 'in' : o.status.startsWith('FAIL') ? 'out' : '') }, '₽'),
                    el('div', { class: 'grow' },
                        el('div', { class: 'title num' }, `${fmt(o.amountRub, 2)} ₽ → ${fmt(o.amountChain)} ${o.assetName}`),
                        el('div', { class: 'sub' }, `${date(o.createdAt)} · ${short(o.receiver)}${o.message ? ' · ' + o.message : ''}`)),
                    badge(o.statusText, KIND[o.status] || ''));
                item.addEventListener('click', () => orderDialog(o, demo, reload));
                return item;
            })) : empty('Платежей пока нет')));
    return box;
}

async function newQrView() {
    const cfg = await get('sbp/settings');
    const assetSel = el('select', { name: 'asset' }, cfg.assets.map((a) => el('option', { value: String(a.asset) }, `${a.name} — ${fmt(a.rubPerUnit, 2)} ₽ за 1`)));
    const own = state.accounts.length ? accountSelect('own') : null;
    return card(form([
        el('p', { class: 'small muted' }, 'Клиент в отделении оплачивает по QR-коду со своего телефона — актив придёт на указанный счёт.'),
        field('Счёт клиента', input('receiver', { placeholder: 'Адрес Erachain клиента', spellcheck: 'false', required: true })),
        own ? el('p', { class: 'tiny muted' }, 'Или выберите свой счёт для проверки: ', own) : null,
        el('div', { class: 'grid-2' }, field('Сумма, ₽', input('amount', { inputmode: 'decimal', placeholder: String(cfg.minRub), required: true })), field('Актив', assetSel)),
    ], 'Создать QR-код', async (d) => {
        const receiver = d.receiver.trim() || (own ? own.value : '');
        const o = await post('sbp/orders', { receiver, amount: d.amount, asset: Number(d.asset) });
        orderDialog(o, cfg.mode === 'demo', () => {});
    }));
}

async function settingsView() {
    const s = await get('sbp/settings');
    const rows = el('div', { class: 'stack' });
    const addRow = (a = { asset: '', name: '', rubPerUnit: '', scale: 2 }) => rows.append(el('div', { class: 'grid-2 sbp-asset' },
        field('Актив №', input('asset', { inputmode: 'numeric', value: String(a.asset) })),
        field('Название', input('name', { value: a.name })),
        field('₽ за 1 единицу', input('rubPerUnit', { inputmode: 'decimal', value: String(a.rubPerUnit) })),
        field('Знаков', input('scale', { type: 'number', min: 0, max: 8, value: String(a.scale) }))));
    s.assets.forEach(addRow);
    const link = payLink();
    const linkQr = el('div', {});
    qrCode(link, 160).then((svg) => linkQr.append(svg));
    return el('div', { class: 'stack' },
        card(el('h2', {}, 'Страница оплаты для клиентов'),
            el('p', { class: 'small muted' }, 'Разместите ссылку на сайте или распечатайте QR — клиенты оплатят без входа в банк. Можно передать параметры: ?to=АДРЕС&amount=СУММА&asset=НОМЕР.'),
            el('p', { class: 'mono small' }, link), linkQr,
            el('button', { class: 'btn', type: 'button', onclick: () => copy(link, 'Ссылка скопирована') }, 'Копировать ссылку'),
            kv([['Банк', s.mode === 'demo' ? 'эмулятор (демо)' : s.mode === 'prod' ? '«Точка», боевой режим' : '«Точка», песочница']])),
        card(form([
            el('h2', {}, 'Настройки приёма'),
            el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'enabled', value: '1', checked: s.enabled }), 'Принимать платежи'),
            field('Счёт выплат (с него начисляются активы)', accountSelect('payoutAccount', s.payoutAccount)),
            field('Назначение платежа в СБП', input('purpose', { value: s.purpose, maxlength: 140 })),
            el('div', { class: 'grid-2' },
                field('Минимум, ₽', input('minRub', { inputmode: 'decimal', value: String(s.minRub) })),
                field('Срок QR, минут', input('ttlMinutes', { type: 'number', min: 1, value: String(s.ttlMinutes) }))),
            field('Адрес возврата после оплаты (https)', input('redirectUrl', { value: s.redirectUrl || '', placeholder: 'https://ваш-сайт.ru/спасибо' })),
            el('h2', {}, 'Активы и курсы'), rows,
            el('button', { class: 'btn small', type: 'button', onclick: () => addRow() }, '+ Актив'),
        ], 'Сохранить', async (d, f) => {
            const assets = [...rows.querySelectorAll('.sbp-asset')].map((r) => ({
                asset: r.querySelector('[name=asset]').value, name: r.querySelector('[name=name]').value,
                rubPerUnit: r.querySelector('[name=rubPerUnit]').value.replace(',', '.'), scale: r.querySelector('[name=scale]').value,
            })).filter((a) => a.asset);
            await put('sbp/settings', {
                enabled: f.querySelector('[name=enabled]').checked, payoutAccount: d.payoutAccount, purpose: d.purpose,
                minRub: d.minRub.replace(',', '.'), ttlMinutes: Number(d.ttlMinutes), redirectUrl: d.redirectUrl, assets,
            });
            toast('Настройки СБП сохранены');
        })),
        card(el('h2', {}, 'Подключение банка «Точка»'), el('p', { class: 'small muted pre-line' },
            'Токен и реквизиты задаются на сервере банка переменными окружения (в интерфейсе не хранятся):\n' +
            'TOCHKA_SBP_TOKEN — токен API «Точки»\nTOCHKA_MERCHANT — ID торговой точки СБП (MF…)\n' +
            'TOCHKA_ACCOUNT — расчётный счёт\nTOCHKA_BIK — БИК\nTOCHKA_MODE — test (песочница) или prod.')));
}

export default {
    title: 'СБП',
    async render(params) {
        const views = { orders: ordersView, qr: newQrView, settings: settingsView };
        const mode = views[params[0]] ? params[0] : 'orders';
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
        const items = [['orders', 'Платежи'], ['qr', 'QR для клиента']];
        if (can('settings')) items.push(['settings', 'Настройки']);
        return el('div', {}, tabs(items, mode, show), body);
    },
};
