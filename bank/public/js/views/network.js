import { get } from '../api.js';
import { el, card, kv, date } from '../ui.js';

export default {
    title: 'Сеть',
    async render() {
        const n = await get('network');
        return el('div', { class: 'stack' },
            card(el('h2', {}, 'Нода'), kv([
                ['Режим', n.mode === 'demo' ? 'демо (без ноды)' : 'подключена нода'],
                ['Адрес RPC', n.mode === 'demo' ? null : n.node],
                ['Версия', n.version + (n.buildDate ? ' · ' + n.buildDate : '')],
                ['Состояние', n.state],
                ['Соединений с пирами', n.peers],
                ['Высота цепочки', Number(n.height).toLocaleString('ru-RU')],
            ])),
            n.lastBlock ? card(el('h2', {}, 'Последний блок'), kv([
                ['Высота', n.lastBlock.height],
                ['Время', date(n.lastBlock.timestamp)],
                ['Транзакций', n.lastBlock.transactions],
                ['Создатель', el('span', { class: 'mono small' }, n.lastBlock.creator)],
                ['Подпись', el('span', { class: 'mono tiny' }, n.lastBlock.signature)],
            ])) : null);
    },
};
