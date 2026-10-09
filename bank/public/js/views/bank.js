import { get, post, put, patch, download } from '../api.js';
import { el, card, field, input, select, form, tabs, fmt, short, date, kv, empty, spinner, toast, confirm, badge, pickFile, fileToBase64, openDialog, closeDialog } from '../ui.js';
import { state, accountSelect, loadAccounts } from '../state.js';

const DEPOSIT_STATUS = {
    new: ['к зачислению', 'warn'], review: ['нет адреса', 'bad'], processing: ['зачисляется…', 'warn'],
    credited: ['зачислено', 'ok'], rejected: ['отклонено', ''],
};
const WITHDRAW_STATUS = {
    new: ['новая', 'warn'], invalid: ['ошибка реквизитов', 'bad'], exported: ['выгружена в банк', 'warn'],
    paid: ['оплачена', 'ok'], refunded: ['возвращена', ''], processing: ['обработка…', 'warn'],
};

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

// ---------- выписки ----------

function statements() {
    const assets = new Map([[1, 'ERA'], [2, 'COMPU']]);
    for (const a of state.accounts) for (const b of a.balances) assets.set(b.asset, b.name);
    return card(form([
        el('p', { class: 'small muted' }, 'Выписка операций по счёту для бухгалтерии и банков. Формат 1С загружается в 1С:Бухгалтерию через «Банк и касса → Обмен с банком».'),
        field('Счёт', accountSelect('address')),
        field('Актив', select('asset', [{ value: '', label: 'Все активы' }, ...[...assets].map(([k, n]) => ({ value: k, label: `${n} (№${k})` }))], 1)),
        el('div', { class: 'grid-2' }, field('С', input('from', { type: 'date', value: monthAgo() })), field('По', input('to', { type: 'date', value: today() }))),
        field('Формат', select('format', [
            { value: '1c', label: '1С: 1CClientBankExchange (Windows-1251)' },
            { value: 'camt053', label: 'ISO 20022 camt.053 (XML)' },
            { value: 'csv', label: 'CSV для Excel' },
        ], '1c')),
    ], 'Выгрузить выписку', async (d) => {
        const q = new URLSearchParams({ address: d.address, format: d.format, from: d.from, to: d.to });
        if (d.asset) q.set('asset', d.asset);
        const name = await download('GET', 'bank/statement?' + q);
        toast('Файл готов: ' + name);
    }));
}

// ---------- поступления (ввод) ----------

async function deposits() {
    const settings = await get('bank/settings');
    const box = el('div', {}, spinner());
    const load = async () => {
        const list = await get('bank/deposits');
        box.replaceChildren(list.length ? el('div', { class: 'list' }, list.map((d) => depositItem(d, settings, load))) : empty('Поступлений пока нет. Загрузите выписку из банка.'));
    };
    const importBtn = el('button', { class: 'btn primary', type: 'button' }, 'Загрузить выписку банка');
    importBtn.addEventListener('click', async () => {
        const f = await pickFile('.txt,.xml,text/plain,application/xml,text/xml');
        if (!f) return;
        importBtn.disabled = true;
        try {
            const r = await post('bank/import', { content: await fileToBase64(f) });
            toast(`Найдено поступлений: ${r.found}, новых: ${r.added}`);
            await load();
        } catch (e) {
            toast(e.message);
        } finally {
            importBtn.disabled = false;
        }
    });
    load().catch((e) => box.replaceChildren(el('p', { class: 'error' }, e.message)));
    return el('div', { class: 'stack' },
        card(el('h2', {}, 'Ввод денег через банк'),
            el('p', { class: 'small muted pre-line' },
                `1. Клиент переводит деньги на расчётный счёт ${settings.organization.account || '(укажите в настройках шлюза)'} и пишет в назначении платежа свой адрес Erachain.\n` +
                '2. Загрузите выписку банка (1С или ISO 20022 camt.053/camt.054) или подключите вебхук банка.\n' +
                `3. Подтвердите зачисление — клиент получит токен ${settings.tokenAsset ? '№' + settings.tokenAsset : ''} со счёта шлюза.`),
            el('div', { class: 'row wrap' }, importBtn)),
        card(box));
}

