import { get, post } from '../api.js';
import { el, card, fmt, short, toast, copy, share, openDialog, closeDialog, sectionTitle, empty, qrCode } from '../ui.js';
import { state, loadAccounts, setCurrent, currentAccount, balanceOf } from '../state.js';
import { txItem } from './common.js';

const icon = (d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
};

function receiveDialog(address) {
    const qrBox = el('div', {});
    qrCode(address).then((svg) => qrBox.replaceChildren(svg)).catch(() => {});
    openDialog(
        el('h3', {}, 'Получить перевод'),
        el('p', { class: 'muted small' }, 'Покажите QR-код или сообщите отправителю адрес этого счёта в сети Erachain:'),
        qrBox,
        el('p', { class: 'mono' }, address),
        el('div', { class: 'row end wrap' },
            el('button', { class: 'btn', onclick: () => copy(address, 'Адрес скопирован') }, 'Копировать'),
            el('button', { class: 'btn', onclick: () => share(address, 'Мой адрес Erachain') }, 'Поделиться'),
            el('button', { class: 'btn primary', onclick: closeDialog }, 'Готово')),
    );
}

export default {
    title: 'Мои счета',
    async render() {
        const accounts = await loadAccounts();
        const root = el('div', { class: 'stack' });

        let totalEra = 0;
        let totalCompu = 0;
        for (const a of accounts) {
            totalEra += Number(balanceOf(a, 1));
            totalCompu += Number(balanceOf(a, 2));
        }
        const valuation = el('div', { class: 'muted small num' });
        root.append(el('section', { class: 'card hero stack' },
            el('div', { class: 'muted small' }, `Всего на ${accounts.length} ${accounts.length % 10 === 1 && accounts.length % 100 !== 11 ? 'счёте' : 'счетах'}`),
            el('div', { class: 'big num' }, fmt(totalEra, 4) + ' ERA'),
            el('div', { class: 'muted small num' }, fmt(totalCompu, 6) + ' COMPU на комиссии'),
            valuation));
        // оценка ERA и COMPU по курсам обменника 7Pay (если он подключён)
        get('swap/rates').then((r) => {
            const value = (base) => {
                const p = (a) => ((r[base] || []).find((x) => x.abbrev === a) || {}).rate;
                return p('ERA') ? totalEra * p('ERA') + (p('COMPU') ? totalCompu * p('COMPU') : 0) : null;
            };
            const rub = value('RUB');
            const usd = value('USD');
            if (rub !== null || usd !== null) {
                valuation.textContent = '≈ ' + [rub !== null ? fmt(rub, 0) + ' ₽' : '', usd !== null ? fmt(usd, 2) + ' $' : ''].filter(Boolean).join(' · ') + ' по курсу 7Pay';
            }
        }).catch(() => {});

        const strip = el('div', { class: 'accounts-strip' });
        for (const a of accounts) {
            const chip = el('div', { class: 'account-chip' + (a.address === state.current ? ' active' : '') },
                el('div', { class: 'mono tiny muted' }, short(a.address)),
                el('div', { class: 'num' }, el('b', {}, fmt(balanceOf(a, 1), 4)), ' ERA'),
                el('div', { class: 'tiny muted' }, a.balances.length > 2 ? `+ ещё активов: ${a.balances.length - 2}` : fmt(balanceOf(a, 2), 6) + ' COMPU'));
            chip.addEventListener('click', () => {
                setCurrent(a.address);
                this.render().then((n) => document.getElementById('view').replaceChildren(n));
            });
            strip.append(chip);
        }
        const newBtn = el('button', { class: 'btn small soft' }, '+ Счёт');
        newBtn.addEventListener('click', async () => {
            newBtn.disabled = true;
            try {
                const { address } = await post('accounts');
                setCurrent(address);
                toast('Открыт новый счёт ' + short(address));
                document.getElementById('view').replaceChildren(await this.render());
            } catch (e) {
                toast(e.message);
                newBtn.disabled = false;
            }
        });
        // в кабинете одного счёта новые счета не открываются
        const cabinet = state.me && (state.me.active || ['account', 'client'].includes(state.me.user.role));
        root.append(el('div', { class: 'row between' }, el('h3', { class: 'section-title' }, cabinet ? 'Счёт' : 'Счета'), cabinet ? null : newBtn), strip);

        const acc = currentAccount();
        if (!acc) {
            root.append(empty('В кошельке нет счетов — откройте первый.'));
            return root;
        }

        root.append(el('div', { class: 'actions' },
            el('a', { class: 'action', href: '#/transfer' }, icon('M4 12h14m-5-5 5 5-5 5'), 'Перевести'),
            el('button', { class: 'action', type: 'button', onclick: () => receiveDialog(acc.address) }, icon('M12 4v12m-5-5 5 5 5-5M5 20h14'), 'Получить'),
            el('a', { class: 'action', href: '#/history' }, icon('M4 6h16M4 12h16M4 18h10'), 'История'),
            el('a', { class: 'action', href: '#/bank/statements' }, icon('M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7'), 'Выписка')));

        const balances = el('div', { class: 'list' });
        const shown = acc.balances.length ? acc.balances : [{ asset: 1, name: 'ERA', amount: '0' }, { asset: 2, name: 'COMPU', amount: '0' }];
        for (const b of shown) {
            const extra = [['в долг', b.debt], ['на хранении', b.hold], ['израсходовано', b.spend]]
                .filter(([, v]) => v && Number(v) !== 0).map(([k, v]) => `${k}: ${fmt(v)}`).join(' · ');
            balances.append(el('a', { class: 'list-item clickable', href: '#/assets/' + b.asset },
                el('div', { class: 'icon-circle' }, b.name.slice(0, 1).toUpperCase()),
                el('div', { class: 'grow' }, el('div', { class: 'title' }, b.name), el('div', { class: 'sub' }, extra || 'актив №' + b.asset)),
                el('div', { class: 'right num' }, el('b', {}, fmt(b.amount)))));
        }
        root.append(card(
            el('div', { class: 'row between' },
                el('div', { class: 'grow' }, el('div', { class: 'tiny muted' }, 'Текущий счёт'), el('div', { class: 'mono small' }, acc.address)),
                el('button', { class: 'btn small', onclick: () => copy(acc.address, 'Адрес скопирован') }, 'Копировать')),
            balances));

        root.append(sectionTitle('Последние операции'));
        const recent = card(el('div', { class: 'spinner' }, 'Загрузка…'));
        root.append(recent);
        get(`accounts/${acc.address}/history?limit=5`).then((txs) => {
            recent.replaceChildren(txs.length ? el('div', { class: 'list' }, txs.map(txItem)) : empty('Операций пока нет'));
            if (txs.length) recent.append(el('a', { class: 'btn block', href: '#/history' }, 'Вся история'));
        }).catch((e) => recent.replaceChildren(el('p', { class: 'error' }, e.message)));
        return root;
    },
};
