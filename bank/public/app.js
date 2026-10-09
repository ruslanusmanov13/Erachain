'use strict';

const $ = (id) => document.getElementById(id);
const state = { token: null, accounts: [], current: null };

try { state.token = sessionStorage.getItem('bankToken'); } catch (e) { /* хранилище недоступно */ }

async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch('/api/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({ error: 'Некорректный ответ сервера' }));
    if (res.status === 401 && path !== 'login') {
        setToken(null);
        show('login');
    }
    if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
}

function setToken(token) {
    state.token = token;
    try {
        if (token) sessionStorage.setItem('bankToken', token);
        else sessionStorage.removeItem('bankToken');
    } catch (e) { /* ignore */ }
}

function show(view) {
    $('loginView').classList.toggle('hidden', view !== 'login');
    $('dashView').classList.toggle('hidden', view !== 'dash');
    $('logoutBtn').classList.toggle('hidden', view !== 'dash');
}

function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c);
    return node;
}

function fmt(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return String(amount);
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function short(address) {
    return address ? address.slice(0, 8) + '…' + address.slice(-6) : '—';
}

function balanceOf(account, assetKey) {
    const b = account.balances.find((x) => x.asset === assetKey);
    return b ? b.amount : '0';
}

async function refreshStatus() {
    try {
        const s = await api('GET', 'status');
        const mode = s.mode === 'demo' ? 'демо-режим' : 'нода ' + s.node;
        $('status').textContent = `${mode} · блок ${s.height.toLocaleString('ru-RU')}`;
    } catch (e) {
        $('status').textContent = e.message;
    }
}

async function loadAccounts(keepCurrent = true) {
    state.accounts = await api('GET', 'accounts');
    if (!keepCurrent || !state.accounts.some((a) => a.address === state.current)) {
        state.current = state.accounts[0] ? state.accounts[0].address : null;
    }
    renderAccounts();
    await selectAccount(state.current);
}

function renderAccounts() {
    const list = $('accountList');
    list.replaceChildren();
    const totals = new Map();
    for (const acc of state.accounts) {
        for (const b of acc.balances) totals.set(b.name, (totals.get(b.name) || 0) + Number(b.amount));
        const li = el('li', { 'data-address': acc.address },
            el('div', { class: 'addr' }, short(acc.address)),
            el('div', { class: 'bal' }, fmt(balanceOf(acc, 1)) + ' ERA'),
            el('div', { class: 'muted small' }, fmt(balanceOf(acc, 2)) + ' COMPU'));
        if (acc.address === state.current) li.classList.add('active');
        li.addEventListener('click', () => selectAccount(acc.address));
        list.append(li);
    }
    $('total').textContent = totals.size
        ? 'Всего: ' + [...totals].map(([n, v]) => fmt(v) + ' ' + n).join(' · ')
        : 'В кошельке нет счетов';
}

async function selectAccount(address) {
    state.current = address;
    for (const li of $('accountList').children) li.classList.toggle('active', li.dataset.address === address);
    const acc = state.accounts.find((a) => a.address === address);
    $('currentAddress').textContent = address || '—';

    const balances = $('currentBalances');
    balances.replaceChildren();
    const select = $('assetSelect');
    select.replaceChildren();
    const shown = acc && acc.balances.length ? acc.balances : [{ asset: 1, name: 'ERA', amount: '0' }, { asset: 2, name: 'COMPU', amount: '0' }];
    for (const b of shown) {
        balances.append(el('div', {}, el('div', { class: 'muted small' }, b.name), el('div', { class: 'amount' }, fmt(b.amount))));
        select.append(el('option', { value: String(b.asset) }, `${b.name} (доступно ${fmt(b.amount)})`));
    }
    if (address) await loadHistory(address);
}

async function loadHistory(address) {
    const body = $('historyBody');
    body.replaceChildren();
    let txs = [];
    try {
        txs = await api('GET', `accounts/${encodeURIComponent(address)}/history?limit=50`);
    } catch (e) {
        toast(e.message);
    }
    if (address !== state.current) return;
    $('historyEmpty').classList.toggle('hidden', txs.length > 0);
    for (const tx of txs) {
        const incoming = tx.direction === 'in';
        const date = tx.timestamp ? new Date(tx.timestamp).toLocaleString('ru-RU') : '—';
        const what = el('td', {}, tx.title || (incoming ? 'Поступление' : tx.amount ? 'Перевод' : tx.type));
        if (tx.message) what.append(el('div', { class: 'muted small' }, tx.message));
        if (!tx.confirmations) what.append(el('div', { class: 'muted small' }, 'ожидает подтверждения'));
        const sum = tx.amount
            ? (incoming ? '+' : '−') + fmt(tx.amount) + ' ' + (tx.assetName || '#' + tx.asset)
            : '';
        body.append(el('tr', {},
            el('td', { class: 'small' }, date),
            what,
            el('td', { class: 'cp' }, incoming ? (tx.from || '') : (tx.to || '')),
            el('td', { class: 'sum ' + (incoming ? 'in' : 'out') }, sum)));
    }
}

function confirmTransfer(text) {
    const dialog = $('confirmDialog');
    $('confirmText').textContent = text;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

$('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button');
    $('loginError').textContent = '';
    btn.disabled = true;
    try {
        const { token } = await api('POST', 'login', { password: form.password.value });
        form.reset();
        setToken(token);
        show('dash');
        await loadAccounts(false);
    } catch (err) {
        $('loginError').textContent = err.message;
    } finally {
        btn.disabled = false;
    }
});

$('logoutBtn').addEventListener('click', async () => {
    try { await api('POST', 'logout'); } catch (e) { /* ignore */ }
    setToken(null);
    state.accounts = [];
    show('login');
});

$('newAccountBtn').addEventListener('click', async () => {
    try {
        const { address } = await api('POST', 'accounts');
        state.current = address;
        await loadAccounts(true);
        toast('Открыт новый счёт ' + short(address));
    } catch (e) {
        toast(e.message);
    }
});

$('copyBtn').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(state.current);
        toast('Адрес скопирован');
    } catch (e) {
        toast('Не удалось скопировать');
    }
});

for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
        for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
        for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('hidden', p.id !== 'tab-' + tab.dataset.tab);
    });
}

$('transferForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type=submit]');
    $('transferError').textContent = '';
    const payload = {
        from: state.current,
        to: form.to.value.trim(),
        amount: form.amount.value.trim().replace(',', '.'),
        asset: Number(form.asset.value),
        title: form.title.value.trim(),
        message: form.message.value.trim(),
    };
    const assetName = form.asset.selectedOptions[0].textContent.split(' ')[0];
    const ok = await confirmTransfer(`Перевести ${fmt(payload.amount)} ${assetName} со счёта ${short(payload.from)} на ${payload.to}?`);
    if (!ok) return;
    btn.disabled = true;
    try {
        await api('POST', 'transfer', payload);
        form.reset();
        toast('Перевод отправлен в сеть');
        await loadAccounts(true);
        document.querySelector('.tab[data-tab=history]').click();
    } catch (err) {
        $('transferError').textContent = err.message;
    } finally {
        btn.disabled = false;
    }
});

(async function init() {
    await refreshStatus();
    setInterval(refreshStatus, 30000);
    if (state.token) {
        try {
            show('dash');
            await loadAccounts(false);
            return;
        } catch (e) { /* сессия устарела */ }
    }
    show('login');
})();