function depositItem(d, settings, reload) {
    const [label, kind] = DEPOSIT_STATUS[d.status] || [d.status, ''];
    const actions = el('div', { class: 'row wrap' });
    if (d.status === 'new') {
        const credit = el('button', { class: 'btn small primary', type: 'button' }, 'Зачислить');
        credit.addEventListener('click', async () => {
            if (!(await confirm(`Зачислить ${fmt(d.amount, 2)} ${settings.currency} токенами на ${d.address}?`))) return;
            credit.disabled = true;
            try {
                await post(`bank/deposits/${d.id}/credit`);
                toast('Зачислено');
                await loadAccounts();
                await reload();
            } catch (e) {
                toast(e.message);
                credit.disabled = false;
            }
        });
        actions.append(credit);
    }
    if (d.status === 'new' || d.status === 'review') {
        actions.append(
            el('button', { class: 'btn small', type: 'button', onclick: () => setAddress(d, reload) }, d.address ? 'Изменить адрес' : 'Указать адрес'),
            el('button', { class: 'btn small danger', type: 'button', onclick: async () => {
                if (!(await confirm('Отклонить поступление? Деньги нужно будет вернуть плательщику через банк.'))) return;
                await patch('bank/deposits/' + d.id, { status: 'rejected' }).catch((e) => toast(e.message));
                reload();
            } }, 'Отклонить'));
    }
    return el('div', { class: 'list-item' },
        el('div', { class: 'grow stack' },
            el('div', { class: 'row between' }, el('b', { class: 'num' }, `${fmt(d.amount, 2)} ${d.currency}`), badge(label, kind)),
            el('div', { class: 'small' }, d.payer || 'Плательщик не указан'),
            el('div', { class: 'tiny muted' }, `${date(d.date)} · ${d.purpose}`),
            d.address ? el('div', { class: 'tiny mono' }, '→ ' + d.address) : null,
            d.error ? el('div', { class: 'tiny out' }, d.error) : null,
            actions.children.length ? actions : null));
}

function setAddress(d, reload) {
    openDialog(el('h3', {}, 'Адрес получателя токенов'), form([
        el('p', { class: 'small muted' }, `${d.payer}: ${d.purpose}`),
        field('Адрес Erachain', input('address', { value: d.address, required: true, spellcheck: 'false' })),
    ], 'Сохранить', async (f) => {
        await patch('bank/deposits/' + d.id, { address: f.address.trim() });
        closeDialog();
        reload();
    }));
}

// ---------- вывод ----------

async function withdrawals() {
    const settings = await get('bank/settings');
    const box = el('div', {}, spinner());
    const load = async () => {
        const list = await get('bank/withdrawals');
        box.replaceChildren(list.length ? el('div', { class: 'list' }, list.map((w) => withdrawItem(w, settings, load))) : empty('Заявок на вывод нет'));
    };
    const scan = el('button', { class: 'btn primary', type: 'button' }, 'Проверить новые заявки');
    scan.addEventListener('click', async () => {
        scan.disabled = true;
        try {
            const r = await post('bank/withdrawals/scan');
            toast(`Новых заявок: ${r.added}` + (r.pending ? `, ждут подтверждения: ${r.pending}` : ''));
            await load();
        } catch (e) {
            toast(e.message);
        } finally {
            scan.disabled = false;
        }
    });
    const exportBtn = (format, label) => {
        const b = el('button', { class: 'btn', type: 'button' }, label);
        b.addEventListener('click', async () => {
            if (!(await confirm('Выгрузить все новые заявки в платёжные поручения? После выгрузки они получат статус «выгружена в банк».'))) return;
            b.disabled = true;
            try {
                const name = await download('POST', 'bank/withdrawals/export', { format });
                toast('Файл готов: ' + name);
                await load();
            } catch (e) {
                toast(e.message);
            } finally {
                b.disabled = false;
            }
        });
        return b;
    };
    load().catch((e) => box.replaceChildren(el('p', { class: 'error' }, e.message)));
    return el('div', { class: 'stack' },
        card(el('h2', {}, 'Вывод денег в банк'),
            el('p', { class: 'small muted pre-line' },
                `1. Клиент переводит токены на счёт шлюза ${settings.gatewayAccount ? short(settings.gatewayAccount) : '(не настроен)'} и пишет в сообщении реквизиты:\n` +
                'ВЫВОД;Получатель;ИНН;Счёт (20 цифр);БИК\n' +
                '2. «Проверить новые заявки» — найдёт подтверждённые переводы.\n' +
                '3. Выгрузите платёжные поручения в 1С или в банк (ISO 20022 pain.001), после оплаты отметьте заявки.'),
            el('div', { class: 'row wrap' }, scan, exportBtn('1c', 'Поручения для 1С'), exportBtn('pain001', 'ISO 20022 pain.001'))),
        card(box));
}

