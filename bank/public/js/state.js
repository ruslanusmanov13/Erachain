// Общее состояние: счета кошелька, выбранный счёт, справочник имён активов.
import { get } from './api.js';
import { el, short, fmt } from './ui.js';

export const state = {
    accounts: [],
    current: null,
    assetNames: new Map([[1, 'ERA'], [2, 'COMPU']]),
    status: null,
};

try { state.current = localStorage.getItem('currentAccount'); } catch (e) { /* ignore */ }

export async function loadAccounts() {
    state.accounts = await get('accounts');
    for (const a of state.accounts) for (const b of a.balances) state.assetNames.set(b.asset, b.name);
    if (!state.accounts.some((a) => a.address === state.current)) setCurrent(state.accounts[0] ? state.accounts[0].address : null);
    return state.accounts;
}

export function setCurrent(address) {
    state.current = address;
    try { localStorage.setItem('currentAccount', address || ''); } catch (e) { /* ignore */ }
}

export function currentAccount() {
    return state.accounts.find((a) => a.address === state.current) || null;
}

export function balanceOf(account, asset) {
    const b = account && account.balances.find((x) => x.asset === Number(asset));
    return b ? b.amount : '0';
}

export function assetName(key) {
    return state.assetNames.get(Number(key)) || '#' + key;
}

export async function resolveAssetName(key) {
    key = Number(key);
    if (state.assetNames.has(key)) return state.assetNames.get(key);
    try {
        const a = await get('assets/' + key);
        state.assetNames.set(key, a.name);
        return a.name;
    } catch (e) {
        return '#' + key;
    }
}

// Выпадающий список счетов кошелька
export function accountSelect(name = 'account', value = state.current, onChange) {
    const s = el('select', { name });
    for (const a of state.accounts) {
        const opt = el('option', { value: a.address }, `${short(a.address)} · ${fmt(balanceOf(a, 1))} ERA`);
        if (a.address === value) opt.selected = true;
        s.append(opt);
    }
    if (onChange) s.addEventListener('change', () => onChange(s.value));
    return s;
}

// Список активов, которые есть на счёте (+ ERA и COMPU)
export function assetSelect(name, account, value = 1) {
    const s = el('select', { name });
    const seen = new Set();
    const items = [...(account ? account.balances : []), { asset: 1, name: 'ERA', amount: '0' }, { asset: 2, name: 'COMPU', amount: '0' }];
    for (const b of items) {
        if (seen.has(b.asset)) continue;
        seen.add(b.asset);
        const opt = el('option', { value: String(b.asset) }, `${b.name} — доступно ${fmt(balanceOf(account, b.asset))}`);
        if (b.asset === Number(value)) opt.selected = true;
        s.append(opt);
    }
    return s;
}
