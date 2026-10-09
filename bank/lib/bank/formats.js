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
 * ops: [{ timestamp, seqNo, signature, type, direction:'in'|'out', from, to, amount, assetName, title, message }]
 * meta: { address, assetName, from, to, organization }
 */
function statementCsv(ops, meta) {
    const head = ['Дата', 'Время', 'Номер', 'Операция', 'Контрагент', 'Приход', 'Расход', 'Актив', 'Назначение', 'Подпись'];
    const cell = (v) => {
        const s = String(v ?? '');
        return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = ops.map((o) => [
        o.timestamp ? dateRu(o.timestamp) : '', o.timestamp ? timeRu(o.timestamp) : '', o.seqNo || '',
        o.type || '', o.direction === 'in' ? o.from : o.to,
        o.direction === 'in' ? o.amount || '' : '', o.direction === 'out' ? o.amount || '' : '',
        o.assetName || '', line([o.title, o.message].filter(Boolean).join(' — '), 1000), o.signature || '',
    ]);
    const title = `Выписка по счёту ${meta.address}${meta.assetName ? ' (' + meta.assetName + ')' : ''}`;
    const text = [title, head.join(';'), ...rows.map((r) => r.map(cell).join(';'))].join('\r\n') + '\r\n';
    return Buffer.from('﻿' + text, 'utf8');
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
        'Плательщик1=' + line(d.payerName, 160),
        'ПлательщикРасчСчет=' + line(d.payerAccount, 34),
        'ПлательщикБанк1=' + line(d.payerBank, 160),
        'ПлательщикБИК=' + line(d.payerBic, 9),
        'ПлательщикКорсчет=' + line(d.payerCorr, 20),
        'ПолучательСчет=' + line(d.payeeAccount, 34),
        'Получатель=' + line(d.payeeName, 160),
        'ПолучательИНН=' + line(d.payeeInn, 12),
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

/**
 * Выписка по счёту блокчейна в формате 1С. Счёт блокчейна отображается как «расчётный счёт»
 * организации: номер берётся из настроек (account1C) или используется адрес Erachain.
 */
function statement1C(ops, meta) {
    const org = meta.organization || {};
    const account = org.account1C || meta.address;
    let inSum = 0;
    let outSum = 0;
    for (const o of ops) {
        if (o.direction === 'in') inSum += Number(o.amount || 0);
        else outSum += Number(o.amount || 0);
    }
    const lines = oneCHeader({ ...meta, account }, 'statement');
    lines.push(
        'СекцияРасчСчет',
        'ДатаНачала=' + dateRu(meta.from),
        'ДатаКонца=' + dateRu(meta.to),
        'РасчСчет=' + account,
        'ВсегоПоступило=' + money(inSum),
        'ВсегоСписано=' + money(outSum),
        'КонецРасчСчет',
    );
    for (const o of ops.filter((x) => x.amount)) {
        const incoming = o.direction === 'in';
        const self = { name: org.name || 'Организация', inn: org.inn, account, bank: 'Erachain', bic: '', corr: '' };
        const other = { name: incoming ? o.from : o.to, inn: '', account: incoming ? o.from : o.to, bank: 'Erachain', bic: '', corr: '' };
        const payer = incoming ? other : self;
        const payee = incoming ? self : other;
        lines.push(...oneCDocument({
            number: o.seqNo || '', date: o.timestamp || Date.now(), amount: o.amount,
            payerAccount: payer.account, payerName: payer.name, payerInn: payer.inn, payerBank: payer.bank, payerBic: payer.bic, payerCorr: payer.corr,
            payeeAccount: payee.account, payeeName: payee.name, payeeInn: payee.inn, payeeBank: payee.bank, payeeBic: payee.bic, payeeCorr: payee.corr,
            purpose: [o.title, o.message, o.assetName ? `(${o.assetName})` : ''].filter(Boolean).join(' ') || 'Перевод в Erachain',
            debited: !incoming, credited: incoming,
        }));
    }
    lines.push('КонецФайла');
    return encodeCp1251(lines.join('\r\n') + '\r\n');
}

function camt053(ops, meta) {
    const now = new Date();
    const id = 'ERA' + now.getTime();
    const ccy = meta.currency || 'XXX';
    let inSum = 0;
    let outSum = 0;
    const entries = ops.filter((o) => o.amount).map((o, i) => {
        const incoming = o.direction === 'in';
        if (incoming) inSum += Number(o.amount);
        else outSum += Number(o.amount);
        const party = incoming ? `<RltdPties><Dbtr><Nm>${xml(o.from)}</Nm></Dbtr></RltdPties>` : `<RltdPties><Cdtr><Nm>${xml(o.to)}</Nm></Cdtr></RltdPties>`;
        const info = [o.title, o.message].filter(Boolean).join(' — ');
        return `      <Ntry>
        <NtryRef>${i + 1}</NtryRef>
        <Amt Ccy="${xml(ccy)}">${money(o.amount, meta.scale ?? 2)}</Amt>
        <CdtDbtInd>${incoming ? 'CRDT' : 'DBIT'}</CdtDbtInd>
        <Sts>${o.confirmations ? 'BOOK' : 'PDNG'}</Sts>
        <BookgDt><DtTm>${new Date(o.timestamp || Date.now()).toISOString()}</DtTm></BookgDt>
        <AcctSvcrRef>${xml(o.seqNo || o.signature || '')}</AcctSvcrRef>
        <BkTxCd><Prtry><Cd>${xml(o.type || 'TRANSFER')}</Cd><Issr>Erachain</Issr></Prtry></BkTxCd>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>${xml(o.signature || 'NOTPROVIDED')}</EndToEndId></Refs>
          ${party}
          <RmtInf><Ustrd>${xml(line(info, 140))}</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>`;
    });
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
      <Acct><Id><Othr><Id>${xml(meta.address)}</Id><SchmeNm><Prtry>ERACHAIN</Prtry></SchmeNm></Othr></Id><Ccy>${xml(ccy)}</Ccy></Acct>
      <TxsSummry>
        <TtlCdtNtries><NbOfNtries>${ops.filter((o) => o.amount && o.direction === 'in').length}</NbOfNtries><Sum>${money(inSum, meta.scale ?? 2)}</Sum></TtlCdtNtries>
        <TtlDbtNtries><NbOfNtries>${ops.filter((o) => o.amount && o.direction !== 'in').length}</NbOfNtries><Sum>${money(outSum, meta.scale ?? 2)}</Sum></TtlDbtNtries>
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
            payerAccount: org.account, payerName: org.name, payerInn: org.inn, payerBank: org.bank, payerBic: org.bic, payerCorr: org.corr,
            payeeAccount: p.account, payeeName: p.name, payeeInn: p.inn, payeeBank: p.bank, payeeBic: p.bic, payeeCorr: p.corr,
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
