// Отчёты банка: за сутки, хеш записан в блокчейн Erachain, цепочка хешей, проверка файла.
import { get, post, put, download } from '../api.js';
import { el, card, field, input, form, date, kv, empty, toast, badge, pickFile, fileToBase64 } from '../ui.js';
import { accountSelect, can, loadAccounts, state } from '../state.js';

const STATUS = { made: ['ждёт записи в блокчейн', 'warn'], anchored: ['записан, ждёт блока', 'warn'], confirmed: ['в блокчейне', 'ok'] };

export async function reportsView() {
    const [v] = await Promise.all([get('reports'), state.accounts.length ? null : loadAccounts()]);
    const s = v.settings;
    const box = el('div', { class: 'stack' });
    const reload = async () => box.replaceWith(await reportsView());

    const verifyOut = el('div', {});
    const verify = el('button', { class: 'btn soft block', type: 'button' }, 'Проверить файл отчёта');
    verify.addEventListener('click', async () => {
        const f = await pickFile('application/json,.json');
        if (!f) return;
        try {
            const r = await post('reports/verify', { base64: await fileToBase64(f) });
            verifyOut.replaceChildren(el('div', { class: r.anchored ? 'ok-box' : 'warn-box' },
                r.anchored ? `✓ Отчёт за ${r.date} подлинный: его хеш записан в блокчейн ${date(r.onChain[0].timestamp)} (${r.onChain[0].seqNo || r.onChain[0].signature}).`
                    : r.changed ? `✕ Отчёт за ${r.date} изменён: такого хеша нет ни у банка, ни в блокчейне.` : `✕ Хеш ${r.hash} в блокчейне не найден.`));
        } catch (e) {
            toast(e.message);
        }
    });

    box.append(card(
        el('h2', {}, 'Отчёты в блокчейне'),
        el('p', { class: 'small muted' }, 'Раз в сутки банк собирает отчёт: остатки, операции СБП, счета, выдачи магазинов, сделки, шлюз и журнал действий. Файл остаётся у банка, а его хеш SHA-256 записывается в блокчейн. Каждый отчёт содержит хеш предыдущего, поэтому подменить или удалить отчёт задним числом незаметно нельзя.'),
        verify, verifyOut));

    const list = v.reports.length ? el('div', { class: 'list' }, v.reports.map((r) => {
        const [label, kind] = STATUS[r.status] || [r.status, ''];
        return el('div', { class: 'list-item' }, el('div', { class: 'grow stack' },
            el('div', { class: 'row between' }, el('b', {}, 'Сутки ' + r.date), badge(label, kind)),
            el('div', { class: 'tiny mono muted' }, 'SHA-256 ' + r.hash),
            r.summary ? el('div', { class: 'tiny' }, `СБП ${r.summary.sbp} · счетов ${r.summary.invoicesIssued}/${r.summary.invoicesPaid} · выдач ${r.summary.deliveries} · сделок ${r.summary.trades} · действий ${r.summary.audit}`) : null,
            r.error ? el('div', { class: 'tiny out' }, r.error) : null,
            el('div', {}, el('button', { class: 'btn small', type: 'button', onclick: async () => {
                try {
                    toast('Сохранён файл ' + (await download('GET', `reports/${r.id}/file`)));
                } catch (e) {
                    toast(e.message);
                }
            } }, 'Скачать файл'))));
    })) : empty('Отчётов пока нет');
    const run = can('sign') ? form([
        field('Отчёт за сутки', input('date', { type: 'date', value: new Date(Date.now() - 86400000).toISOString().slice(0, 10) })),
    ], 'Собрать и записать', async (d) => {
        const r = await post('reports/run', { date: d.date });
        toast(`Отчёт за ${r.date}: ${r.status === 'made' ? 'сохранён, запись в блокчейн — позже' : 'хеш записан в блокчейн'}`);
        reload();
    }) : null;
    box.append(card(el('h3', {}, 'Отчёты'), list, run));

    if (can('settings')) {
        box.append(card(form([
            el('h3', {}, 'Расписание'),
            el('label', { class: 'check-row' }, el('input', { type: 'checkbox', name: 'enabled', checked: s.enabled }), 'Собирать отчёт каждые сутки (при открытой смене)'),
            field('Счёт, с которого записывается хеш', accountSelect('account', s.account), 'Нужно немного COMPU на комиссию'),
            el('div', { class: 'grid-2' },
                field('Время сбора', input('time', { type: 'time', value: s.time })),
                field('Часовой пояс, мин от UTC', input('utcOffsetMin', { inputmode: 'numeric', value: String(s.utcOffsetMin) }))),
            kv([['Пропуски', 'если сервер был выключен, отчёты за пропущенные сутки (до 7) соберутся при включении']]),
        ], 'Сохранить', async (d, f) => {
            await put('reports/settings', { enabled: f.querySelector('[name=enabled]').checked, account: d.account, time: d.time, utcOffsetMin: Number(d.utcOffsetMin) });
            toast('Сохранено');
            reload();
        })));
    }
    return box;
}
