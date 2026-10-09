// Точка входа: маршрутизация по #/раздел, вход в кошелёк, настройка адреса сервера.
import { get, post, session, setUnauthorizedHandler, needsServer, isNative, serverUrl, setServerUrl } from './api.js';
import { $, el, card, field, input, form, toast, spinner, confirm, tabs } from './ui.js';
import { setupWizard, seedInput, registerView } from './seed.js';
import { state, loadAccounts, loadMe } from './state.js';
import home from './views/home.js';
import transfer from './views/transfer.js';
import history from './views/history.js';
import assets from './views/assets.js';
import polls from './views/polls.js';
import exchange from './views/exchange.js';
import messages from './views/messages.js';
import documents from './views/documents.js';
import persons from './views/persons.js';
import catalog from './views/catalog.js';
import bank from './views/bank.js';
import network from './views/network.js';
import more from './views/more.js';
import settings from './views/settings.js';
import swap from './views/swap.js';
import staffView from './views/staff.js';
import sbp from './views/sbp.js';
import invoices from './views/invoices.js';
import loans from './views/loans.js';
import keys from './views/keys.js';

const views = { keys, home, transfer, history, assets, polls, exchange, swap, staff: staffView, sbp, invoices, loans, messages, documents, persons, catalog, bank, network, more, settings };
// разделы, доступные из «Сервисов», подсвечивают эту вкладку
const navOf = { keys: 'more', history: 'home', sbp: 'bank', invoices: 'bank', loans: 'bank', swap: 'more', staff: 'more', polls: 'more', exchange: 'more', messages: 'more', documents: 'more', persons: 'more', catalog: 'more', network: 'more', settings: 'more' };

let renderId = 0;

function parseRoute() {
    const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
    return { name: views[name] ? name : 'home', params: rest.map(decodeURIComponent) };
}

async function render() {
    const id = ++renderId;
    const view = $('view');
    if (needsServer()) return showServerSetup();
    if (!session.token) return showEntry();
    $('nav').classList.remove('hidden');
    const { name, params } = parseRoute();
    for (const a of $('nav').querySelectorAll('a')) a.classList.toggle('active', a.dataset.nav === (navOf[name] || name));
    const v = views[name];
    $('pageTitle').textContent = v.title;
    view.replaceChildren(spinner());
    try {
        if (!state.me) {
            await loadMe();
            refreshStatus();
        }
        showUser();
        // без открытой смены сотрудник не видит кошелёк — разделы покажут причину
        if (!state.accounts.length) await loadAccounts().catch((e) => { if (e.status !== 423) throw e; });
        const node = await v.render(params);
        if (id === renderId) view.replaceChildren(...[cabinetBar(name), node].filter(Boolean));
    } catch (e) {
        if (id === renderId && session.token) view.replaceChildren(card(el('p', { class: 'error' }, e.message), el('button', { class: 'btn', onclick: render }, 'Повторить')));
    }
    window.scrollTo(0, 0);
}

// плашка кабинета: владелец вошёл в счёт №n (или это вход по ключу одного счёта)
function cabinetBar(name) {
    const me = state.me;
    if (!me || !me.active || name === 'keys') return null;
    const acc = state.accounts.find((a) => a.address === me.active);
    const label = `Кабинет счёта${acc && acc.n ? ' №' + acc.n : ''} · ${me.active.slice(0, 6)}…${me.active.slice(-4)}`;
    return el('div', { class: 'cabinet-bar' }, el('span', {}, label),
        me.user.role === 'owner' ? el('a', { href: '#/keys' }, 'Сменить') : null);
}

function loggedIn(token, hash = '#/home') {
    loginTab = 'login'; // после выхода — снова экран входа
    session.setToken(token);
    state.accounts = [];
    state.me = null;
    if (location.hash === hash) render();
    else location.hash = hash;
}

// какой вход показывать: мастер первого запуска (на ноде нет кошелька) или обычный вход
async function showEntry() {
    $('nav').classList.add('hidden');
    $('pageTitle').textContent = 'Банк Erachain';
    $('view').replaceChildren(spinner());
    let setup = { walletExists: true, seedLogin: false };
    try {
        setup = await get('setup');
    } catch (e) { /* старый сервер без мастера — обычный вход */ }
    if (session.token) return;
    if (!setup.walletExists) {
        $('pageTitle').textContent = 'Новый банк';
        $('view').replaceChildren(setupWizard(setup, loggedIn), serverLine());
    } else {
        showLogin(setup);
    }
}

const serverLine = () => (isNative() ? el('p', { class: 'center small muted' }, 'Сервер: ' + serverUrl() + ' · ',
    el('a', { href: '#', onclick: (e) => { e.preventDefault(); setServerUrl(null); render(); } }, 'изменить')) : '');

let loginTab = 'login';
let loginMethod = 'seed';

