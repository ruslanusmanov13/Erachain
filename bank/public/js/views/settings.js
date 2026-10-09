import { isNative, serverUrl, setServerUrl } from '../api.js';
import { el, card, kv, confirm } from '../ui.js';
import { state } from '../state.js';

export default {
    title: 'Настройки',
    async render() {
        const s = state.status || {};
        const logout = el('button', { class: 'btn danger block', type: 'button' }, 'Выйти');
        logout.addEventListener('click', () => window.dispatchEvent(new Event('bank:logout')));
        const change = isNative() ? el('button', { class: 'btn block', type: 'button' }, 'Сменить сервер') : null;
        if (change) {
            change.addEventListener('click', async () => {
                if (!(await confirm('Отключиться от текущего сервера и указать другой?'))) return;
                setServerUrl(null);
                window.dispatchEvent(new Event('bank:logout'));
            });
        }
        return el('div', { class: 'stack' },
            card(el('h2', {}, 'Подключение'), kv([
                ['Сервер банка', isNative() ? serverUrl() : location.origin],
                ['Режим', s.mode === 'demo' ? 'демо' : 'нода Erachain'],
                ['Версия ноды', s.version],
                ['Счетов в кошельке', state.accounts.length],
            ]), change, logout),
            card(el('h2', {}, 'Безопасность'), el('p', { class: 'small muted' },
                'Ключи хранятся только в кошельке ноды. Приложение не сохраняет пароль: он держится в памяти сервера банка до выхода или 15 минут бездействия. ' +
                'Для доступа из интернета включайте HTTPS на сервере банка.')),
            card(el('h2', {}, 'О приложении'), el('p', { class: 'small muted' }, 'Банк Erachain — клиент платформы Erachain: счета, переводы, активы, голосования, биржа, документы, персоны и интеграция с банковскими системами (1С, ISO 20022).')));
    },
};