function withdrawItem(w, settings, reload) {
    const [label, kind] = WITHDRAW_STATUS[w.status] || [w.status, ''];
    const r = w.requisites || {};
    const act = (text, path, confirmText, cls = '') => {
        const b = el('button', { class: 'btn small ' + cls, type: 'button' }, text);
        b.addEventListener('click', async () => {
            if (!(await confirm(confirmText))) return;
            b.disabled = true;
            try {
                await post(path);
                await reload();
            } catch (e) {
                toast(e.message);
                b.disabled = false;
            }
        });
        return b;
    };
    const actions = el('div', { class: 'row wrap' });
    if (['new', 'exported'].includes(w.status)) actions.append(act('Оплачена', `bank/withdrawals/${w.id}/paid`, `Банк перечислил ${fmt(w.amount, 2)} ${settings.currency} получателю ${r.name}?`, 'primary'));
    if (['new', 'invalid', 'exported'].includes(w.status)) actions.append(act('Вернуть токены', `bank/withdrawals/${w.id}/refund`, `Вернуть ${fmt(w.amount, 2)} токенов отправителю ${short(w.from)}?`, 'danger'));
    return el('div', { class: 'list-item' },
        el('div', { class: 'grow stack' },
            el('div', { class: 'row between' }, el('b', { class: 'num' }, `${fmt(w.amount, 2)} ${settings.currency}`), badge(label, kind)),
            el('div', { class: 'small' }, r.name || '—', r.account ? ` · сч. ${r.account}` : '', r.bic ? ` · БИК ${r.bic}` : ''),
            el('div', { class: 'tiny muted' }, `${date(w.timestamp)} · от ${short(w.from)} · №${w.seqNo || '—'}${w.batch ? ' · пакет ' + w.batch : ''}`),
            w.error ? el('div', { class: 'tiny out' }, w.error) : null,
            actions.children.length ? actions : null));
}

// ---------- настройки шлюза ----------

async function gatewaySettings() {
    const s = await get('bank/settings');
    const o = s.organization;
    return el('div', { class: 'stack' },
        card(form([
            el('h2', {}, 'Токен и счёт шлюза'),
            el('p', { class: 'small muted' }, 'Токен — актив, обеспеченный деньгами на расчётном счёте (например, «цифровой рубль» с точностью 2). Счёт шлюза — счёт в кошельке ноды, на котором хранится выпуск токена.'),
            el('div', { class: 'grid-2' },
                field('Номер актива-токена', input('tokenAsset', { inputmode: 'numeric', value: s.tokenAsset ?? '' })),
                field('Валюта (ISO 4217)', input('currency', { value: s.currency, maxlength: 3 }))),
            field('Счёт шлюза', accountSelect('gatewayAccount', s.gatewayAccount)),
            el('h2', {}, 'Реквизиты организации'),
            field('Наименование', input('name', { value: o.name })),
            el('div', { class: 'grid-2' }, field('ИНН', input('inn', { value: o.inn, inputmode: 'numeric' })), field('КПП', input('kpp', { value: o.kpp, inputmode: 'numeric' }))),
            field('Расчётный счёт', input('account', { value: o.account, inputmode: 'numeric' })),
            field('Банк', input('bank', { value: o.bank })),
            el('div', { class: 'grid-2' }, field('БИК', input('bic', { value: o.bic, inputmode: 'numeric' })), field('Корр. счёт', input('corr', { value: o.corr, inputmode: 'numeric' }))),
            field('Счёт для выписок в 1С', input('account1C', { value: o.account1C }), 'Номер, под которым счёт блокчейна заведён в 1С. Если пусто — адрес Erachain.'),
        ], 'Сохранить', async (d) => {
            await put('bank/settings', {
                tokenAsset: d.tokenAsset.trim() || null, currency: d.currency, gatewayAccount: d.gatewayAccount,
                organization: { name: d.name, inn: d.inn, kpp: d.kpp, account: d.account, bank: d.bank, bic: d.bic, corr: d.corr, account1C: d.account1C },
            });
            toast('Настройки сохранены');
        })),
        card(el('h2', {}, 'Вебхук банка'), el('p', { class: 'small muted pre-line' },
            'Банк или платёжный агрегатор может сообщать о поступлениях автоматически:\n' +
            'POST /api/bank/webhook с заголовком X-Signature: sha256=HMAC-SHA256(тело, секрет)\n' +
            'Тело: {"id","date","amount","currency","payer","purpose"} или массив таких объектов.\n' +
            'Секрет задаётся переменной BANK_WEBHOOK_SECRET на сервере банка. Поступления из вебхука ждут подтверждения зачисления здесь, во вкладке «Поступления».')),
        card(el('h2', {}, 'Текущие настройки'), kv([['Токен', s.tokenAsset ? '№' + s.tokenAsset : 'не задан'], ['Счёт шлюза', s.gatewayAccount ? el('span', { class: 'mono small' }, s.gatewayAccount) : 'не задан']])));
}

export default {
    title: 'Банк',
    async render(params) {
        const views = { statements, deposits, withdrawals, settings: gatewaySettings };
        let mode = params[0] === 'gateway' ? 'deposits' : params[0];
        if (!views[mode]) mode = 'statements';
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
        const sbpLink = el('a', { class: 'menu-tile sbp-link', href: '#/sbp' },
            el('b', {}, 'Приём платежей по СБП →'), el('span', { class: 'muted' }, 'QR-код для оплаты рублями из любого банка с начислением актива в Erachain'));
        return el('div', { class: 'stack' }, sbpLink,
            el('div', {}, tabs([['statements', 'Выписки'], ['deposits', 'Поступления'], ['withdrawals', 'Вывод'], ['settings', 'Шлюз']], mode, show), body));
    },
};
