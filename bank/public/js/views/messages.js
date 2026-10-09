import { get, post } from '../api.js';
import { el, card, field, input, form, short, date, spinner, toast, tabs } from '../ui.js';
import { state, setCurrent, accountSelect } from '../state.js';
import { isWalletRole, sendSigned, decryptTx } from '../wallet/session.js';
import { withDeviceKeys } from '../seed.js';

// кнопка «Расшифровать»: на устройстве — своим ключом, для счетов в кошельке банка — силами ноды
function encryptedBody(m) {
    const box = el('div', { class: 'small pre-line' });
    const b = el('button', { class: 'btn small', type: 'button' }, '🔒 Расшифровать');
    b.addEventListener('click', async () => {
        b.disabled = true;
        try {
            box.textContent = await withDeviceKeys(() => decryptTx(m.signature));
            box.prepend(el('span', { class: 'tiny muted' }, '🔓 '));
        } catch (e) {
            toast(e.message);
            b.disabled = false;
        }
    });
    box.append(b);
    return box;
}

function inbox() {
    const box = card(spinner());
    const load = async () => {
        box.replaceChildren(spinner());
        try {
            let list = await get('messages/' + state.current);
            if (isWalletRole(state.me)) {
                // у кошелька на устройстве сообщения — письма в блокчейне (переводы без суммы)
                const hist = await get(`accounts/${encodeURIComponent(state.current)}/history?limit=100`);
                const letters = hist.filter((t) => !t.amount && (t.message || t.encrypted || t.title)).map((t) => ({
                    signature: t.signature, timestamp: t.timestamp, from: t.from, to: t.to, title: t.title, message: t.message, encrypted: t.encrypted, direction: t.direction,
                }));
                list = [...letters, ...list].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            }
            box.replaceChildren(list.length ? el('div', { class: 'list' }, list.map((m) => el('div', { class: 'list-item' },
                el('div', { class: 'icon-circle ' + (m.direction === 'in' ? 'in' : 'out') }, m.direction === 'in' ? '✉' : '↗'),
                el('div', { class: 'grow' },
                    el('div', { class: 'title' }, m.title || '(без темы)'),
                    m.encrypted ? encryptedBody(m) : el('div', { class: 'small pre-line' }, m.message),
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
    const wallet = isWalletRole(state.me);
    return card(form([
        el('p', { class: 'small muted' }, wallet
            ? 'Письмо подписывается на этом устройстве и записывается в блокчейн (комиссия — в COMPU). Шифрование — тоже на телефоне: прочитает только получатель.'
            : 'Телеграммы — быстрые сообщения между счетами Erachain. Они передаются по сети без записи в блокчейн и хранятся на нодах ограниченное время. Для юридически значимой переписки используйте «Документы».'),
        field('От счёта', accountSelect('from')),
        field('Кому', input('to', { required: true, placeholder: 'Адрес Erachain', spellcheck: 'false' })),
        field('Тема', input('title', { maxlength: 250 })),
        field('Сообщение', el('textarea', { name: 'message', rows: 5, maxlength: 4000 })),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'encrypt', value: '1' }), 'Зашифровать'),
    ], 'Отправить', async (d, f) => {
        if (wallet) {
            await withDeviceKeys(() => sendSigned({ from: d.from, to: d.to.trim(), title: d.title, message: d.message, encrypt: d.encrypt === '1' }));
        } else {
            await post('messages', { from: d.from, to: d.to.trim(), title: d.title, message: d.message, encrypt: d.encrypt === '1' });
        }
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

