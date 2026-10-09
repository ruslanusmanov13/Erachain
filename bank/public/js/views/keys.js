// 21 счёт сид-фразы: приватные ключи и вход в кабинет любого счёта.
import { get, post } from '../api.js';
import { el, card, fmt, toast, openDialog, closeDialog, empty } from '../ui.js';
import { state, loadAccounts, loadMe, setCurrent, balanceOf } from '../state.js';
import { seedBox, fileButtons } from '../seed.js';

export async function enterCabinet(address) {
    await post('session/account', { address });
    state.accounts = [];
    await loadMe();
    await loadAccounts();
    if (address) setCurrent(address);
    window.dispatchEvent(new Event('bank:user'));
}

function keyDialog(k) {
    openDialog(
        el('h3', {}, `Приватный ключ счёта №${k.n}`),
        el('p', { class: 'small mono' }, k.address),
        seedBox(k.privateKey),
        el('div', { class: 'warn-box' }, 'Кто знает ключ, тот распоряжается этим счётом. По ключу можно войти в кабинет только этого счёта или импортировать его в кошелёк Erachain.'),
        el('button', { class: 'btn primary block', type: 'button', onclick: closeDialog }, 'Скрыть'));
}

export default {
    title: 'Ключи и кабинеты',
    async render() {
        // список всех счетов — выходим из кабинета
        if (state.me && state.me.active) await enterCabinet(null);
        const [keys, accounts] = await Promise.all([get('keys').catch((e) => (e.status === 409 ? null : Promise.reject(e))), loadAccounts()]);
        const byAddress = new Map(accounts.map((a) => [a.address, a]));
        const rows = keys || accounts.filter((a) => a.n).sort((x, y) => x.n - y.n).map((a) => ({ n: a.n, address: a.address }));

        const client = state.me && state.me.user.role === 'client';
        const all = el('button', { class: 'btn block', type: 'button' }, client ? 'Все мои счета (без кабинета)' : 'Все счета банка (без кабинета)');
        all.addEventListener('click', async () => { location.hash = '#/home'; });

        const list = rows.length ? el('div', { class: 'list' }, rows.map((k) => {
            const acc = byAddress.get(k.address);
            const enter = el('button', { class: 'btn primary small', type: 'button' }, 'Войти');
            enter.addEventListener('click', async () => {
                enter.disabled = true;
                try {
                    await enterCabinet(k.address);
                    toast(`Кабинет счёта №${k.n}`);
                    location.hash = '#/home';
                } catch (e) {
                    toast(e.message);
                    enter.disabled = false;
                }
            });
            const show = k.privateKey ? el('button', { class: 'btn small', type: 'button', onclick: () => keyDialog(k) }, 'Ключ') : null;
            return el('div', { class: 'list-item key-row' },
                el('div', { class: 'icon-circle' }, String(k.n)),
                el('div', { class: 'grow' },
                    el('div', { class: 'title mono small' }, k.address),
                    el('div', { class: 'sub num' }, acc ? `${fmt(balanceOf(acc, 1), 4)} ERA · ${fmt(balanceOf(acc, 2), 4)} COMPU` : 'нет в кошельке ноды')),
                el('div', { class: 'row' }, show, enter));
        })) : empty('Счета сид-фразы появятся после входа по сид-фразе');

        return el('div', { class: 'stack' },
            card(
                el('h2', {}, `${rows.length || 21} ${(rows.length || 21) % 10 === 1 && (rows.length || 21) % 100 !== 11 ? 'счёт' : 'счетов'} сид-фразы`),
                el('p', { class: 'small muted' }, keys
                    ? 'Из сид-фразы получены 21 счёт с приватными ключами (стандарт Erachain). Выберите счёт, чтобы войти в его кабинет, или откройте ключ, чтобы выдать доступ к одному счёту.'
                    : 'Приватные ключи показываются только после входа по сид-фразе. Войти в кабинет любого счёта можно и сейчас.'),
                all),
            keys ? card(el('h3', {}, 'Файл с ключами'), el('p', { class: 'small muted' }, '21 адрес и приватный ключ — для резервной копии или импорта в кошелёк Erachain. Сид-фраза в файл не входит: банк её не хранит.'),
                fileButtons({ keys, name: state.me ? state.me.user.name : '' }, { copyLabel: 'Копировать' })) : null,
            card(list));
    },
};
