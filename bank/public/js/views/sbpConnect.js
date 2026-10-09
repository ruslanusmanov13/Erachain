// Подключение к СБП «Точки» из админки: клиент → юрлицо → счёт → торговая точка (ТСП) → включение.
import { get, post } from '../api.js';
import { el, card, field, input, select, form, kv, date, toast, badge, confirm } from '../ui.js';

const STEPS = [['customer', 'Клиент «Точки»'], ['legal', 'Юрлицо в СБП'], ['account', 'Счёт'], ['merchant', 'Торговая точка'], ['activate', 'Включение'], ['done', 'Готово']];

export async function connectView() {
    const s = await get('sbp/onboarding');
    const box = el('div', { class: 'stack' });
    const reload = async () => box.replaceWith(await connectView());
    const step = (path, body, msg) => async () => {
        await post('sbp/onboarding/' + path, body);
        toast(msg);
        reload();
    };
    const at = STEPS.findIndex(([k]) => k === s.step);
    box.append(card(
        el('h2', {}, 'Подключение к СБП'),
        el('p', { class: 'small muted' }, 'Регистрация банка как торговой точки в СБП через банк «Точка». Токен API задаётся на сервере (TOCHKA_SBP_TOKEN) и здесь не нужен.'),
        el('div', { class: 'row wrap' }, STEPS.map(([k, label], i) => badge(`${i + 1}. ${label}`, i < at ? 'ok' : i === at ? 'warn' : ''))),
        s.active ? kv([['Приём платежей', 'включён'], ['ТСП', s.active.merchantId], ['Счёт', s.active.account], ['БИК', s.active.bik]]) : null));

    if (s.step === 'customer' || s.step === 'legal') {
        box.append(card(form([
            el('h3', {}, '1. Клиент «Точки»'),
            field('Код клиента (customerCode)', input('customerCode', { inputmode: 'numeric', value: s.customerCode || '' }), 'Есть в интернет-банке «Точки» и в API open-banking'),
            field('БИК банка', input('bankCode', { inputmode: 'numeric', value: s.bankCode || '044525104' })),
        ], 'Найти', async (d) => {
            await post('sbp/onboarding/customer', d);
            reload();
        }), s.customer ? kv([['Организация', s.customer.name], ['ИНН', s.customer.inn]]) : null,
        s.step === 'legal' ? el('button', { class: 'btn primary block', type: 'button', onclick: step('legal', {}, 'Юрлицо зарегистрировано в СБП') }, '2. Зарегистрировать юрлицо в СБП') : null));
    }
    if (s.step === 'account') {
        const accs = (s.accounts || []).map((a) => ({ value: a.accountCode, label: `${a.accountCode}${a.status ? ' · ' + a.status : ''}` }));
        box.append(card(form([
            el('h3', {}, '3. Счёт для зачисления оплат'),
            kv([['legalId', s.legalId]]),
            field('Счёт', select('accountCode', accs, accs[0] && accs[0].value)),
        ], 'Выбрать счёт', async (d) => {
            await post('sbp/onboarding/account', d);
            reload();
        })));
    }
    if (s.step === 'merchant') {
        box.append(card(form([
            el('h3', {}, '4. Торговая точка (ТСП)'),
            field('Название (видит плательщик)', input('brandName', { value: 'Банк Erachain' })),
            field('Адрес', input('address', { placeholder: 'ул. Тверская, 1' })),
            el('div', { class: 'grid-2' }, field('Город', input('city', { value: 'Москва' })), field('Индекс', input('zipCode', { inputmode: 'numeric' }))),
            el('div', { class: 'grid-2' }, field('Код региона (ОКАТО)', input('region', { inputmode: 'numeric', value: '45' })), field('MCC', input('mcc', { inputmode: 'numeric', value: '6012' }))),
            field('Телефон', input('phone', { type: 'tel', placeholder: '+7 900 123-45-67' })),
        ], 'Зарегистрировать ТСП', async (d) => {
            await post('sbp/onboarding/merchant', d);
            toast('ТСП зарегистрирована');
            reload();
        }), (s.merchants || []).length ? el('div', { class: 'stack' }, el('p', { class: 'small muted' }, 'Или выберите уже зарегистрированную ТСП:'),
            ...s.merchants.map((m) => el('button', { class: 'btn soft block', type: 'button', onclick: step('use-merchant', { merchantId: m.merchantId }, 'ТСП выбрана') }, `${m.merchantId} · ${m.brandName || ''} · ${m.status || ''}`))) : null));
    }
    if (s.step === 'activate') {
        box.append(card(el('h3', {}, '5. Включение'), kv([['ТСП', s.merchantId], ['Счёт', s.account]]),
            el('button', { class: 'btn primary block', type: 'button', onclick: step('activate', {}, 'Приём платежей по СБП включён') }, 'Включить приём платежей')));
    }
    if (s.step === 'done') {
        box.append(card(el('p', {}, '✓ Банк принимает платежи по СБП через ТСП ' + s.merchantId),
            el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
                if (await confirm('Приостановить ТСП в СБП? Новые QR-коды перестанут оплачиваться.')) step('suspend', {}, 'ТСП приостановлена')();
            } }, 'Приостановить ТСП')));
    }
    box.append(card(el('h3', {}, 'Журнал подключения'), el('div', { class: 'list' }, (s.log || []).map((x) => el('div', { class: 'list-item' },
        el('div', { class: 'grow' }, el('div', { class: 'small' }, x.text), el('div', { class: 'tiny muted' }, date(x.at)))))),
    el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
        if (await confirm('Начать подключение заново? Действующие реквизиты приёма не меняются, пока не включите новые.')) step('reset', {}, 'Мастер начат заново')();
    } }, 'Начать заново')));
    return box;
}
