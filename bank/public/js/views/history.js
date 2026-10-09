import { get } from '../api.js';
import { el, card, field, empty, spinner } from '../ui.js';
import { state, setCurrent, accountSelect } from '../state.js';
import { txItem } from './common.js';

export default {
    title: 'История операций',
    async render() {
        const list = card(spinner());
        const filter = el('select', { name: 'kind' },
            el('option', { value: 'all' }, 'Все операции'),
            el('option', { value: 'in' }, 'Поступления'),
            el('option', { value: 'out' }, 'Списания'),
            el('option', { value: 'other' }, 'Прочие (документы, ордера…)'));
        let txs = [];
        const draw = () => {
            const k = filter.value;
            const shown = txs.filter((t) => k === 'all' || (k === 'other' ? !t.amount : t.amount && t.direction === k));
            list.replaceChildren(shown.length ? el('div', { class: 'list' }, shown.map(txItem)) : empty('Операций нет'));
        };
        const load = async () => {
            list.replaceChildren(spinner());
            try {
                txs = await get(`accounts/${state.current}/history?limit=200`);
                draw();
            } catch (e) {
                list.replaceChildren(el('p', { class: 'error' }, e.message));
            }
        };
        filter.addEventListener('change', draw);
        load();
        return el('div', { class: 'stack' },
            card(el('div', { class: 'grid-2' },
                field('Счёт', accountSelect('account', state.current, (a) => { setCurrent(a); load(); })),
                field('Показать', filter)),
                el('a', { class: 'btn block soft', href: '#/bank/statements' }, 'Выгрузить выписку (1С, CSV, ISO 20022)')),
            list);
    },
};
