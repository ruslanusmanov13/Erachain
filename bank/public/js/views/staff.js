import { get, post, api } from '../api.js';
import { el, card, field, input, select, form, tabs, date, empty, spinner, toast, confirm, badge, openDialog, closeDialog } from '../ui.js';
import { state, loadMe } from '../state.js';

async function staffList() {
    const { staff, roles } = await get('staff');
    const roleName = (k) => (roles.find((r) => r.key === k) || {}).name || k;
    const roleOptions = roles.map((r) => ({ value: r.key, label: r.name }));
    const box = el('div', { class: 'stack' });

    const editDialog = (u) => openDialog(el('h3', {}, u.name), form([
        field('Имя', input('name', { value: u.name })),
        field('Роль', select('role', roleOptions, u.role)),
        field('Новый пароль', input('password', { type: 'password', autocomplete: 'new-password', placeholder: 'Оставьте пустым, чтобы не менять' })),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'disabled', value: '1', checked: u.disabled }), 'Доступ отключён'),
    ], 'Сохранить', async (d) => {
        await api('PATCH', 'staff/' + u.id, { name: d.name, role: d.role, password: d.password || undefined, disabled: d.disabled === '1' });
        closeDialog();
        toast('Сохранено');
        box.replaceWith(await staffList());
    }), el('button', {
        class: 'btn danger block', type: 'button', onclick: async () => {
            if (!(await confirm(`Удалить сотрудника ${u.login}? Его сессии закроются сразу.`, 'Удалить'))) return;
            await api('DELETE', 'staff/' + u.id).catch((e) => toast(e.message));
            box.replaceWith(await staffList());
        },
    }, 'Удалить сотрудника'));

    const rows = staff.length ? el('div', { class: 'list' }, staff.map((u) => {
        const item = el('div', { class: 'list-item clickable' },
            el('div', { class: 'icon-circle' }, u.name.slice(0, 1).toUpperCase()),
            el('div', { class: 'grow' }, el('div', { class: 'title' }, u.name), el('div', { class: 'sub' }, `${u.login} · ${roleName(u.role)}`)),
            u.disabled ? badge('отключён', 'bad') : badge(roleName(u.role)));
        item.addEventListener('click', () => editDialog(u));
        return item;
    })) : empty('Сотрудников пока нет — добавьте первого');

    box.append(
        card(el('h2', {}, 'Сотрудники'), rows),
        card(el('h2', {}, 'Новый сотрудник'), form([
            el('div', { class: 'grid-2' },
                field('Логин', input('login', { required: true, placeholder: 'kassir1', autocapitalize: 'none' })),
                field('Имя', input('name', { placeholder: 'Анна Петрова' }))),
            field('Роль', select('role', roleOptions, 'operator')),
            field('Пароль', input('password', { type: 'password', autocomplete: 'new-password', required: true }), 'Не короче 8 символов. Пароль кошелька сотруднику не нужен.'),
        ], 'Добавить', async (d, f) => {
            await post('staff', d);
            f.reset();
            toast('Сотрудник добавлен');
            box.replaceWith(await staffList());
        })),
        card(el('h2', {}, 'Роли'), el('div', { class: 'list' }, roles.map((r) => el('div', { class: 'list-item' },
            el('div', { class: 'grow' }, el('div', { class: 'title' }, r.name), el('div', { class: 'sub' }, r.perms.map(permName).join(', '))))))));
    return box;
}

const PERM_NAMES = {
    read: 'просмотр', sign: 'переводы и подписи', statements: 'выписки', gateway: 'банковский шлюз',
    settings: 'настройки', staff: 'сотрудники и смена',
};
const permName = (p) => PERM_NAMES[p] || p;

async function shiftView() {
    const me = await loadMe();
    const s = me.shift;
    const parts = [el('h2', {}, 'Смена'),
        el('p', { class: 'small muted' }, 'Пока смена открыта, сотрудники работают с кошельком ноды, не зная его пароля: он хранится только в памяти сервера банка. Закрытие смены или перезапуск сервера сразу закрывают доступ к подписи операций.'),
        s.open
            ? el('p', {}, badge('открыта', 'ok'), ` с ${date(s.openedAt)}, открыл ${s.openedBy}`)
            : el('p', {}, badge('закрыта', 'warn'))];
    if (s.open) {
        const b = el('button', { class: 'btn danger block', type: 'button' }, 'Закрыть смену');
        b.addEventListener('click', async () => {
            if (!(await confirm('Закрыть смену? Сотрудники сразу потеряют доступ к операциям.', 'Закрыть'))) return;
            await post('shift/close');
            toast('Смена закрыта');
            document.getElementById('view').replaceChildren(await render(['shift']));
        });
        parts.push(b);
    } else {
        const owner = state.me && state.me.user.role === 'owner';
        parts.push(form(owner ? [] : [field('Пароль кошелька ноды', input('password', { type: 'password', autocomplete: 'off', required: true }))],
            'Открыть смену', async (d) => {
                await post('shift/open', owner ? {} : { password: d.password });
                toast('Смена открыта');
                document.getElementById('view').replaceChildren(await render(['shift']));
            }));
    }
    return card(...parts);
}

