// Журнал платежей: каждый исходящий перевод банка — кто, откуда, куда, подпись и подтверждение сети.
import { get, post, download } from '../api.js';
import { el, card, field, input, select, form, fmt, short, date, empty, toast, badge } from '../ui.js';
import { state } from '../state.js';

const STATUS = {
    made: ['подписан', 'warn'], sent: ['отправлен', 'warn'], confirmed: ['подтверждён', 'ok'],
    failed: ['не прошёл', 'bad'], lost: ['не попал в сеть', 'bad'], expired: ['истёк, не отправлен', ''],
};
const KIND = { transfer: 'перевод', two_phase: 'выплата (2 фазы)', device: 'с устройства', debt: 'в долг', debt_collect: 'взыскание' };

function query(d) {
    const q = new URLSearchParams();
    for (const k of ['from', 'to', 'status', 'address']) if (d[k]) q.set(k, d[k].trim());
    return q.toString();
}

export default {
    title: 'Журнал платежей',
    async render() {
        const out = el('div', {});
        let last = {};
        const show = async (d) => {
            last = d;
            const list = await get('payments?' + query(d));
            out.replaceChildren(list.length ? card(el('div', { class: 'list' }, list.map((x) => {
                const [label, kind] = STATUS[x.status] || [x.status, ''];
                return el('div', { class: 'list-item' }, el('div', { class: 'grow stack' },
                    el('div', { class: 'row between' }, el('b', { class: 'num' }, `${fmt(x.amount)} ${state.assetNames.get(Number(x.asset)) || '#' + x.asset}`), badge(label, kind)),
                    el('div', { class: 'tiny' }, `${short(x.from)} → ${short(x.to)} · ${KIND[x.kind] || x.kind}${x.title ? ' · ' + x.title : ''}`),
                    el('div', { class: 'tiny muted' }, `${date(x.at)} · ${x.by} · ${x.source}`),
                    x.signature ? el('div', { class: 'tiny mono muted' }, (x.seqNo ? x.seqNo + ' · ' : '') + short(x.signature)) : null,
                    x.error || x.lastError ? el('div', { class: 'tiny out' }, x.error || x.lastError) : null));
            }))) : card(empty('Платежей за период нет')));
        };
        const f = form([
            el('p', { class: 'small muted' }, 'Все исходящие переводы банка из всех разделов: переводы и выплаты, СБП, счета, магазины, кредиты, шлюз, кошельки на устройствах. Подтверждение сетью проверяется автоматически.'),
            el('div', { class: 'grid-2' },
                field('С', input('from', { type: 'date' })),
                field('По', input('to', { type: 'date' }))),
            el('div', { class: 'grid-2' },
                field('Статус', select('status', [{ value: '', label: 'все' }, ...Object.entries(STATUS).map(([value, [label]]) => ({ value, label }))], '')),
                field('Счёт', input('address', { spellcheck: 'false', placeholder: 'любой' }))),
        ], 'Показать', show);
        const csv = el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
            try {
                toast('Сохранён файл ' + (await download('GET', 'payments?format=csv&' + query(last))));
            } catch (e) {
                toast(e.message);
            }
        } }, 'Скачать CSV');
        const check = el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
            await post('payments/check');
            await show(last);
            toast('Подтверждения проверены');
        } }, 'Проверить подтверждения');
        show({});
        return el('div', { class: 'stack' }, card(f, el('div', { class: 'grid-2' }, csv, check)), out);
    },
};
