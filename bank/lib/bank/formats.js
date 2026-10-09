'use strict';

/**
 * Форматы обмена с банковскими и учётными системами:
 *  - CSV-выписка (Excel, Google Sheets);
 *  - 1CClientBankExchange 1.03 — выписки и платёжные поручения для 1С:Бухгалтерии (Windows-1251);
 *  - ISO 20022 camt.053.001.02 — выписка по счёту;
 *  - ISO 20022 pain.001.001.03 — пакет платёжных поручений (кредитовые переводы).
 * Плюс разбор входящих выписок банка (1С и camt.053/camt.054) для шлюза ввода средств.
 */

const { BankError } = require('../validate');

// ---------- общие помощники ----------

function pad(n) {
    return String(n).padStart(2, '0');
}

function dateRu(ts) {
    const d = new Date(ts);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function timeRu(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateIso(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function money(value, scale = 2) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(scale) : '0.00';
}

function xml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unxml(s) {
    return String(s ?? '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Однострочный текст без управляющих символов (для 1С и CSV)
function line(s, max = 210) {
    return String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

// ---------- Windows-1251 ----------

const CP1251_EXTRA = { 'Ё': 0xA8, 'ё': 0xB8, '№': 0xB9, '«': 0xAB, '»': 0xBB, '—': 0x97, '–': 0x96, ' ': 0xA0 };

function encodeCp1251(str) {
    const out = Buffer.alloc(str.length);
    let i = 0;
    for (const ch of str) {
        const c = ch.codePointAt(0);
        if (c < 0x80) out[i++] = c;
        else if (c >= 0x410 && c <= 0x44F) out[i++] = c - 0x350; // А..я → 0xC0..0xFF
        else if (CP1251_EXTRA[ch] !== undefined) out[i++] = CP1251_EXTRA[ch];
        else out[i++] = 0x3F; // '?'
    }
    return out.subarray(0, i);
}

function decodeText(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const utf8 = buf.toString('utf8');
    // если в UTF-8 есть символы замены — файл в Windows-1251 (обычно для 1С)
    if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
    return new TextDecoder('windows-1251').decode(buf);
}

// ---------- выписка по счёту ----------

/**
 * st — выписка из ledger.buildStatement: { ops, inSum, outSum, opening, closing } (суммы — в единицах 1e-8);
 * ops: [{ timestamp, seqNo, signature, type, direction:'in'|'out', from, to, amount, exact, assetName, title, message }]
 * meta: { address, assetName, from, to, organization, account, currency, scale, party(address) → реквизиты }
 */
function statementCsv(st, meta) {
    const head = ['Дата', 'Время', 'Номер', 'Операция', 'Контрагент', 'Приход', 'Расход', 'Актив', 'Назначение', 'Подпись'];
    const cell = (v) => {
        const s = String(v ?? '');
        return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const party = meta.party || (() => null);
    const rows = st.ops.map((o) => {
        const addr = o.direction === 'in' ? o.from : o.to;
        const p = party(addr);
        return [
            o.timestamp ? dateRu(o.timestamp) : '', o.timestamp ? timeRu(o.timestamp) : '', o.seqNo || '',
            o.type || '', p ? `${p.name} (${addr})` : addr,
            o.direction === 'in' ? o.exact || '' : '', o.direction === 'out' ? o.exact || '' : '',
            o.assetName || '', line([o.title, o.message].filter(Boolean).join(' — '), 1000), o.signature || '',
        ];
    });
    const title = `Выписка по счёту ${meta.address}${meta.assetName ? ' (' + meta.assetName + ')' : ''} за ${dateRu(meta.from)}–${dateRu(meta.to)}`;
    const lines = [title, head.join(';')];
    if (st.opening !== null && st.opening !== undefined) lines.push(['', '', '', 'Остаток на начало', '', '', '', meta.assetName || '', fmtUnits(st.opening), ''].map(cell).join(';'));
    lines.push(...rows.map((r) => r.map(cell).join(';')));
    lines.push(['', '', '', 'Итого обороты', '', fmtUnits(st.inSum), fmtUnits(st.outSum), meta.assetName || '', '', ''].map(cell).join(';'));
    if (st.closing !== null && st.closing !== undefined) lines.push(['', '', '', 'Остаток на конец', '', '', '', meta.assetName || '', fmtUnits(st.closing), ''].map(cell).join(';'));
    return Buffer.from('\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
}

function oneCHeader(meta, kind) {
    const now = Date.now();
    const lines = [
        '1CClientBankExchange',
        'ВерсияФормата=1.03',
        'Кодировка=Windows',
        'Отправитель=Банк Erachain',
        'Получатель=' + line(meta.receiver || '1С:Бухгалтерия'),
        'ДатаСоздания=' + dateRu(now),
        'ВремяСоздания=' + timeRu(now),
    ];
    if (kind === 'statement') {
        lines.push('ДатаНачала=' + dateRu(meta.from), 'ДатаКонца=' + dateRu(meta.to), 'РасчСчет=' + meta.account);
    } else {
        lines.push('РасчСчет=' + meta.account);
    }
    lines.push('Документ=Платежное поручение');
    return lines;
}

function oneCDocument(d) {
    return [
        'СекцияДокумент=Платежное поручение',
        'Номер=' + line(d.number, 20),
        'Дата=' + dateRu(d.date),
        'Сумма=' + money(d.amount),
        'ПлательщикСчет=' + line(d.payerAccount, 34),
        'Плательщик=' + line(d.payerName, 160),
        'ПлательщикИНН=' + line(d.payerInn, 12),
        ...(d.payerKpp ? ['ПлательщикКПП=' + line(d.payerKpp, 9)] : []),
        'Плательщик1=' + line(d.payerName, 160),
        'ПлательщикРасчСчет=' + line(d.payerAccount, 34),
        'ПлательщикБанк1=' + line(d.payerBank, 160),
        'ПлательщикБИК=' + line(d.payerBic, 9),
        'ПлательщикКорсчет=' + line(d.payerCorr, 20),
        'ПолучательСчет=' + line(d.payeeAccount, 34),
        'Получатель=' + line(d.payeeName, 160),
        'ПолучательИНН=' + line(d.payeeInn, 12),
        ...(d.payeeKpp ? ['ПолучательКПП=' + line(d.payeeKpp, 9)] : []),
        'Получатель1=' + line(d.payeeName, 160),
        'ПолучательРасчСчет=' + line(d.payeeAccount, 34),
        'ПолучательБанк1=' + line(d.payeeBank, 160),
        'ПолучательБИК=' + line(d.payeeBic, 9),
        'ПолучательКорсчет=' + line(d.payeeCorr, 20),
        ...(d.debited ? ['ДатаСписано=' + dateRu(d.date)] : []),
        ...(d.credited ? ['ДатаПоступило=' + dateRu(d.date)] : []),
        'ВидОплаты=01',
        'Очередность=5',
        'НазначениеПлатежа=' + line(d.purpose, 210),
        'КонецДокумента',
    ];
}

// точная сумма выписки ("12.34000000") → единицы 1e-8
const u8 = (s) => BigInt(String(s).replace('.', ''));

// единицы 1e-8 (BigInt) → строка
function fmtUnits(u, scale = 8) {
    const neg = u < 0n;
    let a = neg ? -u : u;
    const drop = 10n ** BigInt(8 - scale);
    if (drop > 1n) a = (a + drop / 2n) / drop;
    const s = a.toString().padStart(scale + 1, '0');
    return (neg && a !== 0n ? '-' : '') + (scale ? s.slice(0, -scale) + '.' + s.slice(-scale) : s);
}

/**
 * Выписка по счёту блокчейна в формате 1С. Счёт блокчейна — «расчётный счёт» организации: номер из
 * сопоставления счетов (по активу), иначе общий account1C, иначе адрес Erachain. Контрагенты — по
 * справочнику (наименование, ИНН, КПП, счёт, банк). 1С принимает суммы с копейками: сумма документа
 * округляется до 2 знаков, точная сумма — в назначении платежа; итоги и остатки сведены по округлённым
 * суммам, чтобы остаток на начало + поступления − списания = остаток на конец ровно.
 */
function statement1C(st, meta) {
    const org = meta.organization || {};
    const account = meta.account || org.account1C || meta.address;
    const party = meta.party || (() => null);
    const r2 = (u) => (u + (u < 0n ? -500000n : 500000n)) / 1000000n * 1000000n; // до копеек
    let inSum = 0n;
    let outSum = 0n;
    const docs = [];
    for (const o of st.ops.filter((x) => x.exact)) {
        const incoming = o.direction === 'in';
        const exact = u8(o.exact);
        const rounded = r2(exact);
        if (incoming) inSum += rounded;
        else outSum += rounded;
        const addr = incoming ? o.from : o.to;
        const p = party(addr) || {};
        const self = { name: org.name || 'Организация', inn: org.inn, kpp: org.kpp, account, bank: 'Erachain', bic: '', corr: '' };
        const other = {
            name: p.name || addr, inn: p.inn || '', kpp: p.kpp || '', account: p.account || addr,
            bank: p.bank || 'Erachain', bic: p.bic || '', corr: p.corr || '',
        };
        const payer = incoming ? other : self;
        const payee = incoming ? self : other;
        const unit = o.assetName || meta.assetName;
        const exactNote = rounded !== exact ? ` (точно ${fmtUnits(exact).replace(/\.?0+$/, '')}${unit ? ' ' + unit : ''})` : '';
        docs.push(...oneCDocument({
            number: o.seqNo || '', date: o.timestamp || Date.now(), amount: fmtUnits(rounded, 2),
            payerAccount: payer.account, payerName: payer.name, payerInn: payer.inn, payerKpp: payer.kpp, payerBank: payer.bank, payerBic: payer.bic, payerCorr: payer.corr,
            payeeAccount: payee.account, payeeName: payee.name, payeeInn: payee.inn, payeeKpp: payee.kpp, payeeBank: payee.bank, payeeBic: payee.bic, payeeCorr: payee.corr,
            purpose: ([o.title, o.message, unit && !exactNote ? `(${unit})` : ''].filter(Boolean).join(' ') || 'Перевод в Erachain') + exactNote,
            debited: !incoming, credited: incoming,
        }));
    }
    const lines = oneCHeader({ ...meta, account }, 'statement');
    const section = ['СекцияРасчСчет', 'ДатаНачала=' + dateRu(meta.from), 'ДатаКонца=' + dateRu(meta.to), 'РасчСчет=' + account];
    if (st.opening !== null && st.opening !== undefined) {
        const opening = r2(st.opening);
        section.push('НачальныйОстаток=' + fmtUnits(opening, 2));
        section.push('ВсегоПоступило=' + fmtUnits(inSum, 2), 'ВсегоСписано=' + fmtUnits(outSum, 2));
        section.push('КонечныйОстаток=' + fmtUnits(opening + inSum - outSum, 2));
    } else {
        section.push('ВсегоПоступило=' + fmtUnits(inSum, 2), 'ВсегоСписано=' + fmtUnits(outSum, 2));
    }
    section.push('КонецРасчСчет');
    lines.push(...section, ...docs, 'КонецФайла');
    return encodeCp1251(lines.join('\r\n') + '\r\n');
}

function camt053(st, meta) {
    const now = new Date();
    const id = 'ERA' + now.getTime();
    const ccy = meta.currency || 'XXX';
    const scale = meta.scale ?? 2;
    const party = meta.party || (() => null);
    const amt = (u) => fmtUnits(u < 0n ? -u : u, scale);
    const entries = st.ops.filter((o) => o.exact).map((o, i) => {
        const incoming = o.direction === 'in';
        const addr = incoming ? o.from : o.to;
        const p = party(addr);
        const pty = `<Nm>${xml(p ? p.name : addr)}</Nm>${p && p.inn ? `<Id><OrgId><Othr><Id>${xml(p.inn)}</Id><SchmeNm><Cd>TXID</Cd></SchmeNm></Othr></OrgId></Id>` : ''}`;
        const acct = `<Id><Othr><Id>${xml(p && p.account ? p.account : addr)}</Id></Othr></Id>`;
        const party1 = incoming ? `<RltdPties><Dbtr>${pty}</Dbtr><DbtrAcct>${acct}</DbtrAcct></RltdPties>` : `<RltdPties><Cdtr>${pty}</Cdtr><CdtrAcct>${acct}</CdtrAcct></RltdPties>`;
        const info = [o.title, o.message].filter(Boolean).join(' — ');
        return `      <Ntry>
        <NtryRef>${i + 1}</NtryRef>
        <Amt Ccy="${xml(ccy)}">${amt(u8(o.exact))}</Amt>
        <CdtDbtInd>${incoming ? 'CRDT' : 'DBIT'}</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><DtTm>${new Date(o.timestamp || Date.now()).toISOString()}</DtTm></BookgDt>
        <AcctSvcrRef>${xml(o.seqNo || o.signature || '')}</AcctSvcrRef>
        <BkTxCd><Prtry><Cd>${xml(o.isFee ? 'FEE' : o.type || 'TRANSFER')}</Cd><Issr>Erachain</Issr></Prtry></BkTxCd>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>${xml(o.signature || 'NOTPROVIDED')}</EndToEndId></Refs>
          ${party1}
          <RmtInf><Ustrd>${xml(line(info, 140))}</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>`;
    });
    const bal = (code, u, ts) => `      <Bal>
        <Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp>
        <Amt Ccy="${xml(ccy)}">${amt(u)}</Amt>
        <CdtDbtInd>${u < 0n ? 'DBIT' : 'CRDT'}</CdtDbtInd>
        <Dt><Dt>${dateIso(ts)}</Dt></Dt>
      </Bal>`;
    const balances = st.opening !== null && st.opening !== undefined ? [bal('OPBD', st.opening, meta.from), bal('CLBD', st.closing, meta.to)].join('\n') + '\n' : '';
    const nIn = st.ops.filter((o) => o.exact && o.direction === 'in').length;
    const nOut = st.ops.filter((o) => o.exact && o.direction !== 'in').length;
    return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>${id}</MsgId>
      <CreDtTm>${now.toISOString()}</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>${id}</Id>
      <CreDtTm>${now.toISOString()}</CreDtTm>
      <FrToDt><FrDtTm>${new Date(meta.from).toISOString()}</FrDtTm><ToDtTm>${new Date(meta.to).toISOString()}</ToDtTm></FrToDt>
      <Acct><Id><Othr><Id>${xml(meta.account || meta.address)}</Id><SchmeNm><Prtry>${meta.account ? 'BANK' : 'ERACHAIN'}</Prtry></SchmeNm></Othr></Id><Ccy>${xml(ccy)}</Ccy>${meta.organization && meta.organization.name ? `<Ownr><Nm>${xml(meta.organization.name)}</Nm></Ownr>` : ''}</Acct>
${balances}      <TxsSummry>
        <TtlNtries><NbOfNtries>${nIn + nOut}</NbOfNtries></TtlNtries>
        <TtlCdtNtries><NbOfNtries>${nIn}</NbOfNtries><Sum>${amt(st.inSum)}</Sum></TtlCdtNtries>
        <TtlDbtNtries><NbOfNtries>${nOut}</NbOfNtries><Sum>${amt(st.outSum)}</Sum></TtlDbtNtries>
      </TxsSummry>
${entries.join('\n')}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`, 'utf8');
}

// ---------- платёжные поручения на вывод ----------

/**
 * payments: [{ id, amount, name, inn, account, bic, bank, corr, purpose }]
 * org: { name, inn, kpp, account, bank, bic, corr, currency }
 */
function paymentOrders1C(payments, org, firstNumber = 1) {
    if (!org.account) throw new BankError('Укажите расчётный счёт организации в настройках шлюза');
    const lines = oneCHeader({ account: org.account, receiver: org.bank || 'Банк' }, 'orders');
    payments.forEach((p, i) => {
        lines.push(...oneCDocument({
            number: String(firstNumber + i), date: Date.now(), amount: p.amount,
            payerAccount: org.account, payerName: org.name, payerInn: org.inn, payerKpp: org.kpp, payerBank: org.bank, payerBic: org.bic, payerCorr: org.corr,
            payeeAccount: p.account, payeeName: p.name, payeeInn: p.inn, payeeKpp: p.kpp, payeeBank: p.bank, payeeBic: p.bic, payeeCorr: p.corr,
            purpose: p.purpose,
        }));
    });
    lines.push('КонецФайла');
    return encodeCp1251(lines.join('\r\n') + '\r\n');
}

function pain001(payments, org, msgId) {
    if (!org.account) throw new BankError('Укажите расчётный счёт организации в настройках шлюза');
    const now = new Date();
    const ccy = org.currency || 'RUB';
    const total = payments.reduce((s, p) => s + Number(p.amount), 0);
    const txs = payments.map((p) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${xml(p.id)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${xml(ccy)}">${money(p.amount)}</InstdAmt></Amt>
        <CdtrAgt><FinInstnId>${p.bic ? `<ClrSysMmbId><ClrSysId><Cd>RUCBC</Cd></ClrSysId><MmbId>${xml(p.bic)}</MmbId></ClrSysMmbId>` : ''}${p.bank ? `<Nm>${xml(p.bank)}</Nm>` : ''}</FinInstnId></CdtrAgt>
        <Cdtr><Nm>${xml(p.name)}</Nm>${p.inn ? `<Id><OrgId><Othr><Id>${xml(p.inn)}</Id><SchmeNm><Prtry>INN</Prtry></SchmeNm></Othr></OrgId></Id>` : ''}</Cdtr>
        <CdtrAcct><Id><Othr><Id>${xml(p.account)}</Id></Othr></Id></CdtrAcct>
        <RmtInf><Ustrd>${xml(line(p.purpose, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`);
    return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xml(msgId)}</MsgId>
      <CreDtTm>${now.toISOString().slice(0, 19)}</CreDtTm>
      <NbOfTxs>${payments.length}</NbOfTxs>
      <CtrlSum>${money(total)}</CtrlSum>
      <InitgPty><Nm>${xml(org.name || 'Организация')}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xml(msgId)}-1</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${payments.length}</NbOfTxs>
      <CtrlSum>${money(total)}</CtrlSum>
      <ReqdExctnDt>${dateIso(now)}</ReqdExctnDt>
      <Dbtr><Nm>${xml(org.name || 'Организация')}</Nm>${org.inn ? `<Id><OrgId><Othr><Id>${xml(org.inn)}</Id><SchmeNm><Prtry>INN</Prtry></SchmeNm></Othr></OrgId></Id>` : ''}</Dbtr>
      <DbtrAcct><Id><Othr><Id>${xml(org.account)}</Id></Othr></Id><Ccy>${xml(ccy)}</Ccy></DbtrAcct>
      <DbtrAgt><FinInstnId>${org.bic ? `<ClrSysMmbId><ClrSysId><Cd>RUCBC</Cd></ClrSysId><MmbId>${xml(org.bic)}</MmbId></ClrSysMmbId>` : ''}${org.bank ? `<Nm>${xml(org.bank)}</Nm>` : ''}</FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${txs.join('\n')}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`, 'utf8');
}

// ---------- разбор входящих выписок банка ----------

/**
 * Возвращает поступления: [{ bankRef, date, amount, currency, payer, payerAccount, purpose }]
 * ownAccount — расчётный счёт организации (для 1С: берём документы, где он получатель).
 */
function parseBankStatement(buffer, ownAccount) {
    const textData = decodeText(buffer);
    if (/^\s*1CClientBankExchange/.test(textData)) return parse1C(textData, ownAccount);
    if (/<Document[\s>]/.test(textData) && /camt\.05[234]/.test(textData)) return parseCamt(textData);
    throw new BankError('Неизвестный формат выписки: нужен 1CClientBankExchange или ISO 20022 camt.053/camt.054');
}

function parse1C(textData, ownAccount) {
    const out = [];
    const blocks = textData.split(/\r?\nСекцияДокумент=/).slice(1);
    for (const block of blocks) {
        const body = block.split(/\r?\nКонецДокумента/)[0];
        const f = {};
        for (const row of body.split(/\r?\n/)) {
            const eq = row.indexOf('=');
            if (eq > 0) f[row.slice(0, eq).trim()] = row.slice(eq + 1).trim();
        }
        const payee = f['ПолучательСчет'] || f['ПолучательРасчСчет'];
        if (ownAccount && payee !== ownAccount) continue; // это списание, а не поступление
        if (!ownAccount && !f['ДатаПоступило']) continue;
        const [d, m, y] = (f['ДатаПоступило'] || f['Дата'] || '').split('.');
        out.push({
            bankRef: `${f['Номер'] || ''}/${f['Дата'] || ''}/${f['ПлательщикИНН'] || f['ПлательщикСчет'] || ''}`,
            date: y ? Date.UTC(+y, +m - 1, +d) : Date.now(),
            amount: money(f['Сумма']),
            currency: 'RUB',
            payer: f['Плательщик1'] || f['Плательщик'] || '',
            payerAccount: f['ПлательщикСчет'] || f['ПлательщикРасчСчет'] || '',
            purpose: f['НазначениеПлатежа'] || '',
        });
    }
    return out;
}

function tag(src, name) {
    const m = src.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
    return m ? m[1] : '';
}

function parseCamt(textData) {
    const out = [];
    const entries = textData.match(/<(?:\w+:)?Ntry>[\s\S]*?<\/(?:\w+:)?Ntry>/g) || [];
    for (const e of entries) {
        if (tag(e, 'CdtDbtInd').trim() !== 'CRDT') continue;
        const amt = e.match(/<(?:\w+:)?Amt\s+Ccy="([A-Z]{3})"\s*>([\d.]+)</);
        const dt = tag(tag(e, 'BookgDt'), 'Dt') || tag(tag(e, 'BookgDt'), 'DtTm') || tag(tag(e, 'ValDt'), 'Dt');
        const ustrd = (e.match(/<(?:\w+:)?Ustrd>([\s\S]*?)<\/(?:\w+:)?Ustrd>/g) || []).map((u) => unxml(u.replace(/<[^>]+>/g, ''))).join(' ');
        const dbtr = tag(e, 'Dbtr');
        out.push({
            bankRef: unxml(tag(e, 'AcctSvcrRef') || tag(e, 'EndToEndId') || tag(e, 'NtryRef')).trim(),
            date: dt ? Date.parse(dt) : Date.now(),
            amount: money(amt ? amt[2] : 0),
            currency: amt ? amt[1] : 'RUB',
            payer: unxml(tag(dbtr, 'Nm')).trim(),
            payerAccount: unxml(tag(tag(e, 'DbtrAcct'), 'Id').replace(/<[^>]+>/g, '')).trim(),
            purpose: ustrd.trim(),
        });
    }
    return out;
}

module.exports = {
    statementCsv, statement1C, camt053, paymentOrders1C, pain001,
    parseBankStatement, encodeCp1251, decodeText, dateRu,
};
