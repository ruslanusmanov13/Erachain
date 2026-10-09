// Сид-фраза: мастер первого запуска (создать банк или восстановить), показ и привязка фразы владельцем.
import { get, post, downloadFile, shareFile, textToBase64 } from './api.js';
import { el, card, field, input, form, toast, date, kv, badge, copy, openDialog, closeDialog } from './ui.js';

// фраза и ключи — одной строкой Base58 (44 символа), как в кошельке Erachain
export function seedBox(seed, { copyable = true } = {}) {
    const text = String(seed).replace(/\s+/g, '');
    return el('div', { class: 'stack' },
        el('div', { class: 'seed-box' }, text),
        el('div', { class: 'tiny muted' }, `${text.length} символов Base58 · регистр важен`),
        copyable ? el('button', { class: 'btn small', type: 'button', onclick: () => copy(text, 'Скопировано — не оставляйте в буфере надолго') }, 'Копировать') : null);
}

export function seedInput(name = 'seed', attrs = {}) {
    return el('textarea', {
        name, class: 'seed-input', rows: 2, required: true, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off',
        placeholder: '44 символа Base58 одной строкой', ...attrs,
    });
}

const WARN = (client = false) => el('div', { class: 'warn-box' },
    el('b', {}, client ? 'Сид-фраза — это ваши деньги.' : 'Сид-фраза — это все деньги банка.'),
    el('ul', {},
        el('li', {}, 'Запишите её на бумаге или сохраните файл в надёжном месте. Лучше — две копии в разных местах.'),
        el('li', {}, 'Не делайте скриншот, не пересылайте в мессенджерах и почте, не храните в заметках.'),
        client
            ? el('li', {}, 'Кто знает фразу, тот распоряжается всеми 21 вашим счётом. Банк её не хранит и никогда не спросит.')
            : el('li', {}, 'Кто знает фразу, тот распоряжается всеми 21 счётом банка. Сотрудникам она не нужна — у них свой логин и пароль.'),
        el('li', {}, client ? 'Потеряете фразу — войти можно будет только по ключам счетов из файла.' : 'Потеряете фразу и пароль кошелька — доступ к счетам не восстановить.')));

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
        toast('Банк создан: 21 счёт. Выберите счёт для входа в кабинет');
        onDone(r.token, r.keys ? '#/keys' : '#/home');
    };

    const start = () => step(
        el('h2', {}, 'Добро пожаловать'),
        el('p', { class: 'small muted' }, 'На ноде Erachain ещё нет кошелька банка. Создайте новый банк или восстановите существующий по сид-фразе. Тот, кто это делает, становится владельцем.'),
        el('div', { class: 'choice' },
            el('button', { class: 'btn primary', type: 'button', onclick: newSeed }, el('b', {}, 'Создать новый банк'), el('span', {}, 'Сгенерируем сид-фразу — главный ключ банка')),
            el('button', { class: 'btn', type: 'button', onclick: restore }, el('b', {}, 'Восстановить по сид-фразе'), el('span', {}, 'Фраза из этого приложения или кошелька Erachain'))));

    async function newSeed() {
        let seed;
        let keys;
        try {
            ({ seed, keys } = await post('setup/seed'));
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
            el('p', { class: 'small muted' }, 'Из этой фразы будут созданы 21 счёт банка с приватными ключами. Различайте заглавные и строчные буквы.'),
            seedBox(seed, { copyable: false }),
            keys ? fileButtons({ seed, keys, name: 'Владелец банка' }, { copyText: seed, copyLabel: 'Копировать фразу' }) : null,
            WARN(),
            el('label', { class: 'check-row' }, agree, el('span', {}, 'Я записал(а) или сохранил(а) сид-фразу и понимаю, что без неё доступ к деньгам не восстановить')),
            next,
            el('button', { class: 'btn block', type: 'button', onclick: start }, 'Назад'));
    }

    function verify(seed) {
        // три случайных фрагмента по 4 символа: «символы 9–12» и т. п.
        const parts = Math.floor(seed.length / 4);
        const picks = [];
        while (picks.length < 3) {
            const i = Math.floor(Math.random() * parts);
            if (!picks.includes(i)) picks.push(i);
        }
        picks.sort((a, b) => a - b);
        const label = (i) => `Символы ${i * 4 + 1}–${i * 4 + 4}`;
        step(
            el('h2', {}, 'Шаг 2 из 3. Проверка записи'),
            el('p', { class: 'small muted' }, 'Введите указанные символы фразы по вашей записи — так мы убедимся, что она записана без ошибок.'),
            form([
                el('div', { class: 'seed-check' }, picks.map((i) => field(label(i), input('g' + i, { required: true, maxlength: 4, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' })))),
            ], 'Проверить', async (d) => {
                const bad = picks.filter((i) => (d['g' + i] || '').trim() !== seed.slice(i * 4, i * 4 + 4));
                if (bad.length) throw new Error(`Не совпадает: ${bad.map(label).join(', ').toLowerCase()} — сверьтесь с записью (регистр важен)`);
                passwordStep(seed);
            }),
            el('button', { class: 'btn block', type: 'button', onclick: () => newSeedShow(seed) }, 'Показать фразу ещё раз'));
    }

    function newSeedShow(seed) {
        step(el('h2', {}, 'Сид-фраза'), seedBox(seed), el('button', { class: 'btn primary block', type: 'button', onclick: () => verify(seed) }, 'Дальше'));
    }

    function passwordStep(seed) {
        step(
            el('h2', {}, 'Шаг 3 из 3. Пароль кошелька'),
            el('p', { class: 'small muted' }, 'Нода создаст кошелёк банка из сид-фразы — 21 счёт — и зашифрует его этим паролем. Входить вы сможете сид-фразой, приватным ключом любого счёта или этим паролем.'),
            form(passwordFields(setup.needCode), 'Создать банк', async (d) => {
                checkPasswords(d);
                await create(seed, d);
            }));
    }

    function restore() {
        step(
            el('h2', {}, 'Восстановление по сид-фразе'),
            el('p', { class: 'small muted' }, 'Нода восстановит из фразы 21 счёт банка. Остатки и история подтянутся из блокчейна после синхронизации ноды.'),
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
        openDialog(el('h3', {}, 'Сид-фраза банка'), seedBox(r.seed), WARN(),
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
            ['Счетов с ключами', info.bound ? String(info.accounts) : null],
        ]),
        info.bound ? el('a', { class: 'btn soft block', href: '#/keys' }, '21 ключ и кабинеты счетов') : null,
        show, bind, unbind);
    return card(el('h2', {}, 'Сид-фраза'), body);
}

// ---------- файл счёта ----------

// текст файла: фраза (если есть) и 21 счёт с приватными ключами
export function accountFile({ seed = null, keys, name = '' }) {
    const lines = [
        'БАНК ERACHAIN — ДАННЫЕ СЧЁТА',
        `Создан: ${new Date().toLocaleString('ru-RU')}` + (name ? ` · ${name}` : ''),
        '',
        'Храните файл в надёжном месте (лучше — распечатайте и удалите с устройства).',
        'Кто знает сид-фразу, распоряжается всеми 21 счётом. Кто знает приватный ключ — этим счётом.',
        '',
    ];
    if (seed) lines.push('СИД-ФРАЗА (вход в банк и восстановление всех счетов):', String(seed).replace(/\s+/g, ''), '');
    lines.push(`ОСНОВНОЙ СЧЁТ №1 (для пополнения): ${keys[0].address}`, '', 'СЧЕТА И ПРИВАТНЫЕ КЛЮЧИ:');
    for (const k of keys) lines.push(`№${String(k.n).padStart(2, ' ')}  ${k.address}  ${k.privateKey || ''}`.trimEnd());
    lines.push('', 'Ключи совместимы с кошельком Erachain (импорт счёта по ключу, восстановление по сид-фразе).');
    return { filename: `erachain-${keys[0].address.slice(0, 10)}.txt`, text: lines.join('\r\n') + '\r\n' };
}

// три кнопки: «Скачать файлом», «Сохранить», «Копировать»
export function fileButtons(data, { copyText, copyLabel = 'Копировать' } = {}) {
    const f = accountFile(data);
    const b64 = () => textToBase64(f.text);
    const run = (fn) => async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
            await fn();
        } catch (err) {
            toast(err.message || 'Не удалось сохранить файл');
        } finally {
            btn.disabled = false;
        }
    };
    return el('div', { class: 'file-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: run(async () => {
            const where = await downloadFile(f.filename, b64(), 'text/plain; charset=utf-8');
            if (where) toast('Файл сохранён: ' + where);
        }) }, 'Скачать файлом'),
        el('button', { class: 'btn', type: 'button', onclick: run(() => shareFile(f.filename, b64(), 'text/plain; charset=utf-8')) }, 'Сохранить'),
        el('button', { class: 'btn', type: 'button', onclick: run(() => copy(copyText || f.text, 'Скопировано — не оставляйте в буфере надолго')) }, copyLabel));
}