async function auditView() {
    const list = await get('audit?limit=300');
    if (!list.length) return card(empty('Журнал пуст'));
    return card(el('div', { class: 'list' }, list.map((a) => el('div', { class: 'list-item' },
        el('div', { class: 'icon-circle ' + (a.ok ? '' : 'out') }, a.ok ? '✓' : '!'),
        el('div', { class: 'grow' },
            el('div', { class: 'title' }, describe(a)),
            el('div', { class: 'sub' }, `${date(a.ts)} · ${a.login} (${a.role}) · ${a.ip}`),
            Object.keys(a.details || {}).length ? el('div', { class: 'tiny muted' }, Object.entries(a.details).map(([k, v]) => `${FIELD_NAMES[k] || k}: ${v}`).join(' · ')) : null,
            a.error ? el('div', { class: 'tiny out' }, a.error) : null)))));
}

const ACTIONS = [
    [/^POST \/api\/login$/, 'Вход'], [/^POST \/api\/logout$/, 'Выход'], [/^POST \/api\/transfer$/, 'Перевод'],
    [/^POST \/api\/transfer\/batch$/, 'Массовая выплата'], [/^POST \/api\/accounts$/, 'Новый счёт'], [/^POST \/api\/assets$/, 'Выпуск актива'],
    [/^POST \/api\/polls$/, 'Создание голосования'], [/vote$/, 'Голос'], [/^POST \/api\/exchange\/orders$/, 'Ордер на бирже'],
    [/^POST \/api\/exchange\/cancel$/, 'Отмена ордера'], [/^POST \/api\/messages$/, 'Сообщение'], [/^POST \/api\/documents$/, 'Подпись документа'],
    [/^POST \/api\/persons$/, 'Регистрация персоны'], [/certify$/, 'Удостоверение ключа'], [/^POST \/api\/swap\/orders$/, 'Заявка 7Pay'],
    [/\/pay$/, 'Оплата заявки 7Pay'], [/credit$/, 'Зачисление из банка'], [/refund$/, 'Возврат заявки на вывод'], [/paid$/, 'Заявка на вывод оплачена'],
    [/withdrawals\/export$/, 'Выгрузка поручений'], [/withdrawals\/scan$/, 'Проверка заявок на вывод'], [/bank\/import$/, 'Загрузка выписки банка'],
    [/bank\/settings$/, 'Настройки шлюза'], [/^POST \/api\/staff$/, 'Новый сотрудник'], [/^PATCH \/api\/staff/, 'Изменение сотрудника'],
    [/^DELETE \/api\/staff/, 'Удаление сотрудника'], [/shift\/open$/, 'Смена открыта'], [/shift\/close$/, 'Смена закрыта'],
];
const FIELD_NAMES = {
    from: 'откуда', to: 'куда', creator: 'счёт', voter: 'голосующий', address: 'адрес', asset: 'актив', amount: 'сумма',
    side: 'сторона', have: 'отдаёт', want: 'получает', haveAmount: 'сумма продажи', wantAmount: 'сумма покупки', order: 'ордер',
    title: 'назначение', name: 'название', person: 'персона', option: 'вариант', format: 'формат', login: 'логин', role: 'роль',
    disabled: 'отключён', tokenAsset: 'токен', gatewayAccount: 'счёт шлюза', payments: 'выплат',
};
const describe = (a) => (ACTIONS.find(([re]) => re.test(a.action)) || [null, a.action])[1];

async function render(params) {
    const views = { staff: staffList, shift: shiftView, audit: auditView };
    const mode = views[params[0]] ? params[0] : 'staff';
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
    return el('div', {}, tabs([['staff', 'Сотрудники'], ['shift', 'Смена'], ['audit', 'Журнал']], mode, show), body);
}

export default { title: 'Сотрудники', render };