function showLogin(setup) {
    $('nav').classList.add('hidden');
    $('pageTitle').textContent = 'Банк Erachain';
    const body = el('div', {});
    const methodBody = el('div', {});
    const seedForm = (byPassword) => {
        const f = form([
            byPassword
                ? field('Пароль кошелька ноды', input('password', { type: 'password', autocomplete: 'current-password', required: true }))
                : field('Сид-фраза', seedInput('seed', { autofocus: true }), 'Откроются 21 счёт с приватными ключами — выберите любой для входа в кабинет'),
        ], 'Войти', async (data, formEl) => {
            const r = await post('login', byPassword ? { password: data.password } : { seed: data.seed });
            formEl.reset();
            loggedIn(r.token, r.keys ? '#/keys' : '#/home');
        });
        const toggle = el('a', { href: '#', class: 'small' }, byPassword ? 'Войти сид-фразой' : 'Владелец: войти паролем кошелька');
        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            methodBody.replaceChildren(...seedForm(!byPassword));
        });
        return [
            el('p', { class: 'muted small' }, byPassword
                ? 'Запасной вход владельца банка. Пароль передаётся только серверу банка и не сохраняется на устройстве.'
                : 'Владелец банка и клиенты входят своей сид-фразой — 44 символа Base58. Фраза нигде не сохраняется.'),
            f,
            el('p', { class: 'center' }, toggle),
        ];
    };
    const staffForm = () => [
        el('p', { class: 'muted small' }, 'Логин и пароль выдаёт владелец или администратор банка. Права зависят от роли.'),
        form([
            field('Логин', input('login', { autocomplete: 'username', autocapitalize: 'none', required: true })),
            field('Пароль', input('password', { type: 'password', autocomplete: 'current-password', required: true })),
        ], 'Войти', async (data, formEl) => {
            const { token } = await post('login', { login: data.login.trim(), password: data.password });
            formEl.reset();
            loggedIn(token);
        }),
    ];
    const keyForm = () => [
        el('p', { class: 'muted small' }, 'Приватный ключ одного счёта открывает кабинет только этого счёта: остатки, переводы, документы, голосования.'),
        form([
            field('Приватный ключ счёта', seedInput('key', { placeholder: '44 символа Base58' }), 'Ключ есть в файле счёта. Он нигде не сохраняется'),
        ], 'Войти в кабинет', async (data, formEl) => {
            const { token } = await post('login', { key: data.key });
            formEl.reset();
            loggedIn(token);
        }),
    ];
    const showMethod = (k) => {
        loginMethod = k;
        methodBody.replaceChildren(...(k === 'staff' ? staffForm() : k === 'key' ? keyForm() : seedForm(false)));
    };
    const show = (k) => {
        loginTab = k;
        if (k === 'register') {
            body.replaceChildren(registerView(loggedIn));
            return;
        }
        showMethod(loginMethod);
        body.replaceChildren(el('div', { class: 'tabs-sub' },
            tabs([['seed', 'Сид-фраза'], ['key', 'Ключ счёта'], ['staff', 'Сотрудник']], loginMethod, showMethod)), methodBody);
    };
    show(loginTab);
    $('view').replaceChildren(el('div', { class: 'login-wrap' },
        card(tabs([['login', 'Вход'], ['register', 'Регистрация']], loginTab, show), body),
        serverLine(),
    ));
}

function showServerSetup() {
    $('nav').classList.add('hidden');
    $('pageTitle').textContent = 'Подключение';
    const f = form([
        field('Адрес сервера банка', input('url', { type: 'url', placeholder: 'https://bank.example.ru:8080', required: true, value: serverUrl() }),
            'Сервер банка (папка bank/ в репозитории) должен быть запущен рядом с вашей нодой Erachain'),
    ], 'Подключиться', async (data) => {
        let url = data.url.trim();
        if (!/^https?:\/\//.test(url)) url = 'https://' + url;
        if (url.startsWith('http://') && !/^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/.test(url)
            && !(await confirm('Адрес без HTTPS: пароль кошелька будет передаваться в открытом виде. Продолжить?'))) return;
        setServerUrl(url);
        try {
            await get('status');
        } catch (e) {
            setServerUrl(null);
            throw e;
        }
        toast('Сервер подключён');
        render();
    });
    $('view').replaceChildren(el('div', { class: 'login-wrap' }, card(el('h2', {}, 'Сервер банка'), f)));
}

function showUser() {
    const me = state.me;
    if (!me) return;
    const shift = ['owner', 'account', 'client'].includes(me.user.role) ? '' : me.shift.open ? ' · смена открыта' : ' · смена закрыта';
    $('status').dataset.user = `${me.user.name} (${me.role.toLowerCase()})${shift}`;
    $('status').title = $('status').dataset.user;
}

async function refreshStatus() {
    if (needsServer()) return;
    try {
        const s = await get('status');
        state.status = s;
        $('status').textContent = (s.mode === 'demo' ? 'демо · ' : '') + 'блок ' + Number(s.height).toLocaleString('ru-RU')
            + (state.me ? ' · ' + state.me.user.name : '');
    } catch (e) {
        $('status').textContent = 'нет связи';
    }
}

setUnauthorizedHandler(() => {
    state.accounts = [];
    state.me = null;
    showEntry();
});

window.addEventListener('hashchange', render);
window.addEventListener('bank:user', () => { showUser(); refreshStatus(); });
window.addEventListener('bank:logout', async () => {
    try { await post('logout'); } catch (e) { /* ignore */ }
    session.setToken(null);
    state.accounts = [];
    state.me = null;
    render();
});

refreshStatus();
setInterval(refreshStatus, 30000);
render();
