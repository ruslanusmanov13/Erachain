// Курсы и маркет-мейкер на бирже Erachain: агрегатор курсов, лестница ордеров, ограничения риска.
import { get, post, put } from '../api.js';
import { el, card, field, input, form, tabs, fmt, date, kv, empty, spinner, toast, badge, confirm } from '../ui.js';
import { state, accountSelect, can, loadAccounts } from '../state.js';

const SRC = { dex: 'Стакан биржи', sevenpay: 'Обменник 7Pay', manual: 'Ручной курс' };
const assetLabel = (k) => state.assetNames.get(Number(k)) || '#' + k;

async function ratesView() {
    const box = el('div', { class: 'stack' });
    const out = el('div', {});
    box.append(card(form([
        el('h2', {}, 'Курс пары'),
        el('p', { class: 'small muted' }, 'Сколько котируемого актива за 1 базовый. Итог — медиана источников; если они расходятся сильнее допустимого, курса нет.'),
        el('div', { class: 'grid-2' }, field('Базовый актив', input('have', { inputmode: 'numeric', value: '1' })), field('Котируемый', input('want', { inputmode: 'numeric', value: '2' }))),
    ], 'Узнать курс', async (d) => {
        const r = await get(`rates?have=${encodeURIComponent(d.have)}&want=${encodeURIComponent(d.want)}`);
        out.replaceChildren(card(
            el('h3', {}, `${assetLabel(r.have)} → ${assetLabel(r.want)}`),
            r.price ? el('div', { class: 'big-num num' }, fmt(r.price, 8)) : el('p', { class: 'error' }, r.reason),
            el('div', { class: 'list' }, r.sources.map((x) => el('div', { class: 'list-item' }, el('div', { class: 'grow' }, SRC[x.name] || x.name),
                x.ok ? el('b', { class: 'num' }, fmt(x.price, 8)) : el('span', { class: 'tiny muted' }, x.error)))),
            r.deviationPct ? el('p', { class: 'tiny muted' }, `Расхождение источников: ${r.deviationPct.toFixed(2)} %`) : null));
    })), out);
    return box;
}

function pairCard(p, reload) {
    const st = p.status || {};
    const state1 = p.paused ? badge('остановлена', 'bad') : p.enabled ? badge('работает', 'ok') : badge('выключена', '');
    const act = async (path, msg) => {
        try {
            await post(path);
            toast(msg);
            reload();
        } catch (e) {
            toast(e.message);
        }
    };
    return card(
        el('div', { class: 'row between' }, el('h2', {}, `${assetLabel(p.have)} / ${assetLabel(p.want)}`), state1),
        p.paused && p.pausedReason ? el('div', { class: 'warn-box' }, p.pausedReason) : null,
        kv([
            ['Курс', st.rate ? fmt(st.rate, 8) : st.reason || '—'],
            ['Источники', p.sources.map((x) => SRC[x] || x).join(', ')],
            ['Спред · уровни · шаг', `${p.spreadPct} % · ${p.levels} · ${p.stepPct} %`],
            ['Объём уровня', fmt(p.levelSize)],
            ['За сутки', `продано ${fmt(p.soldToday)} из ${fmt(p.dailySellLimit)} · куплено ${fmt(p.boughtToday)} из ${fmt(p.dailyBuyLimit)}`],
            ['Стоп-кран', `скачок больше ${p.maxJumpPct} %`],
            ['Проверка', st.at ? date(st.at) : 'ещё не было'],
        ]),
        p.orders.length ? el('div', { class: 'list' }, p.orders.sort((a, b) => b.price - a.price).map((o) => el('div', { class: 'list-item' },
            el('div', { class: 'grow' }, el('div', { class: 'title ' + (o.side === 'ask' ? 'out' : 'in') }, `${o.side === 'ask' ? 'Продажа' : 'Покупка'} ${fmt(o.size)} по ${fmt(o.price, 8)}`),
                el('div', { class: 'sub tiny' }, `уровень ${o.level + 1} · ${o.seqNo || 'ждёт блока'}`))))) : empty('Ордеров нет'),
        st.skipped && st.skipped.length ? el('details', {}, el('summary', { class: 'small muted' }, `Не выставлено: ${st.skipped.length}`),
            el('ul', { class: 'small' }, st.skipped.map((x) => el('li', {}, x)))) : null,
        can('sign') ? el('div', { class: 'grid-2' },
            p.paused ? el('button', { class: 'btn primary block', type: 'button', onclick: () => act(`mm/${p.id}/resume`, 'Пара возобновлена') }, 'Возобновить')
                : el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
                    if (await confirm('Остановить пару и снять все её ордера?')) act(`mm/${p.id}/pause`, 'Пара остановлена');
                } }, 'Остановить'),
            can('settings') ? el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
                try {
                    await post('mm/pairs', { id: p.id, enabled: !p.enabled });
                    reload();
                } catch (e) {
                    toast(e.message);
                }
            } }, p.enabled ? 'Выключить' : 'Включить') : null,
            can('settings') ? el('button', { class: 'btn soft block', type: 'button', onclick: async () => {
                if (await confirm('Удалить пару? Её ордера будут сняты с биржи.')) act(`mm/${p.id}/remove`, 'Пара удалена');
            } }, 'Удалить') : null) : null);
}

