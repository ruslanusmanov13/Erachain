import { get, post } from '../api.js';
import { el, card, field, input, select, form, tabs, short, kv, empty, spinner, toast, pickFile, photoToBase64 } from '../ui.js';
import { accountSelect } from '../state.js';
import { txResult } from './common.js';

function list() {
    const box = el('div', { class: 'list' });
    const more = el('button', { class: 'btn block hidden', type: 'button' }, 'Показать ещё');
    let next = 0;
    const load = async () => {
        try {
            const page = await get('persons' + (next ? '?from=' + next : ''));
            for (const p of page.items) {
                box.append(el('a', { class: 'list-item clickable', href: '#/persons/' + p.key },
                    el('div', { class: 'icon-circle' }, (p.name || '?').slice(0, 1)),
                    el('div', { class: 'grow' }, el('div', { class: 'title' }, p.name), el('div', { class: 'sub' }, `№${p.key} · зарегистрировал ${short(p.maker)}`))));
            }
            next = page.next;
            more.classList.toggle('hidden', !next || !page.items.length);
            if (!box.children.length) box.append(empty('Персон пока нет'));
        } catch (e) {
            toast(e.message);
        }
    };
    more.addEventListener('click', load);
    load();
    const search = form([field('Найти персону по номеру', input('key', { inputmode: 'numeric' }))], 'Открыть', async (d) => {
        if (!/^\d+$/.test(d.key.trim())) throw new Error('Введите номер');
        location.hash = '#/persons/' + d.key.trim();
    });
    return el('div', { class: 'stack' }, card(search), card(box, more));
}

function register() {
    let photo = '';
    const preview = el('img', { class: 'hidden', alt: 'Фото', width: '96', height: '96' });
    const photoBtn = el('button', { class: 'btn small', type: 'button' }, 'Выбрать фото');
    photoBtn.addEventListener('click', async () => {
        const f = await pickFile('image/*');
        if (!f) return;
        try {
            photo = await photoToBase64(f);
            preview.src = 'data:image/jpeg;base64,' + photo;
            preview.classList.remove('hidden');
            photoBtn.textContent = `Фото: ${Math.round(photo.length * 3 / 4 / 1024)} КБ — заменить`;
        } catch (e) {
            toast(e.message);
        }
    });
    return card(form([
        el('p', { class: 'small muted' }, 'Персона — запись о человеке в блокчейне (ФИО, дата рождения, фото). После регистрации её удостоверяют: привязывают к ней счёт (публичный ключ). Персонализированный счёт может выпускать активы и голосования.'),
        field('Регистратор (ваш счёт)', accountSelect('creator')),
        field('ФИО', input('name', { required: true, maxlength: 250, placeholder: 'Иванов Иван Иванович' })),
        el('div', { class: 'grid-2' },
            field('Дата рождения', input('birthday', { type: 'date', required: true })),
            field('Пол', select('gender', [{ value: 0, label: 'мужской' }, { value: 1, label: 'женский' }, { value: 2, label: 'не указан' }], 0))),
        field('Рост, см', input('height', { type: 'number', min: 40, max: 260, value: '175' })),
        field('Описание', el('textarea', { name: 'description', rows: 2, maxlength: 4000 })),
        field('Публичный ключ владельца', input('owner', { placeholder: 'Необязательно: если пусто — ключ регистратора', spellcheck: 'false' })),
        el('div', { class: 'row' }, preview, photoBtn),
    ], 'Зарегистрировать персону', async (d, f) => {
        if (!photo) throw new Error('Добавьте фотографию');
        const r = await post('persons', { ...d, gender: Number(d.gender), height: Number(d.height), image64: photo });
        f.reset();
        photo = '';
        preview.classList.add('hidden');
        txResult('Персона зарегистрирована', r);
    }));
}

function certify() {
    return card(form([
        el('p', { class: 'small muted' }, 'Удостоверение привязывает публичный ключ (счёт) к персоне. Удостоверять может только персонализированный счёт; в основной сети — нотариус или уполномоченный регистратор.'),
        field('Удостоверяющий счёт', accountSelect('creator')),
        field('Номер персоны', input('person', { inputmode: 'numeric', required: true })),
        field('Публичный ключ', input('pubkey', { required: true, spellcheck: 'false', placeholder: 'Base58, 44 символа' })),
        field('Срок, дней', input('days', { type: 'number', min: 1, value: '365' })),
    ], 'Удостоверить', async (d, f) => {
        const r = await post('persons/certify', { creator: d.creator, person: Number(d.person), pubkey: d.pubkey.trim(), days: Number(d.days) });
        f.reset();
        txResult('Ключ удостоверен', r);
    }));
}

async function details(key) {
    const p = await get('persons/' + key);
    const genders = ['мужской', 'женский', 'не указан'];
    return card(el('h2', {}, p.name), kv([
        ['Номер', p.key],
        ['Дата рождения', p.birthday ? new Date(p.birthday).toLocaleDateString('ru-RU') : null],
        ['Пол', genders[p.gender] || null],
        ['Рост', p.height ? p.height + ' см' : null],
        ['Зарегистрировал', p.maker ? el('span', { class: 'mono small' }, p.maker) : null],
        ['Транзакция', p.seqNo],
        ['Удостоверенные ключи', p.accounts && p.accounts.length ? p.accounts.join(', ') : null],
    ]), p.description ? el('p', { class: 'small pre-line' }, p.description) : null);
}

export default {
    title: 'Персоны',
    async render(params) {
        if (params[0] && /^\d+$/.test(params[0])) return details(params[0]);
        const views = { list, register, certify };
        const mode = views[params[0]] ? params[0] : 'list';
        const body = el('div', {}, spinner());
        body.replaceChildren(views[mode]());
        return el('div', {}, tabs([['list', 'Реестр'], ['register', 'Регистрация'], ['certify', 'Удостоверение']], mode, (k) => body.replaceChildren(views[k]())), body);
    },
};
