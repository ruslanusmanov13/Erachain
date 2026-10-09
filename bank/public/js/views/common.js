import { el, fmt, short, date, kv, openDialog, closeDialog, copy, badge } from '../ui.js';

const KIND_LABELS = {
    SEND: 'Перевод', LETTER: 'Письмо', Note: 'Документ', 'Create Order': 'Ордер на бирже', 'Cancel Order': 'Отмена ордера',
    'Issue Asset': 'Выпуск актива', 'Issue Person': 'Регистрация персоны', 'Issue Poll': 'Создание голосования', 'Vote on Poll': 'Голос',
};

export function txLabel(tx) {
    if (tx.title) return tx.title;
    if (tx.amount) return tx.direction === 'in' ? 'Поступление' : 'Перевод';
    return KIND_LABELS[tx.type] || tx.type || 'Операция';
}

export function txItem(tx) {
    const incoming = tx.direction === 'in';
    const hasAmount = !!tx.amount;
    const sum = hasAmount ? (incoming ? '+' : '−') + fmt(tx.amount) + ' ' + (tx.assetName || '#' + tx.asset) : '';
    const item = el('div', { class: 'list-item clickable' },
        el('div', { class: 'icon-circle ' + (hasAmount ? (incoming ? 'in' : 'out') : '') }, hasAmount ? (incoming ? '↓' : '↑') : '•'),
        el('div', { class: 'grow' },
            el('div', { class: 'title' }, txLabel(tx)),
            el('div', { class: 'sub' }, date(tx.timestamp), ' · ', hasAmount ? short(incoming ? tx.from : tx.to) : (KIND_LABELS[tx.type] || tx.type),
                tx.confirmations ? '' : ' · ожидает подтверждения')),
        el('div', { class: 'right num ' + (hasAmount ? (incoming ? 'in' : 'out') : '') }, sum));
    item.addEventListener('click', () => txDetails(tx));
    return item;
}

export function txDetails(tx) {
    openDialog(
        el('h3', {}, txLabel(tx)),
        kv([
            ['Тип', KIND_LABELS[tx.type] || tx.type],
            ['Дата', date(tx.timestamp)],
            ['Сумма', tx.amount ? fmt(tx.amount) + ' ' + (tx.assetName || '#' + tx.asset) : null],
            ['Отправитель', tx.from ? el('span', { class: 'mono' }, tx.from) : null],
            ['Получатель', tx.to ? el('span', { class: 'mono' }, tx.to) : null],
            ['Сообщение', tx.message || null],
            ['Комиссия', tx.fee ? fmt(tx.fee) + ' COMPU' : null],
            ['Номер', tx.seqNo],
            ['Статус', tx.confirmations ? badge('подтверждено: ' + tx.confirmations, 'ok') : badge('ожидает подтверждения', 'warn')],
            ['Подпись', tx.signature ? el('span', { class: 'mono tiny' }, tx.signature) : null],
        ]),
        el('div', { class: 'row end' },
            tx.signature ? el('button', { class: 'btn', onclick: () => copy(tx.signature, 'Подпись скопирована') }, 'Копировать подпись') : null,
            el('button', { class: 'btn primary', onclick: closeDialog }, 'Закрыть')),
    );
}

// Результат отправленной транзакции
export function txResult(title, r) {
    openDialog(
        el('h3', {}, title),
        el('p', { class: 'muted small pre-line' }, 'Транзакция отправлена в сеть и появится в блоке через несколько секунд.'),
        kv([['Номер', r.seqNo], ['Комиссия', r.fee ? fmt(r.fee) + ' COMPU' : null], ['Ключ', r.key], ['Подпись', r.signature ? el('span', { class: 'mono tiny' }, r.signature) : null]]),
        el('button', { class: 'btn primary', onclick: closeDialog }, 'Готово'),
    );
}

export function personalNote() {
    return el('p', { class: 'note' }, 'Выпуск активов и голосований в сети Erachain доступен только с персонализированного счёта — счёта, удостоверенного за персоной (раздел «Персоны»).');
}
