import { get, post } from '../api.js';
import { el, card, field, input, form, tabs, fmt, short, kv, empty, spinner, toast } from '../ui.js';
import { accountSelect, resolveAssetName } from '../state.js';
import { txResult, personalNote } from './common.js';

function list() {
    const box = el('div', { class: 'list' });
    const more = el('button', { class: 'btn block hidden', type: 'button' }, 'Показать ещё');
    let next = 0;
    const load = async () => {
        try {
            const page = await get('polls' + (next ? '?from=' + next : ''));
            for (const p of page.items) {
                box.append(el('a', { class: 'list-item clickable', href: '#/polls/' + p.key },
                    el('div', { class: 'icon-circle' }, '✓'),
                    el('div', { class: 'grow' }, el('div', { class: 'title' }, p.name), el('div', { class: 'sub' }, `№${p.key} · автор ${short(p.maker)}`))));
            }
            next = page.next;
            more.classList.toggle('hidden', !next || !page.items.length);
            if (!box.children.length) box.append(empty('Голосований пока нет'));
        } catch (e) {
            toast(e.message);
        }
    };
    more.addEventListener('click', load);
    load();
    return card(box, more);
}

function create() {
    const options = el('div', { class: 'stack' });
    const addOption = (value = '') => options.append(input('option', { placeholder: `Вариант ${options.children.length + 1}`, value, maxlength: 250 }));
    addOption('За');
    addOption('Против');
    return card(form([
        personalNote(),
        field('От счёта', accountSelect('creator')),
        field('Вопрос (не короче 12 символов)', input('name', { required: true, maxlength: 250, placeholder: 'Утверждение годового бюджета' })),
        field('Описание', el('textarea', { name: 'description', rows: 3, maxlength: 4000 })),
        el('div', {}, el('div', { class: 'small muted' }, 'Варианты ответа'), options),
        el('button', { class: 'btn small', type: 'button', onclick: () => addOption() }, '+ Вариант'),
    ], 'Создать голосование', async (d, f) => {
        const opts = [...f.querySelectorAll('input[name=option]')].map((i) => i.value.trim()).filter(Boolean);
        const r = await post('polls', { creator: d.creator, name: d.name, description: d.description, options: opts });
        f.reset();
        txResult('Голосование создано', r);
    }));
}

async function details(key) {
    const assetBox = el('select', { name: 'asset' },
        el('option', { value: '1' }, 'по ERA'), el('option', { value: '2' }, 'по COMPU'));
    const results = el('div', { class: 'stack' });
    let poll;
    const draw = async () => {
        results.replaceChildren(spinner());
        poll = await get(`polls/${key}?asset=${assetBox.value}`);
        const assetLabel = await resolveAssetName(poll.resultsAsset);
        const total = Number(poll.votesTotal) || 0;
        results.replaceChildren(...poll.options.map((o) => {
            const share = total ? Number(o.votes) / total : 0;
            const bar = el('span', {});
            bar.style.width = (share * 100).toFixed(1) + '%';
            return el('div', { class: 'stack' },
                el('div', { class: 'row between' }, el('b', {}, o.name), el('span', { class: 'small muted num' }, `${(share * 100).toFixed(1)}%`)),
                el('div', { class: 'bar' }, bar),
                el('div', { class: 'tiny muted num' }, `${fmt(o.votes)} ${assetLabel}`, o.persons !== null ? ` · персон: ${o.persons}` : ''));
        }));
    };
    assetBox.addEventListener('change', draw);
    await draw();

    const voteForm = form([
        field('Голосовать от счёта', accountSelect('voter')),
        field('Ваш выбор', el('select', { name: 'option' }, poll.options.map((o) => el('option', { value: String(o.option) }, o.name)))),
        el('p', { class: 'tiny muted' }, 'Вес голоса — баланс счёта в выбранном активе. Голос можно изменить, отправив новый.'),
    ], 'Проголосовать', async (d) => {
        const r = await post(`polls/${key}/vote`, { voter: d.voter, option: Number(d.option) });
        txResult('Голос отправлен', r);
    }, { confirm: (d) => `Отдать голос за «${poll.options[Number(d.option)].name}»?` });

    return el('div', { class: 'stack' },
        card(el('h2', {}, poll.name), poll.description ? el('p', { class: 'small pre-line' }, poll.description) : null,
            kv([['Номер', poll.key], ['Автор', poll.maker ? el('span', { class: 'mono small' }, poll.maker) : null], ['Проголосовало персон', poll.personsTotal]])),
        card(el('div', { class: 'row between' }, el('h2', {}, 'Результаты'), assetBox), results),
        card(el('h2', {}, 'Голосовать'), voteForm));
}

export default {
    title: 'Голосования',
    async render(params) {
        if (params[0] && /^\d+$/.test(params[0])) return details(params[0]);
        const mode = params[0] === 'create' ? 'create' : 'list';
        const body = el('div', {}, mode === 'create' ? create() : list());
        return el('div', {}, tabs([['list', 'Голосования'], ['create', 'Создать']], mode, (k) => body.replaceChildren(k === 'create' ? create() : list())), body);
    },
};