async function pairsView() {
    const [v] = await Promise.all([get('mm'), state.accounts.length ? null : loadAccounts()]);
    const box = el('div', { class: 'stack' });
    const reload = async () => box.replaceWith(await pairsView());
    const run = el('button', { class: 'btn soft block', type: 'button' }, 'Пересчитать сейчас');
    run.addEventListener('click', async () => {
        run.disabled = true;
        try {
            const r = await post('mm/tick');
            toast(`Выставлено ордеров: ${r.reduce((s, x) => s + (x.placed || 0), 0)}`);
            reload();
        } catch (e) {
            toast(e.message);
            run.disabled = false;
        }
    });
    box.append(card(el('p', { class: 'small muted' },
        'Банк держит ордера на покупку ниже курса и на продажу выше. Ордера только пассивные: если ордер исполнился бы сразу (в том числе о другой ордер банка), он не ставится — самосделок нет. При открытой смене пересчёт раз в минуту.'),
    can('sign') ? run : null));
    for (const p of v.pairs) box.append(pairCard(p, reload));
    if (!v.pairs.length) box.append(card(empty('Пар пока нет')));
    if (can('settings')) {
        box.append(card(form([
            el('h3', {}, 'Новая пара'),
            el('div', { class: 'grid-2' }, field('Базовый актив', input('have', { inputmode: 'numeric', value: '1' })), field('Котируемый', input('want', { inputmode: 'numeric', value: '2' }))),
            field('Счёт маркет-мейкера', accountSelect('account')),
            field('Источники курса', el('div', { class: 'row wrap' }, Object.entries(SRC).map(([k, label]) => el('label', { class: 'check-row' },
                el('input', { type: 'checkbox', name: 'src_' + k, checked: k !== 'manual' }), label)))),
            el('div', { class: 'grid-2' },
                field('Спред, %', input('spreadPct', { inputmode: 'decimal', value: '2' })),
                field('Уровней с каждой стороны', input('levels', { type: 'number', min: 1, max: 10, value: '2' })),
                field('Шаг уровней, %', input('stepPct', { inputmode: 'decimal', value: '1' })),
                field('Объём уровня (базовый)', input('levelSize', { inputmode: 'decimal', value: '1' })),
                field('Продажа за сутки, не больше', input('dailySellLimit', { inputmode: 'decimal', value: '100' })),
                field('Покупка за сутки, не больше', input('dailyBuyLimit', { inputmode: 'decimal', value: '100' })),
                field('Неснижаемый остаток базового', input('reserveHave', { inputmode: 'decimal', value: '0' })),
                field('Неснижаемый остаток котируемого', input('reserveWant', { inputmode: 'decimal', value: '0' })),
                field('Запас базового: максимум', input('maxBase', { inputmode: 'decimal', value: '0' }), '0 — без ограничения'),
                field('Стоп-кран при скачке, %', input('maxJumpPct', { inputmode: 'decimal', value: '10' }))),
        ], 'Добавить пару', async (d, f) => {
            const sources = Object.keys(SRC).filter((k) => f.querySelector(`[name=src_${k}]`).checked);
            await post('mm/pairs', { ...d, sources, enabled: false });
            toast('Пара добавлена — включите её, когда проверите настройки');
            reload();
        })));
    }
    return box;
}

async function settingsView() {
    const v = await get('mm');
    const s = v.settings;
    return el('div', { class: 'stack' }, card(form([
        el('h2', {}, 'Источники курса'),
        field('Обозначения активов для 7Pay: актив=символ', el('textarea', { name: 'symbols', rows: 3, spellcheck: 'false' },
            Object.entries(s.symbols).map(([k, x]) => `${k}=${x}`).join('\n')), 'Например 1=ERA, 2=COMPU, 1048=RUB (токен, обеспеченный рублём)'),
        field('Допустимое расхождение источников, %', input('maxSourceDeviationPct', { inputmode: 'decimal', value: String(s.maxSourceDeviationPct) })),
        field('Ручные курсы: have/want=цена', el('textarea', { name: 'manual', rows: 3, spellcheck: 'false' },
            Object.entries(s.manual).map(([k, x]) => `${k}=${x.price}`).join('\n')), 'Действуют сутки с момента сохранения'),
    ], 'Сохранить', async (d) => {
        const symbols = {};
        for (const row of d.symbols.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)) {
            const [k, x] = row.split('=').map((y) => (y || '').trim());
            symbols[k] = x;
        }
        const manual = {};
        for (const k of Object.keys(s.manual)) manual[k] = null;
        for (const row of d.manual.split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
            const [k, x] = row.split('=').map((y) => (y || '').trim());
            manual[k] = x;
        }
        await put('mm/settings', { symbols, manual, maxSourceDeviationPct: d.maxSourceDeviationPct });
        toast('Сохранено');
    })), card(el('h3', {}, 'Журнал'), v.log.length ? el('div', { class: 'list' }, v.log.map((x) => el('div', { class: 'list-item' },
        el('div', { class: 'grow' }, el('div', { class: 'small ' + (x.kind === 'bad' ? 'out' : '') }, x.text), el('div', { class: 'tiny muted' }, date(x.at)))))) : empty('Пусто')));
}

export default {
    title: 'Курсы и маркет-мейкер',
    async render(params) {
        const views = { rates: ratesView, pairs: pairsView, settings: settingsView };
        const mode = views[params[0]] ? params[0] : 'pairs';
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
        const items = [['pairs', 'Маркет-мейкер'], ['rates', 'Курсы']];
        if (can('settings')) items.push(['settings', 'Настройки']);
        return el('div', {}, tabs(items, mode, show), body);
    },
};
