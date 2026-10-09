import { get, post } from '../api.js';
import { el, card, field, input, form, short, date, spinner, toast, tabs } from '../ui.js';
import { state, setCurrent, accountSelect } from '../state.js';

function inbox() {
    const box = card(spinner());
    const load = async () => {
        box.replaceChildren(spinner());
        try {
            const list = await get('messages/' + state.current);
            box.replaceChildren(list.length ? el('div', { class: 'list' }, list.map((m) => el('div', { class: 'list-item' },
                el('div', { class: 'icon-circle ' + (m.direction === 'in' ? 'in' : 'out') }, m.direction === 'in' ? '✉' : '↗'),
                el('div', { class: 'grow' },
                    el('div', { class: 'title' }, m.title || '(без темы)'),
                    el('div', { class: 'small pre-line' }, m.encrypted ? '🔒 зашифровано' : m.message),
                    el('div', { class: 'sub' }, `${m.direction === 'in' ? 'от ' + short(m.from) : 'кому ' + short(m.to)} · ${date(m.timestamp)}`)),
            ))) : el('div', { class: 'empty' }, 'Сообщений нет'));
        } catch (e) {
            box.replaceChildren(el('p', { class: 'error' }, e.message));
        }
    };
    load();
    return el('div', { class: 'stack' },
        card(field('Счёт', accountSelect('account', state.current, (a) => { setCurrent(a); load(); }))),
        box);
}

function compose() {
    return card(form([
        el('p', { class: 'small muted' }, 'Телеграммы — быстрые сообщения между счетами Erachain. Они передаются по сети без записи в блокчейн и хранятся на нодах ограниченное время. Для юридически значимой переписки используйте «Документы».'),
        field('От счёта', accountSelect('from')),
        field('Кому', input('to', { required: true, placeholder: 'Адрес Erachain', spellcheck: 'false' })),
        field('Тема', input('title', { maxlength: 250 })),
        field('Сообщение', el('textarea', { name: 'message', rows: 5, maxlength: 4000 })),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'encrypt', value: '1' }), 'Зашифровать'),
    ], 'Отправить', async (d, f) => {
        await post('messages', { from: d.from, to: d.to.trim(), title: d.title, message: d.message, encrypt: d.encrypt === '1' });
        f.reset();
        toast('Сообщение отправлено');
    }));
}

export default {
    title: 'Сообщения',
    async render(params) {
        const mode = params[0] === 'new' ? 'new' : 'inbox';
        const body = el('div', {}, mode === 'new' ? compose() : inbox());
        return el('div', {}, tabs([['inbox', 'Входящие и отправленные'], ['new', 'Написать']], mode, (k) => body.replaceChildren(k === 'new' ? compose() : inbox())), body);
    },
};

