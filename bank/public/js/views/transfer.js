import { post } from '../api.js';
import { el, card, field, input, form, tabs, fmt, short, toast, openDialog, closeDialog, kv } from '../ui.js';
import { state, loadAccounts, currentAccount, accountSelect, assetSelect, assetName, setCurrent } from '../state.js';

function singleForm() {
    const acc = currentAccount();
    const assetSel = assetSelect('asset', acc, 1);
    const accSel = accountSelect('from', state.current, (addr) => {
        setCurrent(addr);
        assetSel.replaceWith(assetSelect('asset', currentAccount(), assetSel.value));
    });
    return form([
        field('Со счёта', accSel),
        field('Получатель', input('to', { placeholder: 'Адрес Erachain (начинается с 7)', required: true, spellcheck: 'false' })),
        el('div', { class: 'grid-2' },
            field('Сумма', input('amount', { inputmode: 'decimal', placeholder: '0.00', required: true })),
            field('Актив', assetSel)),
        field('Назначение платежа', input('title', { maxlength: 250, placeholder: 'Например: оплата по счёту №15' })),
        field('Сообщение получателю', el('textarea', { name: 'message', rows: 3, maxlength: 4000 })),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'encrypt', value: '1' }), 'Зашифровать сообщение (прочитает только получатель)'),
        el('p', { class: 'tiny muted' }, 'Комиссия сети списывается в COMPU с вашего счёта. Перевод в блокчейне необратим.'),
    ], 'Перевести', async (d, f) => {
        const r = await post('transfer', {
            from: d.from, to: d.to.trim(), asset: Number(d.asset), amount: d.amount.replace(',', '.'),
            title: d.title, message: d.message, encrypt: d.encrypt === '1',
        });
        f.reset();
        await loadAccounts();
        openDialog(el('h3', {}, 'Перевод отправлен'),
            kv([['Сумма', fmt(r.amount) + ' ' + (r.assetName || assetName(r.asset))], ['Получатель', el('span', { class: 'mono' }, r.to)], ['Подпись', el('span', { class: 'mono tiny' }, r.signature)]]),
            el('div', { class: 'row end' }, el('a', { class: 'btn', href: '#/history', onclick: closeDialog }, 'История'), el('button', { class: 'btn primary', onclick: closeDialog }, 'Готово')));
    }, { confirm: (d) => `Перевести ${fmt(d.amount.replace(',', '.'))} ${assetName(d.asset)}\nсо счёта ${short(d.from)}\nна ${d.to.trim()}?` });
}

// Массовые выплаты (зарплаты, дивиденды, возвраты): строки «адрес; сумма; назначение»
function batchForm() {
    const acc = currentAccount();
    const preview = el('div', { class: 'tiny muted' });
    const textarea = el('textarea', { name: 'list', rows: 8, placeholder: '7Az8r7aH8Z173SRYRoHemQgbGgidorJCaK; 1500; Зарплата за сентябрь\n77Kj7JraVAwaC2sk46en42Kq6GMoM84JpV; 1200.50' });
    const parse = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        // разделитель — «;» или табуляция (запятая в суммах — десятичная); запятая — только если других нет
        const parts = /[;\t]/.test(l) ? l.split(/[;\t]/) : l.split(',');
        const [to, amount, title] = parts.map((x) => (x || '').trim());
        return { to, amount: (amount || '').replace(',', '.'), title };
    });
    textarea.addEventListener('input', () => {
        const rows = parse(textarea.value);
        const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        preview.textContent = rows.length ? `Строк: ${rows.length}, итого: ${fmt(total)}` : '';
    });
    const fileBtn = el('button', { class: 'btn small', type: 'button' }, 'Загрузить CSV');
    fileBtn.addEventListener('click', async () => {
        const { pickFile } = await import('../ui.js');
        const f = await pickFile('.csv,.txt,text/csv,text/plain');
        if (!f) return;
        textarea.value = (await f.text()).replace(/^﻿/, '');
        textarea.dispatchEvent(new Event('input'));
    });
    return form([
        el('p', { class: 'small muted' }, 'Одна строка — одна выплата: адрес; сумма; назначение (необязательно). Подходит для зарплат, дивидендов и возвратов.'),
        field('Со счёта', accountSelect('from', state.current)),
        el('div', { class: 'grid-2' }, field('Актив', assetSelect('asset', acc, 1)), field('Общее назначение', input('title', { placeholder: 'Выплата' }))),
        field('Список выплат', textarea, preview),
        fileBtn,
    ], 'Отправить выплаты', async (d) => {
        const payments = parse(d.list);
        const r = await post('transfer/batch', { from: d.from, asset: Number(d.asset), title: d.title, payments });
        await loadAccounts();
        const table = el('table', { class: 'data' }, el('tr', {}, el('th', {}, 'Получатель'), el('th', { class: 'right' }, 'Сумма'), el('th', {}, 'Результат')));
        for (const x of r.results) {
            table.append(el('tr', {}, el('td', { class: 'mono tiny' }, short(x.to)), el('td', { class: 'right num' }, fmt(x.amount)),
                el('td', { class: x.ok ? 'in small' : 'out small' }, x.ok ? 'отправлено' : x.error)));
        }
        openDialog(el('h3', {}, `Отправлено ${r.sent} из ${r.total}`), el('div', { class: 'scroll-x' }, table),
            el('button', { class: 'btn primary', onclick: closeDialog }, 'Готово'));
        if (r.sent) toast('Выплаты отправлены');
    }, {
        confirm: (d) => {
            const rows = parse(d.list);
            return `Отправить ${rows.length} выплат на сумму ${fmt(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0))} ${assetName(d.asset)}?`;
        },
    });
}

export default {
    title: 'Переводы',
    async render(params) {
        const mode = params[0] === 'batch' ? 'batch' : 'single';
        const body = card(mode === 'batch' ? batchForm() : singleForm());
        return el('div', {},
            tabs([['single', 'Перевод'], ['batch', 'Массовая выплата']], mode, (k) => body.replaceChildren(k === 'batch' ? batchForm() : singleForm())),
            body);
    },
};
