// Точка входа: маршрутизация по #/раздел, вход в кошелёк, настройка адреса сервера.
import { get, post, session, setUnauthorizedHandler, needsServer, isNative, serverUrl, setServerUrl } from './api.js';
import { $, el, card, field, input, form, toast, spinner, confirm } from './ui.js';
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

const views = { home, transfer, history, assets, polls, exchange, swap, staff: staffView, sbp, messages, documents, persons, catalog, bank, network, more, settings };
// разделы, доступные из «Сервисов», подсвечивают эту вкладку
const navOf = { history: 'home', sbp: 'bank', swap: 'more', staff: 'more', polls: 'more', exchange: 'more', messages: 'more', documents: 'more', persons: 'more', catalog: 'more', network: 'more', settings: 'more' };

let renderId = 0;

function parseRoute() {
    const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
    return { name: views[name] ? name : 'home', params: rest.map(decodeURIComponent) };
}

async function render() {
    const id = ++renderId;
    const view = $('view');
    if (needsServer()) return showServerSetup();
    if (!session.token) return showLogin();
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
        if (id === renderId) view.replaceChildren(node);
    } catch (e) {
        if (id === renderId && session.token) view.replaceChildren(card(el('p', { class: 'error' }, e.message), el('button', { class: 'btn', onclick: render }, 'Повторить')));
    }
    window.scrollTo(0, 0);
}

function showLogin() {
    $('nav').classList.add('hidden');
    $('pageTitle').textContent = 'Банк Erachain';
    const f = form([
        field('Логин сотрудника', input('login', { autocomplete: 'username', autocapitalize: 'none', placeholder: 'Пусто — вход владельца' }),
            'Владелец входит без логина, паролем кошелька ноды'),
        field('Пароль', input('password', { type: 'password', autocomplete: 'current-password', required: true })),
    ], 'Войти', async (data, formEl) => {
        const { token } = await post('login', { login: data.login.trim() || undefined, password: data.password });
        formEl.reset();
        session.setToken(token);
        state.accounts = [];
        state.me = null;
        if (!location.hash || location.hash === '#/') location.hash = '#/home';
        else render();
    });
    $('view').replaceChildren(el('div', { class: 'login-wrap' },
        card(
            el('h2', {}, 'Вход'),
            el('p', { class: 'muted small' }, 'Ключи хранятся в кошельке ноды Erachain. Пароль передаётся только серверу банка и не сохраняется на устройстве.'),
            f,
        ),
        isNative() ? el('p', { class: 'center small muted' }, 'Сервер: ' + serverUrl() + ' · ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); setServerUrl(null); render(); } }, 'изменить')) : null,
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
    const shift = me.user.role === 'owner' ? '' : me.shift.open ? ' · смена открыта' : ' · смена закрыта';
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
    showLogin();
});

window.addEventListener('hashchange', render);
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
