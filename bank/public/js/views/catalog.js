import { get } from '../api.js';
import { el, card, tabs, short, empty, spinner } from '../ui.js';

const KINDS = {
    statuses: ['Статусы', 'Статусы присваиваются персонам и счетам: членство, права, роли в организациях.'],
    templates: ['Шаблоны документов', 'Шаблоны используются при подписании типовых документов: договоров, заявлений, доверенностей.'],
};

function listOf(kind) {
    const box = el('div', {}, spinner());
    get('catalog/' + kind).then((page) => {
        box.replaceChildren(page.items.length
            ? el('div', { class: 'list' }, page.items.map((i) => el('div', { class: 'list-item' },
                el('div', { class: 'icon-circle' }, String(i.key)),
                el('div', { class: 'grow' }, el('div', { class: 'title' }, i.name), el('div', { class: 'sub' }, 'создал ' + short(i.maker))))))
            : empty('Пусто'));
    }).catch((e) => box.replaceChildren(el('p', { class: 'error' }, e.message)));
    return card(el('p', { class: 'small muted' }, KINDS[kind][1]), box);
}

export default {
    title: 'Справочники',
    async render(params) {
        const mode = KINDS[params[0]] ? params[0] : 'statuses';
        const body = el('div', {}, listOf(mode));
        return el('div', {}, tabs(Object.entries(KINDS).map(([k, v]) => [k, v[0]]), mode, (k) => body.replaceChildren(listOf(k))), body);
    },
};
