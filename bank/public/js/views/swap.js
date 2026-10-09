import { get, post } from '../api.js';
import { el, card, field, input, form, tabs, fmt, short, date, kv, empty, spinner, toast, copy, badge, confirm, openDialog, closeDialog, qrCode } from '../ui.js';
import { state, loadAccounts, accountSelect, balanceOf } from '../state.js';

const STATUS = {
    awaiting_payment: ['ждёт оплаты', 'warn'], paying: ['оплачивается…', 'warn'],
    paid: ['оплачено, ждём 7Pay', 'warn'], done: ['исполнено', 'ok'],
};

function currSelect(name, list, value) {
    const s = el('select', { name });
    for (const c of list) {
        const opt = el('option', { value: c.abbrev }, `${c.abbrev} — ${c.name}${c.erachain ? ' (Erachain)' : ''}`);
        if (c.abbrev === value) opt.selected = true;
        s.append(opt);
    }
    return s;
}

// Окно оплаты созданной заявки
function paymentDialog(order, onPaid) {
    const parts = [
        el('h3', {}, `Заявка: ${order.in} → ${order.out}`),
        kv([
            ['Отдаёте', `${fmt(order.volume_in)} ${order.in}`],
            ['Получите', `${fmt(order.volume_out)} ${order.out}`],
            ['Курс', order.rate ? `1 ${order.in} = ${fmt(order.rate, 10)} ${order.out}` : null],
            ['Куда придёт', el('span', { class: 'mono small' }, order.addr_out)],
            ['Статус', badge(...(STATUS[order.status] || [order.status, '']))],
        ]),
    ];
    if (order.status === 'awaiting_payment' && order.payAsset) {
        // оплата активом Erachain прямо из кошелька ноды
        const from = accountSelect('from');
        const err = el('p', { class: 'error' });
        const pay = el('button', { class: 'btn primary block', type: 'button' }, `Оплатить ${fmt(order.volume_in)} ${order.in} с моего счёта`);
        pay.addEventListener('click', async () => {
            err.textContent = '';
            if (!(await confirm(`Перевести ${fmt(order.volume_in)} ${order.in} обменнику 7Pay?\nВ заголовке перевода будет указан адрес получения: ${order.addr_out_full}`))) {
                paymentDialog(order, onPaid);
                return;
            }
            try {
                const paid = await post(`swap/orders/${order.id}/pay`, { from: from.value });
                await loadAccounts();
                toast('Оплачено. 7Pay выплатит после подтверждения перевода в блокчейне');
                paymentDialog(paid, onPaid);
                onPaid();
            } catch (e) {
                paymentDialog(order, onPaid);
                toast(e.message);
            }
        });
        parts.push(field('Оплатить со счёта', from), pay, err,
            el('p', { class: 'tiny muted' }, `Перевод уйдёт на счёт обменника ${short(order.addr_in)} с заголовком «${order.addr_out_full}» — по нему 7Pay определит, куда выплатить ${order.out}.`));
    } else if (order.status === 'awaiting_payment') {
        const qrBox = el('div', {});
        qrCode(order.uri || order.addr_in).then((svg) => qrBox.replaceChildren(svg)).catch(() => {});
        parts.push(
            el('p', { class: 'small' }, `Отправьте ровно ${fmt(order.volume_in)} ${order.in} на адрес обменника — или отсканируйте QR-код кошельком:`),
            qrBox,
            el('p', { class: 'mono' }, order.addr_in),
            el('div', { class: 'row wrap' },
                el('button', { class: 'btn', type: 'button', onclick: () => copy(order.addr_in, 'Адрес скопирован') }, 'Копировать адрес'),
                el('button', { class: 'btn', type: 'button', onclick: () => copy(String(order.volume_in), 'Сумма скопирована') }, 'Копировать сумму'),
                order.uri ? el('a', { class: 'btn soft', href: order.uri }, 'Открыть в кошельке') : null),
            el('p', { class: 'tiny muted' }, `Адрес закреплён за вашим адресом получения — повторные платежи на него тоже будут обменяны в ${order.out}. Курс фиксируется при поступлении платежа.`));
    }
    parts.push(el('div', { class: 'row end' },
        el('button', { class: 'btn', type: 'button', onclick: () => statusDialog(order) }, 'Проверить статус'),
        el('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, 'Закрыть')));
    openDialog(...parts);
}

const STAGE = {
    unconfirmed: ['ждёт подтверждений', 'warn'], in_process: ['получен, обрабатывается', 'warn'],
    paying_out: ['выплата отправляется', 'warn'], paid_out: ['выплачено', 'ok'],
};

function paymentsList(payments) {
    if (!payments.length) return empty('Платежей пока нет');
    return el('div', { class: 'list' }, payments.map((p) => {
        const [label, kind] = STAGE[p.stage] || [p.stage, ''];
        return el('div', { class: 'list-item' }, el('div', { class: 'grow stack' },
            el('div', { class: 'row between' },
                el('b', { class: 'num' }, `${fmt(p.amountIn)} ${p.currIn || ''}`, p.amountOut !== null ? ` → ${fmt(p.amountOut)} ${p.currOut}` : ''),
                badge(label, kind)),
            el('div', { class: 'tiny muted' }, [p.created ? String(p.created).slice(0, 16) : '', p.note, p.fee ? `комиссия ${fmt(p.fee)} ${p.currOut}` : ''].filter(Boolean).join(' · ')),
            p.txidIn ? el('div', { class: 'tiny mono muted' }, 'вход: ' + p.txidIn) : null,
            p.txidOut ? el('div', { class: 'tiny mono muted' }, 'выплата: ' + p.txidOut) : null));
    }));
}

async function statusDialog(order) {
    openDialog(el('h3', {}, 'Статус в 7Pay'), spinner());
    try {
        const h = await get(`swap/orders/${order.id}/history`);
        openDialog(el('h3', {}, 'Статус в 7Pay'), paymentsList(h.payments),
            el('div', { class: 'row end' }, el('button', { class: 'btn', type: 'button', onclick: () => paymentDialog(order, () => {}) }, 'Назад'),
                el('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, 'Закрыть')));
    } catch (e) {
        openDialog(el('h3', {}, 'Статус в 7Pay'), el('p', { class: 'error' }, e.message), el('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, 'Закрыть'));
    }
}

async function exchangeForm() {
    const currs = await get('swap/currencies');
    const defIn = currs.in.find((c) => c.abbrev === 'BTC') ? 'BTC' : (currs.in[0] || {}).abbrev;
    const defOut = currs.out.find((c) => c.abbrev === 'ERA') ? 'ERA' : (currs.out[0] || {}).abbrev;
    const fromSel = currSelect('from', currs.in, defIn);
    const toSel = currSelect('to', currs.out, defOut);
    const amountIn = input('amountIn', { inputmode: 'decimal', placeholder: '0.00', value: '0.01' });
    const amountOut = input('amountOut', { inputmode: 'decimal', placeholder: '0.00' });
    const quoteBox = el('div', { class: 'small muted' });
    const addressBox = el('div', {});
    const err = el('p', { class: 'error' });
    const submit = el('button', { class: 'btn primary block', type: 'button' }, 'Создать заявку');
    let side = 'in';
    let lastQuote = null;
    let seq = 0;

    const outInfo = () => currs.out.find((c) => c.abbrev === toSel.value) || {};
    const inInfo = () => currs.in.find((c) => c.abbrev === fromSel.value) || {};

    const drawAddress = () => {
        if (outInfo().erachain) {
            addressBox.replaceChildren(field(`Получить ${toSel.value} на счёт`, accountSelect('address')));
        } else {
            addressBox.replaceChildren(field(`Ваш адрес ${toSel.value} для получения`, input('address', { placeholder: `Адрес кошелька ${outInfo().name || toSel.value}`, spellcheck: 'false' })));
        }
    };

    const requote = async () => {
        const my = ++seq;
        err.textContent = '';
        const amount = (side === 'in' ? amountIn.value : amountOut.value).trim().replace(',', '.');
        submit.disabled = false;
        if (!(Number(amount) > 0) || fromSel.value === toSel.value) {
            quoteBox.textContent = fromSel.value === toSel.value ? 'Выберите разные валюты' : '';
            lastQuote = null;
            return;
        }
        quoteBox.textContent = 'Считаю курс…';
        try {
            const q = await post('swap/quote', { from: fromSel.value, to: toSel.value, amount, side });
            if (my !== seq) return;
            lastQuote = q;
            if (side === 'in') amountOut.value = String(q.volumeOut ?? '');
            else amountIn.value = String(q.volumeIn ?? '');
            const lines = [`Курс: 1 ${q.from} = ${fmt(q.rate, 10)} ${q.to}`];
            if (q.available !== null) lines.push(`В обменнике доступно: ${fmt(q.available)} ${q.to}`);
            if (q.mayPay !== null) lines.push(`Принимает до: ${fmt(q.mayPay)} ${q.from}`);
            if (q.minIn) lines.push(`Минимум: ${fmt(q.minIn)} ${q.from}`);
            if (q.payFromWallet) lines.push(`${q.from} — актив Erachain: оплатите прямо со счёта (доступно ${fmt(balanceOf(state.accounts.find((a) => a.address === state.current), inInfo().asset))})`);
            quoteBox.replaceChildren(...lines.map((l) => el('div', {}, l)), ...q.problems.map((l) => el('p', { class: 'note' }, l)));
            submit.disabled = q.problems.length > 0;
        } catch (e) {
            if (my !== seq) return;
            lastQuote = null;
            quoteBox.textContent = '';
            err.textContent = e.message;
        }
    };

    let timer;
    const later = () => {
        clearTimeout(timer);
        timer = setTimeout(requote, 400);
    };
    amountIn.addEventListener('input', () => { side = 'in'; later(); });
    amountOut.addEventListener('input', () => { side = 'out'; later(); });
    fromSel.addEventListener('change', requote);
    toSel.addEventListener('change', () => { drawAddress(); requote(); });
    const swapBtn = el('button', { class: 'btn small', type: 'button', title: 'Поменять местами' }, '⇅');
    swapBtn.addEventListener('click', () => {
        const a = fromSel.value;
        const b = toSel.value;
        if (currs.out.some((c) => c.abbrev === a) && currs.in.some((c) => c.abbrev === b)) {
            fromSel.value = b;
            toSel.value = a;
            drawAddress();
            requote();
        }
    });

    submit.addEventListener('click', async () => {
        err.textContent = '';
        if (!lastQuote) {
            err.textContent = 'Укажите сумму и дождитесь расчёта курса';
            return;
        }
        const addrEl = addressBox.querySelector('[name=address]');
        const address = addrEl ? addrEl.value.trim() : '';
        if (!address) {
            err.textContent = 'Укажите адрес для получения';
            return;
        }
        const amount = (side === 'in' ? amountIn.value : amountOut.value).trim().replace(',', '.');
        if (!(await confirm(`Создать заявку в 7Pay?\nОтдаёте: ${fmt(lastQuote.volumeIn)} ${fromSel.value}\nПолучите: ${fmt(lastQuote.volumeOut)} ${toSel.value}\nНа адрес: ${address}`))) return;
        submit.disabled = true;
        try {
            const order = await post('swap/orders', { from: fromSel.value, to: toSel.value, amount, side, address });
            paymentDialog(order, () => {});
        } catch (e) {
            err.textContent = e.message;
        } finally {
            submit.disabled = false;
        }
    });

    drawAddress();
    requote();
    return card(
        el('p', { class: 'small muted' }, 'Обменник 7Pay: биткоин и другие криптовалюты на активы Erachain и обратно. Курс считается обменником; оплата активами Erachain — в одно касание со счёта кошелька.'),
        el('div', { class: 'grid-2' }, field('Отдаю', fromSel), field('Сумма', amountIn)),
        el('div', { class: 'row end' }, swapBtn),
        el('div', { class: 'grid-2' }, field('Получаю', toSel), field('Сумма', amountOut)),
        quoteBox, addressBox, err, submit);
}

async function ordersList() {
    const list = await get('swap/orders');
    if (!list.length) return card(empty('Заявок пока нет'));
    return card(el('div', { class: 'list' }, list.map((o) => {
        const [label, kind] = STATUS[o.status] || [o.status, ''];
        const item = el('div', { class: 'list-item clickable' },
            el('div', { class: 'icon-circle' }, '⇄'),
            el('div', { class: 'grow' },
                el('div', { class: 'title' }, `${fmt(o.volume_in)} ${o.in} → ${fmt(o.volume_out)} ${o.out}`),
                el('div', { class: 'sub' }, `${date(o.createdAt)} · на ${short(o.addr_out)}`)),
            badge(label, kind));
        item.addEventListener('click', () => paymentDialog(o, () => {}));
        return item;
    })));
}

async function ratesView() {
    const r = await get('swap/rates');
    const bases = Object.entries(r).filter(([, list]) => list.length);
    if (!bases.length) return card(empty('Обменник не сообщил курсы'));
    const abbrevs = [...new Set(bases.flatMap(([, list]) => list.map((x) => x.abbrev)))];
    const price = (base, abbrev) => {
        const x = r[base].find((i) => i.abbrev === abbrev);
        return x ? fmt(x.rate, x.rate < 1 ? 8 : 2) : '—';
    };
    return card(
        el('p', { class: 'small muted' }, 'Средние курсы обменника 7Pay: сколько стоит 1 единица валюты.'),
        el('div', { class: 'scroll-x' }, el('table', { class: 'data' },
            el('tr', {}, el('th', {}, 'Валюта'), ...bases.map(([b]) => el('th', { class: 'right' }, 'в ' + b))),
            abbrevs.map((a) => el('tr', {}, el('td', {}, el('b', {}, a)), ...bases.map(([b]) => el('td', { class: 'right num' }, price(b, a))))))));
}

function trackView() {
    const result = el('div', {});
    return el('div', { class: 'stack' }, card(form([
        el('p', { class: 'small muted' }, 'Найдите платежи по адресу получения — даже если заявка создана на сайте обменника или в другом кошельке.'),
        el('div', { class: 'grid-2' },
            field('Валюта получения', input('curr', { placeholder: 'ERA', value: 'ERA' })),
            field('Адрес получения', input('address', { required: true, spellcheck: 'false', value: state.current || '' }))),
    ], 'Найти платежи', async (d) => {
        result.replaceChildren(spinner());
        const r = await get(`swap/track?curr=${encodeURIComponent(d.curr.trim())}&address=${encodeURIComponent(d.address.trim())}`);
        result.replaceChildren(card(paymentsList(r.payments)));
    })), result);
}

export default {
    title: 'Обмен 7Pay',
    async render(params) {
        const views = { exchange: exchangeForm, orders: ordersList, rates: ratesView, track: trackView };
        const mode = views[params[0]] ? params[0] : 'exchange';
        const body = el('div', {}, spinner());
        const show = async (k) => {
            body.replaceChildren(spinner());
            try {
                body.replaceChildren(await views[k]());
            } catch (e) {
                body.replaceChildren(card(el('p', { class: 'error' }, e.message)));
            }
        };
        show(mode);
        return el('div', {}, tabs([['exchange', 'Обмен'], ['orders', 'Мои заявки'], ['rates', 'Курсы'], ['track', 'Отследить']], mode, show), body);
    },
};
