// Сид-фраза: мастер первого запуска (создать банк или восстановить), показ и привязка фразы владельцем.
import { get, post } from './api.js';
import { el, card, field, input, form, toast, date, kv, badge, openDialog, closeDialog } from './ui.js';

const groups = (seed) => seed.trim().split(/\s+/);

export function seedGrid(seed) {
    return el('div', { class: 'seed-grid' }, groups(seed).map((g, i) => el('div', { class: 'seed-cell' }, el('small', {}, String(i + 1)), g)));
}

export function seedInput(name = 'seed', attrs = {}) {
    return el('textarea', {
        name, class: 'seed-input', rows: 3, required: true, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off',
        placeholder: 'Например: 6Vo7 BE54 QbX1 … (пробелы не важны)', ...attrs,
    });
}

const WARN = () => el('div', { class: 'warn-box' },
    el('b', {}, 'Сид-фраза — это все деньги банка.'),
    el('ul', {},
        el('li', {}, 'Запишите её на бумаге и храните в сейфе. Лучше — две копии в разных местах.'),
        el('li', {}, 'Не делайте скриншот, не пересылайте в мессенджерах и почте, не храните в заметках.'),
        el('li', {}, 'Кто знает фразу, тот распоряжается всеми счетами. Сотрудникам она не нужна — у них свой логин и пароль.'),
        el('li', {}, 'Потеряете фразу и пароль кошелька — доступ к счетам не восстановить.')));

