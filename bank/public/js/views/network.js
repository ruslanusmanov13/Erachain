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
            n.nodes ? card(el('h2', {}, 'Ноды банка'), el('p', { class: 'small muted' }, 'Подпись — только на основной ноде (там кошелёк). Чтение и отправка подписанных транзакций при её сбое идут через запасные.'),
                el('div', { class: 'list' }, n.nodes.map((x) => el('div', { class: 'list-item' }, el('div', { class: 'grow' },
                    el('div', { class: 'title mono small' }, x.url), el('div', { class: 'sub' }, (x.primary ? 'основная' : 'запасная') + (x.active ? ' · отвечает сейчас' : '')
                        + (x.ok ? ` · высота ${x.height}${x.behind ? ', отстаёт на ' + x.behind : ''}` : ' · недоступна'))),
                    el('span', { class: 'badge ' + (x.ok ? (x.behind > 5 ? 'warn' : 'ok') : 'bad') }, x.ok ? 'в сети' : 'нет связи'))))) : null,
            n.lastBlock ? card(el('h2', {}, 'Последний блок'), kv([
                ['Высота', n.lastBlock.height],
                ['Время', date(n.lastBlock.timestamp)],
                ['Транзакций', n.lastBlock.transactions],
                ['Создатель', el('span', { class: 'mono small' }, n.lastBlock.creator)],
                ['Подпись', el('span', { class: 'mono tiny' }, n.lastBlock.signature)],
            ])) : null);
    },
};