function keysList(keys) {
    return el('details', { class: 'keys-details' },
        el('summary', {}, `Все 21 счёт и приватные ключи`),
        el('div', { class: 'list' }, keys.map((k) => el('div', { class: 'list-item key-row' },
            el('div', { class: 'icon-circle' }, String(k.n)),
            el('div', { class: 'grow' },
                el('div', { class: 'title mono small' }, k.address),
                el('div', { class: 'sub mono tiny' }, k.privateKey))))));
}

/** Регистрация: создать счёт (новая фраза и 21 ключ) или подключить свою фразу. onDone(token, hash) — вход. */
export function registerView(onDone) {
    const box = el('div', {});
    const step = (...children) => box.replaceChildren(...children);

    const register = async (seed, name, device, pin) => {
        if (device) {
            // кошелёк на устройстве: банку уходят только публичные ключи и подпись
            const { walletLogin, saveVault } = await import('./wallet/session.js');
            const { deriveAccounts } = await import('./wallet/keys.js');
            const r = await walletLogin(deriveAccounts(seed));
            if (pin) await saveVault(seed, pin);
            toast('Кошелёк открыт. Ключи — только на этом устройстве');
            onDone(r.token, '#/keys');
            return;
        }
        const r = await post('register', { seed, name });
        toast('Счёт открыт. Добро пожаловать!');
        onDone(r.token, '#/keys');
    };

    const deviceBox = () => el('label', { class: 'check-row' }, el('input', { type: 'checkbox', name: 'device', value: '1' }),
        el('span', {}, 'Ключи только на этом устройстве — фраза создаётся на телефоне и не отправляется в банк, операции подписываются здесь'));

    const start = () => step(
        el('p', { class: 'muted small' }, 'Создайте счёт: будет сгенерирована сид-фраза и 21 счёт с приватными ключами (стандарт Erachain). Сид-фраза — ваш вход в банк.'),
        form([
            field('Ваше имя или организация', input('name', { maxlength: 120, autocomplete: 'name', placeholder: 'Необязательно' })),
            deviceBox(),
        ], 'Создать счёт', async (d) => {
            if (d.device) {
                const { generateSeed, deriveAccounts } = await import('./wallet/keys.js');
                const seed = generateSeed();
                created(seed, deriveAccounts(seed), d.name.trim(), true);
                return;
            }
            const r = await post('register/new');
            created(r.seed, r.keys, d.name.trim());
        }),
        el('p', { class: 'center' }, el('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); own(); } }, 'У меня уже есть сид-фраза Erachain')));

    function created(seed, keys, name, device = false) {
        const agree = el('input', { type: 'checkbox' });
        const pin = device ? input('pin', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: '4–12 цифр' }) : null;
        const next = el('button', { class: 'btn primary block', type: 'button', disabled: true }, 'Зарегистрироваться и войти');
        agree.addEventListener('change', () => { next.disabled = !agree.checked; });
        const err = el('p', { class: 'error' });
        next.addEventListener('click', async () => {
            next.disabled = true;
            err.textContent = '';
            try {
                await register(seed, name, device, pin && pin.value.trim());
            } catch (e) {
                err.textContent = e.message;
                next.disabled = false;
            }
        });
        step(
            el('h3', {}, device ? 'Ваш кошелёк на устройстве' : 'Ваш новый счёт'),
            device ? el('p', { class: 'tiny muted' }, 'Фраза и ключи созданы на этом устройстве. Банк их не получал и восстановить не сможет — сохраните файл.') : null,
            el('div', { class: 'tiny muted' }, 'Сид-фраза'),
            seedBox(seed, { copyable: false }),
            kv([['Основной счёт №1', el('span', { class: 'mono small' }, keys[0].address)]]),
            fileButtons({ seed, keys, name }, { copyText: seed, copyLabel: 'Копировать фразу' }),
            el('p', { class: 'tiny muted' }, '«Скачать файлом» — файл с фразой и 21 ключом в «Документы» или «Загрузки». «Сохранить» — на диск, в Telegram или почту. «Копировать фразу» — в буфер обмена.'),
            keysList(keys),
            WARN(true),
            device ? field('PIN для быстрого входа на этом устройстве (необязательно)', pin, 'Фраза сохранится на телефоне в зашифрованном виде') : null,
            el('label', { class: 'check-row' }, agree, el('span', {}, 'Я сохранил(а) сид-фразу — без неё доступ к счетам не восстановить')),
            err, next,
            el('button', { class: 'btn block', type: 'button', onclick: start }, 'Назад'));
    }

    function own() {
        step(
            el('p', { class: 'muted small' }, 'Подключите свою сид-фразу Erachain: её 21 счёт будет обслуживаться банком, а входить вы будете этой фразой.'),
            form([
                field('Сид-фраза', seedInput()),
                field('Ваше имя или организация', input('name', { maxlength: 120, placeholder: 'Необязательно' })),
                deviceBox(),
            ], 'Зарегистрироваться и войти', async (d) => register(d.seed.replace(/\s+/g, ''), d.name.trim(), !!d.device)),
            el('button', { class: 'btn block', type: 'button', onclick: start }, 'Назад'));
    }

    start();
    return box;
}

// ---------- кошелёк на устройстве: разблокировка ----------

/** Кошелёк на устройстве заблокирован (перезагрузка страницы) — попросить PIN или фразу. Возвращает true, если открыт. */
export async function ensureUnlocked() {
    const { deviceKeys, vaultInfo, openVault, unlockWithSeed } = await import('./wallet/session.js');
    const { state } = await import('./state.js');
    if (!state.me || state.me.user.role !== 'wallet' || deviceKeys()) return true;
    const first = state.me.user.addresses[0];
    const vault = vaultInfo();
    return new Promise((resolve) => {
        const dialog = document.getElementById('dialog');
        let done = false;
        dialog.addEventListener('close', () => resolve(done), { once: true });
        const usePin = vault && vault.address === first;
        openDialog(
            el('h3', {}, 'Разблокировать кошелёк'),
            el('p', { class: 'small muted' }, usePin ? 'Введите PIN этого устройства — ключи откроются только на телефоне.' : 'Введите сид-фразу кошелька — она останется на этом устройстве.'),
            form([
                usePin ? field('PIN', input('pin', { type: 'password', inputmode: 'numeric', autocomplete: 'off', required: true }))
                    : field('Сид-фраза', seedInput()),
            ], 'Разблокировать', async (d) => {
                unlockWithSeed(usePin ? await openVault(d.pin) : d.seed, first);
                done = true;
                closeDialog();
            }),
            el('button', { class: 'btn block', type: 'button', onclick: closeDialog }, 'Отмена'));
    });
}

// подписать на устройстве; если кошелёк заблокирован — разблокировать и повторить
export async function withDeviceKeys(fn) {
    try {
        return await fn();
    } catch (e) {
        if (!e.locked) throw e;
        if (!(await ensureUnlocked())) throw new Error('Кошелёк не разблокирован');
        return fn();
    }
}
