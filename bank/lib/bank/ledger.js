'use strict';

/**
 * Выписка для учёта: точные суммы (целые единицы с 8 знаками, без ошибок float), остатки на начало и
 * конец периода, комиссии сети отдельными строками (для COMPU), реквизиты контрагентов по справочнику.
 *
 * Остатки считаются от текущего баланса назад: конец периода = сейчас − изменения после периода,
 * начало = конец − изменения за период. Неподтверждённые транзакции в учёт не идут.
 */

const SCALE = 8n;
const ONE = 10n ** SCALE;

function units(v) {
    const s = String(v ?? '0').trim();
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace(/^[-+]/, '').split('.');
    const u = BigInt((i || '0') + f.padEnd(8, '0').slice(0, 8));
    return neg ? -u : u;
}

// единицы → строка с scale знаками (округление половины вверх по модулю)
function fmt(u, scale = 8) {
    const neg = u < 0n;
    let a = neg ? -u : u;
    const drop = 10n ** (SCALE - BigInt(scale));
    if (drop > 1n) a = (a + drop / 2n) / drop;
    const s = a.toString().padStart(scale + 1, '0');
    const r = scale ? s.slice(0, -scale) + '.' + s.slice(-scale) : s;
    return (neg && a !== 0n ? '-' : '') + r;
}

const round = (u, scale) => units(fmt(u, scale));

// изменение остатка актива на счёте от одной транзакции
function deltaOf(o, address, asset) {
    let d = 0n;
    if (o.amount && Number(o.asset) === asset) {
        if (o.to === address && o.from !== address) d += units(o.amount);
        else if (o.from === address && o.to !== address) d -= units(o.amount);
    }
    if (asset === 2 && o.from === address && o.fee && units(o.fee) > 0n) d -= units(o.fee);
    return d;
}

/**
 * history — операции счёта (новые первыми), current — текущий остаток актива (строка) или null,
 * limited — история могла быть обрезана (тогда остатки не считаются).
 */
function buildStatement({ history, address, asset, from, to, current = null, limited = false }) {
    const confirmed = history.filter((o) => (o.confirmations ?? 1) > 0);
    const inPeriod = confirmed.filter((o) => (o.timestamp || 0) >= from && (o.timestamp || 0) <= to);
    const ops = [];
    for (const o of [...inPeriod].reverse()) { // по времени
        if (asset === null || (o.amount && Number(o.asset) === asset)) {
            const self = o.from === o.to;
            if (!self || asset === null) ops.push({ ...o, exact: o.amount ? fmt(units(o.amount)) : null, direction: o.to === address && o.from !== address ? 'in' : 'out' });
        }
        // комиссия сети списывается в COMPU — в выписке по COMPU отдельной строкой, чтобы сошлись остатки
        if (asset === 2 && o.from === address && o.fee && units(o.fee) > 0n) {
            ops.push({
                ...o, isFee: true, type: 'Комиссия сети', direction: 'out', asset: 2, assetName: o.assetName || 'COMPU', amount: fmt(units(o.fee)),
                exact: fmt(units(o.fee)), to: 'Erachain', title: 'Комиссия сети' + (o.seqNo ? ' за транзакцию ' + o.seqNo : ''), message: '',
                seqNo: o.seqNo ? o.seqNo + '-К' : null,
            });
        }
    }
    let inSum = 0n;
    let outSum = 0n;
    for (const o of ops) {
        if (!o.exact) continue;
        if (o.direction === 'in') inSum += units(o.exact);
        else outSum += units(o.exact);
    }
    let opening = null;
    let closing = null;
    if (asset !== null && current !== null && !limited) {
        const after = confirmed.filter((o) => (o.timestamp || 0) > to).reduce((s, o) => s + deltaOf(o, address, asset), 0n);
        closing = units(current) - after;
        const during = inPeriod.reduce((s, o) => s + deltaOf(o, address, asset), 0n);
        opening = closing - during;
    }
    return { ops, inSum, outSum, opening, closing };
}

module.exports = { buildStatement, units, fmt, round, deltaOf };
