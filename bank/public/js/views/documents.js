import { get, post } from '../api.js';
import { el, card, field, input, form, tabs, short, date, spinner, pickFile } from '../ui.js';
import { accountSelect } from '../state.js';
import { fileHash } from '../hash.js';
import { txResult } from './common.js';

function sign() {
    const files = new Map(); // hash -> имя файла
    const fileList = el('div', { class: 'list' });
    const drawFiles = () => {
        fileList.replaceChildren(...[...files].map(([hash, name]) => el('div', { class: 'list-item' },
            el('div', { class: 'grow' }, el('div', { class: 'title' }, name), el('div', { class: 'sub mono' }, hash)),
            el('button', { class: 'btn small', type: 'button', onclick: () => { files.delete(hash); drawFiles(); } }, '✕'))));
    };
    const addFile = el('button', { class: 'btn small', type: 'button' }, '+ Прикрепить файл');
    addFile.addEventListener('click', async () => {
        const f = await pickFile('*/*');
        if (!f) return;
        addFile.disabled = true;
        addFile.textContent = 'Вычисляю хеш…';
        try {
            files.set(await fileHash(f), f.name);
            drawFiles();
        } finally {
            addFile.disabled = false;
            addFile.textContent = '+ Прикрепить файл';
        }
    });
    return card(form([
        el('p', { class: 'small muted' }, 'Документ подписывается ключом счёта и навсегда записывается в блокчейн. Файлы не загружаются в сеть — записывается только их хеш SHA-256, по которому подлинность можно проверить позже.'),
        field('Подписант', accountSelect('creator')),
        field('Название документа', input('title', { required: true, maxlength: 250, placeholder: 'Договор поставки №12 от 01.10.2026' })),
        field('Текст', el('textarea', { name: 'message', rows: 5, maxlength: 20000 })),
        el('div', {}, el('div', { class: 'small muted' }, 'Файлы'), fileList, addFile),
        field('Получатели (адреса через запятую или с новой строки)', el('textarea', { name: 'recipients', rows: 2, spellcheck: 'false' }), 'Необязательно — получатели увидят документ у себя'),
    ], 'Подписать и записать', async (d, f) => {
        const recipients = (d.recipients || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
        const r = await post('documents', { creator: d.creator, title: d.title, message: d.message, hashes: Object.fromEntries(files), recipients });
        f.reset();
        files.clear();
        drawFiles();
        txResult('Документ подписан', r);
    }, { confirm: (d) => `Подписать документ «${d.title}» и записать в блокчейн?${files.size ? `\nФайлов: ${files.size}` : ''}` }));
}

function verify() {
    const result = el('div', {});
    const check = async (hash, name) => {
        result.replaceChildren(spinner());
        try {
            const found = await get('documents/verify/' + hash);
            result.replaceChildren(
                el('p', { class: 'small' }, name ? `Файл: ${name}` : '', el('br'), el('span', { class: 'mono tiny' }, 'SHA-256: ' + hash)),
                found.length
                    ? el('div', { class: 'list' }, found.map((t) => el('div', { class: 'list-item' },
                        el('div', { class: 'icon-circle in' }, '✓'),
                        el('div', { class: 'grow' }, el('div', { class: 'title' }, t.title || t.type),
                            el('div', { class: 'sub' }, `подписал ${short(t.creator)} · ${date(t.timestamp)} · №${t.seqNo || '—'}`)))))
                    : el('p', { class: 'note' }, 'Файл с таким содержимым в блокчейне не найден. Если документ подписан недавно, дождитесь подтверждения блока.'));
        } catch (e) {
            result.replaceChildren(el('p', { class: 'error' }, e.message));
        }
    };
    const pick = el('button', { class: 'btn primary block', type: 'button' }, 'Выбрать файл для проверки');
    pick.addEventListener('click', async () => {
        const f = await pickFile('*/*');
        if (f) check(await fileHash(f), f.name);
    });
    return card(el('p', { class: 'small muted' }, 'Проверьте, что файл не изменён и был удостоверен в блокчейне: хеш файла сравнивается с записанными в сети.'), pick, result);
}

function vouch() {
    return card(form([
        el('p', { class: 'small muted' }, 'Заверение — подпись второй стороны под уже записанной транзакцией: договором, документом, переводом. Укажите номер транзакции (например 1234567-1) — его видно в карточке операции.'),
        field('Заверить со счёта', accountSelect('creator')),
        field('Номер транзакции', input('seqNo', { required: true, placeholder: '1234567-1' })),
    ], 'Заверить', async (d, f) => {
        const r = await post('documents/vouch', { creator: d.creator, seqNo: d.seqNo.trim() });
        f.reset();
        txResult('Транзакция заверена', r);
    }, { confirm: (d) => `Заверить транзакцию ${d.seqNo} своей подписью?` }));
}

export default {
    title: 'Документы',
    async render(params) {
        const views = { sign, verify, vouch };
        const mode = views[params[0]] ? params[0] : 'sign';
        const body = el('div', {}, views[mode]());
        return el('div', {}, tabs([['sign', 'Подписать'], ['verify', 'Проверить'], ['vouch', 'Заверить']], mode, (k) => body.replaceChildren(views[k]())), body);
    },
};

