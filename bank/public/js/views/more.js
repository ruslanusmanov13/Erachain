import { el } from '../ui.js';
import { can } from '../state.js';

const ITEMS = [
    ['#/history', 'История', 'Все операции по счетам', 'M4 6h16M4 12h16M4 18h10'],
    ['#/sbp', 'Приём по СБП', 'QR-оплата рублями → активы', 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2z'],
    ['#/invoices', 'Счета на оплату', 'Безопасный платёж: выставить и оплатить', 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6'],
    ['#/swap', 'Обмен 7Pay', 'BTC, LTC, DOGE, ETH ⇄ ERA, COMPU', 'M4 8h13l-3-3M20 16H7l3 3'],
    ['#/transfer/batch', 'Массовые выплаты', 'Зарплаты, дивиденды, возвраты', 'M3 7h18M3 12h18M3 17h12'],
    ['#/polls', 'Голосования', 'Собрания, опросы, решения', 'M5 12l4 4 10-10'],
    ['#/exchange/1/2', 'Биржа', 'Обмен активов, ордера', 'M7 4v16M7 4 3 8M7 4l4 4M17 20V4m0 16-4-4m4 4 4-4'],
    ['#/documents', 'Документы', 'Подпись и проверка файлов', 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7'],
    ['#/messages', 'Сообщения', 'Телеграммы между счетами', 'M4 5h16v11H8l-4 4z'],
    ['#/persons', 'Персоны', 'Реестр и удостоверение', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'],
    ['#/assets/issue', 'Выпуск актива', 'Токены, акции, обязательства', 'M12 5v14M5 12h14'],
    ['#/catalog', 'Справочники', 'Статусы и шаблоны', 'M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z'],
    ['#/bank/gateway', 'Банковский шлюз', 'Ввод и вывод денег', 'M3 10h18L12 4zM5 10v8M19 10v8M3 20h18'],
    ['#/network', 'Сеть', 'Состояние ноды', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'],
    ['#/staff', 'Сотрудники', 'Роли, смена, журнал действий', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-5-6', 'staff'],
    ['#/settings', 'Настройки', 'Сервер, выход', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 1-2-2V4h-4v2L9 7 7 6 5 10l2 1v2l-2 1 2 4 2-1 2 2v2h4v-2l2-2 2 1 2-4-2-1z'],
];

function icon(d) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
}

export default {
    title: 'Сервисы',
    async render() {
        return el('div', { class: 'menu-grid' }, ITEMS.filter((i) => !i[4] || can(i[4])).map(([href, title, sub, d]) => el('a', { class: 'menu-tile', href },
            icon(d), el('b', {}, title), el('span', { class: 'muted' }, sub))));
    },
};