function passwordFields(needCode) {
    return [
        field('Пароль кошелька ноды', input('password', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }),
            'Не короче 8 символов. Им шифруются ключи на ноде; для входа достаточно сид-фразы'),
        field('Пароль ещё раз', input('password2', { type: 'password', autocomplete: 'new-password', required: true })),
        needCode ? field('Код первого запуска', input('code', { required: true, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' }),
            'Напечатан в консоли сервера банка при старте — защищает от создания кошелька посторонним') : null,
    ];
}

function checkPasswords(d) {
    if ((d.password || '').length < 8) throw new Error('Пароль кошелька — не короче 8 символов');
    if (d.password !== d.password2) throw new Error('Пароли не совпадают');
}

/** Мастер первого запуска: на ноде нет кошелька. onDone(token) — банк создан, владелец вошёл. */
export function setupWizard(setup, onDone) {
    const box = el('div', { class: 'login-wrap' });
    const step = (...children) => box.replaceChildren(card(...children));

    const create = async (seed, d) => {
        const r = await post('setup/create', { seed, password: d.password, code: d.code });
        toast('Банк создан. Вы вошли как владелец');
        onDone(r.token);
    };

    const start = () => step(
        el('h2', {}, 'Добро пожаловать'),
        el('p', { class: 'small muted' }, 'На ноде Erachain ещё нет кошелька банка. Создайте новый банк или восстановите существующий по сид-фразе. Тот, кто это делает, становится владельцем.'),
        el('div', { class: 'choice' },
            el('button', { class: 'btn primary', type: 'button', onclick: newSeed }, el('b', {}, 'Создать новый банк'), el('span', {}, 'Сгенерируем сид-фразу — главный ключ банка')),
            el('button', { class: 'btn', type: 'button', onclick: restore }, el('b', {}, 'Восстановить по сид-фразе'), el('span', {}, 'Фраза из этого приложения или кошелька Erachain'))));

    async function newSeed() {
        let seed;
        try {
            seed = (await post('setup/seed')).seed;
        } catch (e) {
            toast(e.message);
            return;
        }
        const agree = el('input', { type: 'checkbox' });
        const next = el('button', { class: 'btn primary block', type: 'button', disabled: true }, 'Я записал(а), дальше');
        agree.addEventListener('change', () => { next.disabled = !agree.checked; });
        next.addEventListener('click', () => verify(seed));
        step(
            el('h2', {}, 'Шаг 1 из 3. Запишите сид-фразу'),
            el('p', { class: 'small muted' }, `${groups(seed).length} групп по 4 символа. Различайте заглавные и строчные буквы.`),
            seedGrid(seed), WARN(),
            el('label', { class: 'check-row' }, agree, el('span', {}, 'Я записал(а) сид-фразу на бумаге и понимаю, что без неё доступ к деньгам не восстановить')),
            next,
            el('button', { class: 'btn block', type: 'button', onclick: start }, 'Назад'));
    }

    function verify(seed) {
        const g = groups(seed);
        const picks = [];
        while (picks.length < 3) {
            const i = Math.floor(Math.random() * g.length);
            if (!picks.includes(i)) picks.push(i);
        }
        picks.sort((a, b) => a - b);
        step(
            el('h2', {}, 'Шаг 2 из 3. Проверка записи'),
            el('p', { class: 'small muted' }, 'Введите группы с указанными номерами — так мы убедимся, что фраза записана без ошибок.'),
            form([
                el('div', { class: 'seed-check' }, picks.map((i) => field(`№ ${i + 1}`, input('g' + i, { required: true, maxlength: 4, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' })))),
            ], 'Проверить', async (d) => {
                const bad = picks.filter((i) => (d['g' + i] || '').trim() !== g[i]);
                if (bad.length) throw new Error(`Не совпадает группа № ${bad.map((i) => i + 1).join(', ')} — сверьтесь с записью (регистр важен)`);
                passwordStep(seed);
            }),
            el('button', { class: 'btn block', type: 'button', onclick: () => newSeedShow(seed) }, 'Показать фразу ещё раз'));
    }

    function newSeedShow(seed) {
        step(el('h2', {}, 'Сид-фраза'), seedGrid(seed), el('button', { class: 'btn primary block', type: 'button', onclick: () => verify(seed) }, 'Дальше'));
    }

    function passwordStep(seed) {
        step(
            el('h2', {}, 'Шаг 3 из 3. Пароль кошелька'),
            el('p', { class: 'small muted' }, 'Нода создаст кошелёк банка из сид-фразы и зашифрует его этим паролем. Входить вы сможете сид-фразой или этим паролем.'),
            form(passwordFields(setup.needCode), 'Создать банк', async (d) => {
                checkPasswords(d);
                await create(seed, d);
            }));
    }

    function restore() {
        step(
            el('h2', {}, 'Восстановление по сид-фразе'),
            el('p', { class: 'small muted' }, 'Нода восстановит из фразы все счета банка. Остатки и история подтянутся из блокчейна после синхронизации ноды.'),
            form([
                field('Сид-фраза', seedInput()),
                ...passwordFields(setup.needCode),
            ], 'Восстановить банк', async (d) => {
                checkPasswords(d);
                await create(d.seed, d);
            }),
            el('button', { class: 'btn block', type: 'button', onclick: start }, 'Назад'));
    }

    start();
    return box;
}

/** Карточка «Сид-фраза» в настройках (только владелец). */
export async function seedSettingsCard() {
    const { seed: info } = await get('security');
    const body = el('div', { class: 'stack' });
    const reload = async () => body.parentElement.replaceWith(await seedSettingsCard());

    const askPassword = (title, text, extra, submit, onResult) => openDialog(
        el('h3', {}, title), text ? el('p', { class: 'small muted' }, text) : null,
        form([
            ...extra,
            field('Пароль кошелька ноды', input('password', { type: 'password', autocomplete: 'current-password', required: true })),
        ], submit, async (d) => onResult(d)),
        el('button', { class: 'btn block', type: 'button', onclick: closeDialog }, 'Отмена'));

    const show = el('button', { class: 'btn block', type: 'button' }, 'Показать сид-фразу');
    show.addEventListener('click', () => askPassword('Показать сид-фразу', 'Убедитесь, что рядом никого нет и экран не записывается.', [], 'Показать', async (d) => {
        const r = await post('security/seed/show', { password: d.password });
        openDialog(el('h3', {}, 'Сид-фраза банка'), seedGrid(r.seed), WARN(),
            el('button', { class: 'btn primary block', type: 'button', onclick: closeDialog }, 'Скрыть'));
    }));

    const bind = el('button', { class: 'btn primary block', type: 'button' }, info.bound ? 'Привязать заново' : 'Включить вход по сид-фразе');
    bind.addEventListener('click', () => askPassword('Вход по сид-фразе',
        'Введите фразу с вашей бумажной записи — сервер сверит её с кошельком ноды. Не знаете фразу? Сначала нажмите «Показать сид-фразу» и запишите её.',
        [field('Сид-фраза', seedInput())], 'Включить', async (d) => {
            await post('security/seed/bind', { password: d.password, seed: d.seed });
            closeDialog();
            toast('Вход по сид-фразе включён');
            reload();
        }));

    const unbind = info.bound ? el('button', { class: 'btn danger block', type: 'button' }, 'Отключить вход по сид-фразе') : null;
    if (unbind) {
        unbind.addEventListener('click', () => askPassword('Отключить вход по сид-фразе', 'Входить можно будет только паролем кошелька. Сама фраза и счета не меняются.', [], 'Отключить', async (d) => {
            await post('security/seed/unbind', { password: d.password });
            closeDialog();
            toast('Вход по сид-фразе отключён');
            reload();
        }));
    }

    body.append(
        el('p', { class: 'small muted' }, 'Сид-фраза — главный ключ банка. Владелец входит ею; сотрудники работают по своим логинам и ролям и фразу не знают.'),
        kv([
            ['Вход по сид-фразе', info.bound ? badge('включён', 'ok') : badge('выключен', 'warn')],
            ['Привязана', info.bound ? date(info.boundAt) : null],
            ['Фраза', info.bound ? el('span', { class: 'mono' }, info.hint) : null],
        ]),
        show, bind, unbind);
    return card(el('h2', {}, 'Сид-фраза'), body);
}
