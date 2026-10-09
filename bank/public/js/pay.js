// Публичная страница оплаты по СБП: клиент без входа в банк платит рублями из любого банка
// и получает актив Erachain на свой счёт.
import { el, card, field, input, fmt, short, qrCode, copy } from './ui.js';

const root = document.getElementById('pay');
const params = new URLSearchParams(location.search);
let pollTimer = null;

async function call(method, path, body) {
    const res = await fetch('/api/public/sbp/' + path, {
        method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: 'Некорректный ответ сервера' }));
    if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
}

const STEPS = [
    ['SBP_ACTIVE', 'Ожидаем оплату'], ['SBP_DONE', 'Оплата получена'], ['ERA_QUEUE', 'Готовим начисление'],
    ['ERA_SEND', 'Актив отправлен'], ['ERA_DONE', 'Зачислено'],
];

function stepsView(status) {
    const order = ['SBP_ACTIVE', 'SBP_DONE', 'ERA_QUEUE', 'ERA_SENDING', 'ERA_MAKE', 'ERA_SEND', 'ERA_DONE'];
    const at = order.indexOf(status);
    return el('ol', { class: 'pay-steps' }, STEPS.map(([key, label]) => {
        const i = order.indexOf(key);
        return el('li', { class: at > i || status === 'ERA_DONE' ? 'done' : at === i || (key === 'ERA_SEND' && ['ERA_SENDING', 'ERA_MAKE'].includes(status)) ? 'now' : '' }, label);
    }));
}

async function showOrder(order) {
    clearTimeout(pollTimer);
    const failed = /^FAIL|EXPIRED/.test(order.status);
    const box = card(
        el('h2', {}, failed ? 'Платёж не завершён' : order.status === 'ERA_DONE' ? 'Готово!' : order.status === 'SBP_ACTIVE' ? 'Оплатите по QR-коду' : 'Оплата получена, начисляем'),
        el('div', { class: 'pay-sum' }, el('b', { class: 'num' }, fmt(order.amountRub, 2) + ' ₽'), ' → ', el('b', { class: 'num' }, fmt(order.amountChain) + ' ' + order.assetName)),
        el('div', { class: 'small muted' }, 'на счёт ', el('span', { class: 'mono' }, short(order.receiver))),
    );
    if (order.status === 'SBP_ACTIVE') {
        const qr = el('div', {});
        if (order.image && order.image.content) {
            qr.append(el('img', { class: 'qr', src: `data:${order.image.mediaType || 'image/png'};base64,${order.image.content}`, alt: 'QR-код СБП', width: '240', height: '240' }));
        } else {
            qrCode(order.payload, 240).then((svg) => qr.append(svg));
        }
        const left = el('div', { class: 'small muted center' });
        const tick = () => {
            const s = Math.max(0, Math.round((order.expiresAt - Date.now()) / 1000));
            left.textContent = `QR действует ещё ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        };
        tick();
        const t = setInterval(tick, 1000);
        setTimeout(() => clearInterval(t), 3600000);
        box.append(
            el('p', { class: 'small' }, 'Отсканируйте код камерой телефона или в приложении своего банка — откроется платёж по СБП. С телефона нажмите кнопку ниже.'),
            qr, left,
            el('a', { class: 'btn primary block', href: order.payload }, 'Открыть в приложении банка'));
        if (order.mode === 'demo' || document.getElementById('mode').textContent.includes('демо')) {
            const demo = el('button', { class: 'btn block', type: 'button' }, 'Оплатить (демо)');
            demo.addEventListener('click', async () => {
                demo.disabled = true;
                await call('POST', `orders/${order.id}/emulate`).catch(() => {});
            });
            box.append(demo);
        }
    }
    if (!failed) box.append(stepsView(order.status));
    if (order.message && failed) box.append(el('p', { class: 'error' }, order.message));
    if (order.txId) {
        box.append(el('p', { class: 'small' }, 'Транзакция в Erachain: ', el('span', { class: 'mono tiny' }, order.txId)),
            el('button', { class: 'btn small', type: 'button', onclick: () => copy(order.txId, 'Скопировано') }, 'Копировать'));
    }
    if (failed || order.status === 'ERA_DONE') {
        box.append(el('button', { class: 'btn block', type: 'button', onclick: () => { history.replaceState(null, '', location.pathname); start(); } }, 'Новый платёж'));
    }
    root.replaceChildren(box);
    history.replaceState(null, '', '?order=' + order.id);
    if (!failed && order.status !== 'ERA_DONE') {
        pollTimer = setTimeout(async () => {
            try {
                showOrder(await call('GET', 'orders/' + order.id));
            } catch (e) {
                pollTimer = setTimeout(() => showOrder(order), 5000);
            }
        }, 3000);
    }
}

async function start() {
    clearTimeout(pollTimer);
    let cfg;
    try {
        cfg = await call('GET', 'config');
    } catch (e) {
        root.replaceChildren(card(el('p', { class: 'error' }, e.message)));
        return;
    }
    document.getElementById('mode').textContent = cfg.mode === 'demo' ? 'демо' : cfg.mode === 'test' ? 'тестовый банк' : '';
    if (!cfg.enabled) {
        root.replaceChildren(card(el('p', {}, 'Приём платежей временно недоступен.')));
        return;
    }
    if (params.get('order')) {
        try {
            showOrder(await call('GET', 'orders/' + params.get('order')));
            return;
        } catch (e) { /* заказ не найден — новая форма */ }
    }
    const assetSel = el('select', { name: 'asset' }, cfg.assets.map((a) => el('option', { value: String(a.asset) }, `${a.name} — ${fmt(a.rubPerUnit, 2)} ₽ за 1`)));
    if (params.get('asset')) assetSel.value = params.get('asset');
    const amount = input('amount', { inputmode: 'decimal', placeholder: String(cfg.minRub), value: params.get('amount') || '' });
    const receiver = input('receiver', { placeholder: 'Ваш счёт Erachain (начинается с 7)', spellcheck: 'false', value: params.get('to') || '' });
    const calc = el('div', { class: 'small muted' });
    const err = el('p', { class: 'error' });
    const update = () => {
        const a = cfg.assets.find((x) => String(x.asset) === assetSel.value);
        const rub = Number(amount.value.replace(',', '.'));
        calc.textContent = rub > 0 && a ? `Вы получите ≈ ${fmt(rub / a.rubPerUnit, a.scale)} ${a.name}` : `Минимальная сумма — ${cfg.minRub} ₽`;
    };
    amount.addEventListener('input', update);
    assetSel.addEventListener('change', update);
    update();
    const btn = el('button', { class: 'btn primary block', type: 'button' }, 'Получить QR-код');
    btn.addEventListener('click', async () => {
        err.textContent = '';
        btn.disabled = true;
        try {
            showOrder(await call('POST', 'orders', { receiver: receiver.value.trim(), amount: amount.value.trim(), asset: Number(assetSel.value) }));
        } catch (e) {
            err.textContent = e.message;
        } finally {
            btn.disabled = false;
        }
    });
    root.replaceChildren(card(
        el('h2', {}, cfg.purpose),
        el('p', { class: 'small muted' }, 'Оплатите рублями из любого банка через Систему быстрых платежей — актив будет зачислен на ваш счёт в блокчейне Erachain.'),
        field('Что получить', assetSel), field('Сумма, ₽', amount), calc, field('Счёт получателя', receiver), err, btn));
}

start();
