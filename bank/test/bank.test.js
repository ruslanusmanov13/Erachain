'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { createServer, demoGatewaySettings } = require('../server');
const { DemoBackend, toUnits, fromUnits } = require('../lib/demoBackend');
const { NodeBackend } = require('../lib/nodeBackend');
const { JsonStore } = require('../lib/store');
const { Gateway } = require('../lib/bank/gateway');
const formats = require('../lib/bank/formats');
const v = require('../lib/validate');
const { SevenPayClient, SevenPayDemo } = require('../lib/sevenpay');

const A = '7' + 'A'.repeat(33);
const B = '7' + 'B'.repeat(33);
const PHOTO = Buffer.alloc(12 * 1024, 7).toString('base64');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function startDemo(t, options = {}) {
    const backend = new DemoBackend();
    const server = createServer(backend, { store: new JsonStore(null, { settings: demoGatewaySettings(backend) }), sevenpay: new SevenPayDemo(), ...options });
    const base = await listen(server);
    t.after(() => server.close());
    const api = async (method, path, body, token) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
    };
    const { data: { token } } = await api('POST', '/api/login', { password: 'demo12345' });
    const call = (method, path, body) => api(method, path, body, token);
    const { data: accounts } = await call('GET', '/api/accounts');
    return { base, backend, api, call, token, accounts };
}

const bal = (acc, k) => (acc.balances.find((x) => x.asset === k) || { amount: '0' }).amount;

test('суммы без потери точности', () => {
    assert.strictEqual(toUnits('1.5'), 150000000n);
    assert.strictEqual(fromUnits(toUnits('0.00000001')), '0.00000001');
    assert.strictEqual(fromUnits(toUnits('1250.5') - toUnits('0.1')), '1250.40000000');
});

test('валидация', () => {
    assert.strictEqual(v.validateTransfer({ from: A, to: B, asset: 1, amount: '1,5' }).amount, '1.5');
    assert.throws(() => v.validateTransfer({ from: A, to: A, asset: 1, amount: '1' }), /тот же/);
    assert.throws(() => v.validateTransfer({ from: A, to: B, asset: 1, amount: '0' }), /сумма/);
    assert.throws(() => v.validateTransfer({ from: A, to: B, asset: 1, amount: '1.123456789' }), /сумма/);
    assert.throws(() => v.validatePoll({ creator: A, name: 'Коротко', options: ['a', 'b'] }), /12 символов/);
    assert.throws(() => v.validatePoll({ creator: A, name: 'Достаточно длинное', options: ['a'] }), /два варианта/);
    assert.throws(() => v.validateAssetIssue({ creator: A, name: 'X', scale: 20 }), /Точность/);
    assert.throws(() => v.validateCancel({ creator: A, order: 'abc-0' }), /номер ордера/);
    assert.strictEqual(v.validateCancel({ creator: A, order: '123-4' }).order, '123-4');
    assert.throws(() => v.validatePersonIssue({ creator: A, name: 'Иван Иванов', birthday: '1990-01-01', gender: 0, height: 180, image64: 'AAAA' }), /фотография/);
    assert.throws(() => v.validateMultiTransfer({ from: A, asset: 1, payments: [{ to: 'bad', amount: '1' }] }), /Строка 1/);
});

test('демо: вход, счета, переводы, массовые выплаты, история', async (t) => {
    const { api, call, accounts } = await startDemo(t);
    assert.strictEqual((await api('GET', '/api/accounts')).status, 401);
    assert.strictEqual((await api('POST', '/api/login', { password: 'wrong' })).status, 401);
    const [a, b] = accounts;

    const tr = await call('POST', '/api/transfer', { from: a.address, to: b.address, asset: 1, amount: '100.25', title: 'Тест' });
    assert.strictEqual(tr.status, 200, JSON.stringify(tr.data));
    const batch = await call('POST', '/api/transfer/batch', { from: a.address, asset: 1, title: 'Зарплата', payments: [{ to: b.address, amount: '10' }, { to: B, amount: '99999' }] });
    assert.strictEqual(batch.data.sent, 1);
    assert.match(batch.data.results[1].error, /Недостаточно/);

    const { data: after } = await call('GET', '/api/accounts');
    assert.strictEqual(bal(after[0], 1), '1140.25000000');
    assert.strictEqual(bal(after[1], 1), '410.25000000');

    const { data: hist } = await call('GET', `/api/accounts/${b.address}/history`);
    assert.strictEqual(hist[0].direction, 'in');
    assert.strictEqual(hist[1].title, 'Тест');

    const { data: opened } = await call('POST', '/api/accounts');
    assert.match(opened.address, /^7/);
});

test('демо: выпуск актива, голосование, документы, сообщения, персоны', async (t) => {
    const { call, accounts } = await startDemo(t);
    const me = accounts[0].address;

    const issued = await call('POST', '/api/assets', { creator: me, name: 'Акции ООО Ромашка', description: 'Доли', scale: 0, assetType: 11, quantity: 1000 });
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.data));
    const { data: asset } = await call('GET', '/api/assets/' + issued.data.key);
    assert.strictEqual(asset.name, 'Акции ООО Ромашка');
    const { data: list } = await call('GET', '/api/assets');
    assert.strictEqual(list.items[0].key, issued.data.key);
    const { data: acc } = await call('GET', '/api/accounts');
    assert.strictEqual(bal(acc[0], issued.data.key), '1000.00000000');

    const poll = await call('POST', '/api/polls', { creator: me, name: 'Выбор поставщика на 2027 год', options: ['Альфа', 'Бета'] });
    assert.strictEqual(poll.status, 200, JSON.stringify(poll.data));
    assert.strictEqual((await call('POST', `/api/polls/${poll.data.key}/vote`, { voter: me, option: 1 })).status, 200);
    const { data: p } = await call('GET', `/api/polls/${poll.data.key}`);
    assert.strictEqual(p.options[1].votes, bal(acc[0], 1));
    assert.strictEqual(p.options[1].persons, 1); // счёт удостоверен персоной №1

    const hash = '9xWGyESrjwLMS1ixKfPqx4L6ucTgvmz8QfjnuuSh6Svn';
    assert.strictEqual((await call('POST', '/api/documents', { creator: me, title: 'Договор поставки', hashes: { [hash]: 'dogovor.pdf' } })).status, 200);
    const { data: found } = await call('GET', '/api/documents/verify/' + hash);
    assert.strictEqual(found[0].title, 'Договор поставки');

    assert.strictEqual((await call('POST', '/api/messages', { from: me, to: B, title: 'Счёт', message: 'Оплатите счёт 15' })).status, 200);
    const { data: msgs } = await call('GET', '/api/messages/' + me);
    assert.deepStrictEqual(msgs.map((m) => m.direction).sort(), ['in', 'out']);

    const person = await call('POST', '/api/persons', { creator: me, name: 'Сидорова Анна', birthday: '1992-03-04', gender: 1, height: 165, image64: PHOTO });
    assert.strictEqual(person.status, 200, JSON.stringify(person.data));
    assert.strictEqual((await call('POST', '/api/persons/certify', { creator: me, person: person.data.key, pubkey: 'JvHFoAjUzjh2LXNxYkvBKRt1jc7Fqh6S1pzJGYTFqur', days: 365 })).status, 200);
    const { data: templates } = await call('GET', '/api/catalog/templates');
    assert.ok(templates.items.length > 0);
});

test('демо: биржа — ордер исполняется встречным, отмена возвращает остаток', async (t) => {
    const { call, accounts } = await startDemo(t);
    const me = accounts[0].address;
    const { data: book } = await call('GET', '/api/exchange/1/2');
    assert.strictEqual(book.sell.length, 1); // демо-ордер: продажа 100 ERA за 5 COMPU

    // покупаем ERA за COMPU по цене лучше встречной: отдаём 2 COMPU, хотим 30 ERA (встречный даёт 20 ERA за 1 COMPU)
    const o = await call('POST', '/api/exchange/orders', { creator: me, have: 2, want: 1, haveAmount: '2', wantAmount: '30' });
    assert.strictEqual(o.status, 200, JSON.stringify(o.data));
    const { data: mine } = await call('GET', '/api/exchange/orders/' + me);
    assert.strictEqual(mine[0].status, 'частично исполнен');
    const { data: acc } = await call('GET', '/api/accounts');
    assert.strictEqual(bal(acc[0], 1), '1280.50000000'); // +30 ERA

    const cancel = await call('POST', '/api/exchange/cancel', { creator: me, order: mine[0].seqNo });
    assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.data));
    const { data: after } = await call('GET', '/api/exchange/orders/' + me);
    assert.strictEqual(after[0].status, 'отменён');
});

test('выписки: CSV, 1С (Windows-1251), camt.053', async (t) => {
    const { call, accounts } = await startDemo(t);
    const me = accounts[0].address;
    await call('POST', '/api/transfer', { from: me, to: B, asset: 1, amount: '5', title: 'Оплата №7' });

    const csv = await call('GET', `/api/bank/statement?address=${me}&format=csv`);
    assert.match(csv.headers.get('content-disposition'), /\.csv"/);
    assert.match(csv.data.toString('utf8'), /Оплата №7/);

    const oneC = await call('GET', `/api/bank/statement?address=${me}&format=1c&asset=1`);
    const text1c = new TextDecoder('windows-1251').decode(oneC.data);
    assert.match(text1c, /^1CClientBankExchange\r\nВерсияФормата=1\.03/);
    assert.match(text1c, /НазначениеПлатежа=Оплата №7/);
    assert.match(text1c, /ВсегоСписано=5\.00/);
    assert.ok(!oneC.data.toString('utf8').includes('Оплата')); // не UTF-8

    const camt = await call('GET', `/api/bank/statement?address=${me}&format=camt053&asset=1`);
    const xml = camt.data.toString('utf8');
    assert.match(xml, /camt\.053\.001\.02/);
    assert.match(xml, /<CdtDbtInd>DBIT<\/CdtDbtInd>/);
});

test('шлюз: поступление из выписки 1С → зачисление токенов', async (t) => {
    const { call, accounts } = await startDemo(t);
    const client = accounts[1].address;
    const { data: settings } = await call('GET', '/api/bank/settings');
    const statement = formats.encodeCp1251([
        '1CClientBankExchange', 'ВерсияФормата=1.03', 'Кодировка=Windows',
        'СекцияДокумент=Платежное поручение', 'Номер=15', 'Дата=01.10.2026', 'Сумма=1500.00',
        'ПлательщикСчет=40817810000000000001', 'Плательщик1=Петров П.П.', 'ПлательщикИНН=500100732259',
        `ПолучательСчет=${settings.organization.account}`, 'ДатаПоступило=01.10.2026',
        `НазначениеПлатежа=Пополнение кошелька ${client}`, 'КонецДокумента',
        'СекцияДокумент=Платежное поручение', 'Номер=16', 'Дата=01.10.2026', 'Сумма=200.00',
        `ПолучательСчет=${settings.organization.account}`, 'Плательщик1=Без адреса', 'НазначениеПлатежа=Оплата по счёту', 'КонецДокумента',
        'КонецФайла',
    ].join('\r\n'));
    const imp = await call('POST', '/api/bank/import', { content: statement.toString('base64') });
    assert.deepStrictEqual([imp.data.found, imp.data.added], [2, 2]);
    assert.strictEqual((await call('POST', '/api/bank/import', { content: statement.toString('base64') })).data.added, 0); // повторно не дублируется

    const { data: deps } = await call('GET', '/api/bank/deposits');
    const good = deps.find((d) => d.amount === '1500.00');
    const review = deps.find((d) => d.amount === '200.00');
    assert.strictEqual(good.address, client);
    assert.strictEqual(review.status, 'review');

    const credited = await call('POST', `/api/bank/deposits/${good.id}/credit`);
    assert.strictEqual(credited.data.status, 'credited', JSON.stringify(credited.data));
    assert.strictEqual((await call('POST', `/api/bank/deposits/${good.id}/credit`)).status, 400); // второй раз нельзя
    const { data: acc } = await call('GET', '/api/accounts');
    assert.strictEqual(bal(acc.find((x) => x.address === client), 1048), '1500.00000000');
});

test('шлюз: вывод — сканирование, выгрузка pain.001 и 1С, оплата, возврат', async (t) => {
    const { call } = await startDemo(t);
    const scan = await call('POST', '/api/bank/withdrawals/scan');
    assert.strictEqual(scan.data.added, 1, JSON.stringify(scan.data));
    let { data: ws } = await call('GET', '/api/bank/withdrawals');
    assert.strictEqual(ws[0].status, 'new');
    assert.strictEqual(ws[0].requisites.account, '40817810099910004312');

    const pain = await call('POST', '/api/bank/withdrawals/export', { format: 'pain001' });
    const xml = pain.data.toString('utf8');
    assert.match(xml, /pain\.001\.001\.03/);
    assert.match(xml, /<InstdAmt Ccy="RUB">2500\.00<\/InstdAmt>/);
    assert.match(xml, /<MmbId>044525225<\/MmbId>/);
    assert.strictEqual((await call('POST', '/api/bank/withdrawals/export', { format: '1c' })).status, 400); // уже выгружено

    ({ data: ws } = await call('GET', '/api/bank/withdrawals'));
    assert.strictEqual(ws[0].status, 'exported');
    assert.strictEqual((await call('POST', `/api/bank/withdrawals/${ws[0].id}/paid`)).data.status, 'paid');
    assert.strictEqual((await call('POST', `/api/bank/withdrawals/${ws[0].id}/refund`)).status, 400);
});

test('шлюз: разбор реквизитов и camt.053 банка', () => {
    assert.strictEqual(Gateway.parseRequisites('ВЫВОД;ООО Ромашка;7701234567;40702810900000012345;044525225').ok, true);
    assert.match(Gateway.parseRequisites('ВЫВОД;ООО Ромашка;7701234567;123;044525225').error, /20 цифр/);
    assert.strictEqual(Gateway.parseRequisites('{"name":"Иванов","account":"40817810099910004312","bic":"044525225"}').ok, true);
    assert.strictEqual(Gateway.parseRequisites('просто перевод').ok, false);

    const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
      <Ntry><Amt Ccy="RUB">700.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-10-02</Dt></BookgDt><AcctSvcrRef>REF-1</AcctSvcrRef>
        <NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Иванов &amp; Ко</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Пополнение ${A}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
      <Ntry><Amt Ccy="RUB">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd></Ntry>
    </Stmt></BkToCstmrStmt></Document>`;
    const list = formats.parseBankStatement(Buffer.from(camt));
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual([list[0].amount, list[0].payer, list[0].bankRef], ['700.50', 'Иванов & Ко', 'REF-1']);
    assert.throws(() => formats.parseBankStatement(Buffer.from('hello')), /Неизвестный формат/);
});

test('вебхук банка: подпись HMAC обязательна', async (t) => {
    const { base, call } = await startDemo(t, { webhookSecret: 's3cret' });
    const body = JSON.stringify({ id: 'tx-77', date: '2026-10-03', amount: 99.9, payer: 'Сидоров', purpose: 'Пополнение ' + A });
    const send = (sig) => fetch(base + '/api/bank/webhook', { method: 'POST', headers: { 'X-Signature': sig }, body });
    assert.strictEqual((await send('sha256=bad')).status, 401);
    const ok = await send('sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex'));
    assert.deepStrictEqual(await ok.json(), { received: 1, added: 1 });
    const { data: deps } = await call('GET', '/api/bank/deposits');
    assert.strictEqual(deps[0].address, A);
});

test('защита: подбор пароля, статика, CORS', async (t) => {
    const { base, api } = await startDemo(t, { corsOrigins: ['https://localhost'] });
    for (let i = 0; i < 5; i++) await api('POST', '/api/login', { password: 'wrong' });
    assert.strictEqual((await api('POST', '/api/login', { password: 'demo12345' })).status, 429);

    const res = await fetch(base + '/');
    assert.match(await res.text(), /Банк Erachain/);
    assert.notStrictEqual((await fetch(base + '/..%2Fserver.js')).status, 200);

    const pre = await fetch(base + '/api/accounts', { method: 'OPTIONS', headers: { Origin: 'https://localhost' } });
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'https://localhost');
    const other = await fetch(base + '/api/status', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(other.headers.get('access-control-allow-origin'), null);
});

test('NodeBackend: вызовы RPC ноды и разбор ответов', async (t) => {
    const seen = [];
    const node = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        let body = '';
        for await (const c of req) body += c;
        seen.push({ path: url.pathname, query: url.search, body });
        const reply = (b) => res.end(typeof b === 'string' ? b : JSON.stringify(b));
        switch (url.pathname) {
            case '/blocks/height': return reply('12345');
            case '/core/version': return reply({ version: '6.1.01' });
            case '/addresses': return url.searchParams.get('password') === 'secret123' ? reply([A]) : reply({ error: 10803, message: 'E-wallet is locked' });
            case `/addresses/assets/${A}`: return reply({ 1: [['10', '7.5'], ['0', '1'], ['0', '0'], ['0', '0'], ['0', '0']] });
            case '/assets/1': return reply({ name: 'ERA', scale: 8 });
            case '/transactions/find': return reply([{ signature: 's1', creator: B, recipient: A, assetKey: 1, amount: '3', confirmations: 2, timestamp: 1 }]);
            case `/transactions/unconfirmedof/${A}`: return reply([{ signature: 's2', creator: A, recipient: B, assetKey: 1, amount: '1', confirmations: 0, timestamp: 2 }]);
            case '/assets/issue': return reply({ signature: 'iss', seqNo: '5-1', type_name: 'Issue Asset' });
            case '/polls/7': return reply({ key: 7, name: 'Голосование', options: ['Да', 'Нет'], results: [{ persons: 2, votes: '10' }, { persons: 0, votes: '0' }], votesTotal: '10' });
            case '/trade/ordersbook/1/2': return reply({ have: [{ seqNo: '9-1', pairAmount: '100', pairPrice: '0.05', pairTotal: '5' }], want: [] });
            case '/trade/trades/1/2': return reply([]);
            case `/trade/allordersbyaddress/${A}`: return reply([{ seqNo: '9-2', haveAssetKey: 1, wantAssetKey: 2, amountHave: '1', leftHave: '1', statusName: 'Open # Открыт' }]);
            case '/r_note/make': return reply({ signature: 'doc', seqNo: '6-1', type_name: 'Note' });
            default:
                if (url.pathname.startsWith(`/r_send/${A}/${B}`)) return reply({ signature: 'sig', type_name: 'SEND', creator: A, recipient: B, assetKey: 1, amount: '1.5', confirmations: 0 });
                if (url.pathname.startsWith(`/trade/cancel/${A}/9-2`)) return reply({ signature: 'cnl', type_name: 'Cancel Order' });
                res.statusCode = 404;
                return reply({ error: 'not found' });
        }
    });
    const rpc = await listen(node);
    t.after(() => node.close());
    const b = new NodeBackend(rpc);

    assert.deepStrictEqual(await b.status(), { mode: 'node', node: rpc, height: 12345, version: '6.1.01' });
    await assert.rejects(b.login('bad-password'), /wallet is locked/);
    assert.deepStrictEqual(await b.accounts('secret123'), [{ address: A, balances: [{ asset: 1, name: 'ERA', amount: '7.5', debt: '1', hold: '0', spend: '0' }] }]);

    const hist = await b.history(A, 10);
    assert.deepStrictEqual(hist.map((h) => [h.signature, h.direction]), [['s2', 'out'], ['s1', 'in']]);

    await b.transfer({ from: A, to: B, asset: 1, amount: '1.5', title: 'x', message: '' }, 'secret123');
    assert.match(seen.find((s) => s.path.startsWith('/r_send')).query, /assetKey=1&amount=1.5.*password=secret123/);

    await b.issueAsset({ creator: A, name: 'Токен', description: '', scale: 2, assetType: 1, quantity: 100 }, 'secret123');
    const issueBody = JSON.parse(seen.find((s) => s.path === '/assets/issue').body);
    assert.deepStrictEqual([issueBody.scale, issueBody.quantity, issueBody.password], [2, 100, 'secret123']);

    const poll = await b.poll(7);
    assert.deepStrictEqual(poll.options[0], { option: 0, name: 'Да', persons: 2, votes: '10' });

    const book = await b.orderBook(1, 2);
    assert.deepStrictEqual(book.sell[0], { seqNo: '9-1', amount: '100', price: '0.05', total: '5', creator: null });
    const orders = await b.myOrders(A);
    assert.deepStrictEqual([orders[0].status, orders[0].active], ['открыт', true]);
    await b.cancelOrder({ creator: A, order: '9-2' }, 'secret123');

    await b.signDocument({ creator: A, title: 'Договор', message: '', hashes: { abc: 'f.pdf' }, recipients: [B] }, 'secret123');
    const noteBody = JSON.parse(seen.find((s) => s.path === '/r_note/make').body);
    assert.deepStrictEqual([noteBody.test, noteBody.recipients, noteBody.hashes], [false, { list: [B] }, { abc: 'f.pdf' }]);
});

test('7Pay (демо): курс, заявка BTC → ERA, оплата ERA с кошелька → BTC', async (t) => {
    const { call, accounts, backend } = await startDemo(t);
    const me = accounts[0].address;
    const { data: currs } = await call('GET', '/api/swap/currencies');
    assert.ok(currs.in.find((c) => c.abbrev === 'BTC' && !c.erachain));
    assert.deepStrictEqual(currs.out.find((c) => c.abbrev === 'ERA').asset, 1);

    const q = await call('POST', '/api/swap/quote', { from: 'BTC', to: 'ERA', amount: '0,01', side: 'in' });
    assert.strictEqual(q.status, 200, JSON.stringify(q.data));
    assert.ok(q.data.volumeOut > 1000 && q.data.receiveToWallet && !q.data.payFromWallet);
    const qOut = await call('POST', '/api/swap/quote', { from: 'BTC', to: 'ERA', amount: '500', side: 'out' });
    assert.strictEqual(qOut.data.volumeOut, 500);

    assert.match((await call('POST', '/api/swap/orders', { from: 'BTC', to: 'ERA', amount: '0.01', address: 'bc1qxyz' })).data.error, /адрес ERA/);
    const btcOrder = await call('POST', '/api/swap/orders', { from: 'BTC', to: 'ERA', amount: '0.01', address: me });
    assert.strictEqual(btcOrder.status, 200, JSON.stringify(btcOrder.data));
    assert.ok(btcOrder.data.addr_in && btcOrder.data.uri.startsWith('bitcoin:'));
    assert.strictEqual(btcOrder.data.payAsset, null);
    assert.strictEqual((await call('POST', `/api/swap/orders/${btcOrder.data.id}/pay`, { from: me })).status, 400); // BTC платится снаружи

    // ERA → BTC: оплата прямо со счёта кошелька, адрес получения — в заголовке перевода
    const btcAddr = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
    const eraOrder = await call('POST', '/api/swap/orders', { from: 'ERA', to: 'BTC', amount: '100', address: btcAddr });
    assert.strictEqual(eraOrder.data.addr_out_full, 'BTC:' + btcAddr);
    const paid = await call('POST', `/api/swap/orders/${eraOrder.data.id}/pay`, { from: me });
    assert.strictEqual(paid.data.status, 'paid', JSON.stringify(paid.data));
    const tx = backend.txs.find((x) => x.signature === paid.data.paySignature);
    assert.deepStrictEqual([tx.to, tx.asset, tx.title, tx.amount], [eraOrder.data.addr_in, 1, 'BTC:' + btcAddr, '100']);
    assert.strictEqual((await call('POST', `/api/swap/orders/${eraOrder.data.id}/pay`, { from: me })).status, 400); // второй раз нельзя

    const hist = await call('GET', `/api/swap/orders/${eraOrder.data.id}/history`);
    assert.deepStrictEqual(hist.data.payments.map((p) => [p.stage, p.currIn, p.amountIn]), [['paid_out', 'ERA', 100]]);
    const tracked = await call('GET', `/api/swap/track?curr=BTC&address=${btcAddr}`);
    assert.strictEqual(tracked.data.payments[0].amountOut, eraOrder.data.volume_out);

    // лимиты: обменник не выдаст больше, чем у него есть
    const big = await call('POST', '/api/swap/quote', { from: 'ERA', to: 'BTC', amount: '100000000' });
    assert.match(big.data.problems.join(), /только/);
    assert.match((await call('POST', '/api/swap/orders', { from: 'ERA', to: 'BTC', amount: '100000000', address: btcAddr })).data.error, /только/);

    const rates = await call('GET', '/api/swap/rates');
    assert.ok(rates.data.RUB.find((r) => r.abbrev === 'ERA').rate > 0);
    const { data: orders } = await call('GET', '/api/swap/orders');
    assert.deepStrictEqual(orders.map((o) => o.status), ['done', 'awaiting_payment']);
});

test('7Pay: клиент вызывает apipay и разбирает ошибки', async (t) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
        seen.push(req.url);
        const reply = (b) => res.end(JSON.stringify(b));
        if (req.url.startsWith('/apipay/get_currs.json')) return reply({ in: { BTC: { id: 3, name: 'Bitcoin', min: 0.0001 }, ERA: { id: 9, name: 'ERA', system: 'erachain', token_key: 1 } }, out: { ERA: { id: 9, name: 'ERA', system: 'erachain', token_key: 1, bal: 1000 }, BTC: { id: 3, name: 'Bitcoin', bal: 0.5 } } });
        if (req.url.startsWith('/apipay/get_rate.json/BTC/ERA/0.01')) return reply({ volume_in: 0.01, volume_out: 1900, rate: 190000, bal: 1000 });
        if (req.url.startsWith('/apipay/get_rate.json/ERA/BTC/100')) return reply({ volume_in: 100, volume_out: 0.0005, rate: 0.000005, bal: 0.5 });
        if (req.url.startsWith('/apipay/get_uri_in.json/2/ERA/BTC/')) return reply({ volume_in: 100, volume_out: 0.0005, rate: 0.000005, addr_in: B, uri: 'erachain:' + B, addr_out_full: 'BTC:1BoatSLRHtKNngkdXEeobR76b53LETtpyT' });
        if (req.url.startsWith('/apipay/history.json/BTC/')) return reply({ error: 'Deal ACCOUNT not found. Use ABBREV/ACCOUNT' });
        res.statusCode = 404;
        return reply({ error: 'not found' });
    });
    const base = await listen(srv);
    t.after(() => srv.close());
    const backend = new DemoBackend();
    const { SwapService } = require('../lib/sevenpay');
    const swap = new SwapService(new SevenPayClient(base), backend, new JsonStore(null, {}));

    const currs = await swap.currencies();
    assert.deepStrictEqual(currs.in.map((c) => [c.abbrev, c.erachain]), [['BTC', false], ['ERA', true]]);
    const q = await swap.quote({ from: 'btc', to: 'era', amount: '0.01' });
    assert.deepStrictEqual([q.volumeOut, q.available], [1900, 1000]);
    const order = await swap.createOrder({ from: 'ERA', to: 'BTC', amount: '100', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' });
    assert.deepStrictEqual([order.payAsset, order.addr_in, order.addr_out_full], [1, B, 'BTC:1BoatSLRHtKNngkdXEeobR76b53LETtpyT']);
    assert.ok(seen.includes('/apipay/get_uri_in.json/2/ERA/BTC/1BoatSLRHtKNngkdXEeobR76b53LETtpyT/100'));
    assert.deepStrictEqual(await swap.history(order.id), { payments: [] }); // ещё нет платежей
    await assert.rejects(swap.quote({ from: 'DOGE', to: 'ERA', amount: '1' }), /не принимает DOGE/);
    await assert.rejects(swap.quote({ from: 'BTC', to: 'ERA', amount: '0.02' }), /7Pay: not found/);
});

test('7Pay: разбор истории как в Face2Face (массивы unconfirmed, pay_out)', () => {
    const { parseHistory } = require('../lib/sevenpay');
    const list = parseHistory({
        unconfirmed: [[{ abbrev: 'BTC' }, 0.01, 'tx-in-1', 0, 0, 0, '2026-10-01 10:00']],
        in_process: [{ curr_in: { abbrev: 'BTC' }, amount_in: 0.02, txid: 'tx-in-2', stasus: 'ok', status_mess: 'в очереди' }],
        done: [
            { curr_in: { abbrev: 'BTC' }, curr_out: { abbrev: 'ERA' }, amount_in: 0.03, txid: 'tx-in-3', stasus: 'ok',
              pay_out: { amount: 5500, amo_taken: 27, txid: 'tx-out-3', vars: { status: 'success' } } },
            { curr_in: { abbrev: 'BTC' }, curr_out: { abbrev: 'ERA' }, amount_in: 0.04, txid: 'tx-in-4', stasus: 'ok',
              pay_out: { amount: 7300, txid: null, vars: { status: 'pending' } } },
        ],
    }, 'ERA');
    assert.deepStrictEqual(list.map((p) => [p.stage, p.amountIn, p.amountOut, p.txidOut]), [
        ['unconfirmed', 0.01, null, null], ['in_process', 0.02, null, null],
        ['paid_out', 0.03, 5500, 'tx-out-3'], ['paying_out', 0.04, 7300, null],
    ]);
    assert.strictEqual(list[0].created, '2026-10-01 10:00');
});

test('сотрудники: роли, смена, отзыв доступа, журнал', async (t) => {
    const { api, call, accounts } = await startDemo(t);
    const me = accounts[0].address;
    const login = async (l, p) => api('POST', '/api/login', { login: l, password: p });

    // владелец заводит сотрудников
    assert.strictEqual((await call('POST', '/api/staff', { login: 'kassir', name: 'Анна', role: 'operator', password: 'short' })).status, 400);
    const k = await call('POST', '/api/staff', { login: 'Kassir', name: 'Анна', role: 'operator', password: 'kassir123' });
    assert.strictEqual(k.data.login, 'kassir');
    assert.strictEqual((await call('POST', '/api/staff', { login: 'kassir', role: 'viewer', password: 'whatever1' })).data.error, 'Такой логин уже есть');
    const b = await call('POST', '/api/staff', { login: 'buh', role: 'accountant', password: 'buh12345' });
    const { data: list } = await call('GET', '/api/staff');
    assert.ok(!JSON.stringify(list).includes('hash')); // хеши паролей наружу не отдаются

    assert.strictEqual((await login('kassir', 'wrongpass')).status, 401);
    const kt = (await login('kassir', 'kassir123')).data.token;
    const bt = (await login('buh', 'buh12345')).data.token;

    // смена закрыта — кассир не видит кошелёк
    assert.strictEqual((await api('GET', '/api/accounts', null, kt)).status, 423);
    assert.strictEqual((await api('POST', '/api/shift/open', {}, kt)).status, 403); // открывать смену может только администратор
    assert.strictEqual((await call('POST', '/api/shift/open', {})).data.open, true);

    // кассир переводит, бухгалтер — нет, но выгружает выписки
    const tr = await api('POST', '/api/transfer', { from: me, to: B, asset: 1, amount: '1', title: 'Касса' }, kt);
    assert.strictEqual(tr.status, 200, JSON.stringify(tr.data));
    assert.strictEqual((await api('POST', '/api/transfer', { from: me, to: B, asset: 1, amount: '1' }, bt)).status, 403);
    assert.strictEqual((await api('GET', `/api/bank/statement?address=${me}&format=csv`, null, bt)).status, 200);
    assert.strictEqual((await api('PUT', '/api/bank/settings', { currency: 'USD' }, bt)).status, 403);
    assert.strictEqual((await api('GET', '/api/staff', null, kt)).status, 403);

    // закрытие смены и отключение сотрудника действуют сразу
    await call('POST', '/api/shift/close');
    assert.strictEqual((await api('POST', '/api/transfer', { from: me, to: B, asset: 1, amount: '1' }, kt)).status, 423);
    await call('PATCH', '/api/staff/' + b.data.id, { disabled: true });
    assert.strictEqual((await api('GET', '/api/me', null, bt)).status, 401);
    assert.strictEqual((await login('buh', 'buh12345')).status, 403);

    // журнал: кто что сделал, без паролей
    const { data: audit } = await call('GET', '/api/audit');
    const transfer = audit.find((a) => a.action === 'POST /api/transfer' && a.ok);
    assert.deepStrictEqual([transfer.login, transfer.role, transfer.details.amount, transfer.details.title], ['kassir', 'operator', '1', 'Касса']);
    assert.ok(audit.some((a) => a.action === 'POST /api/login' && !a.ok && a.login === 'kassir'));
    assert.ok(!JSON.stringify(audit).includes('kassir123'));
});

test('СБП: QR → оплата → начисление по курсу; смена, дубли, отказ, восстановление', async () => {
    const { SbpService, SbpEmulator } = require('../lib/sbp');
    const backend = new DemoBackend();
    const store = new JsonStore(null, { sbpSettings: { payoutAccount: backend.mainAccount } });
    let shiftOpen = false;
    const sbp = new SbpService(new SbpEmulator({ acceptAfterMs: 0 }), backend, store, () => {
        if (!shiftOpen) throw new v.BankError('Смена закрыта: попросите администратора открыть смену', 423);
        return 'demo12345';
    });
    const client = Object.keys(Object.fromEntries(backend.accountsMap))[1];

    await assert.rejects(sbp.createOrder({ receiver: client, amount: '10', asset: 1 }), /Минимальная/);
    await assert.rejects(sbp.createOrder({ receiver: 'bad', amount: '100', asset: 1 }), /Неверный счёт/);
    await assert.rejects(sbp.createOrder({ receiver: client, amount: '100', asset: 777 }), /не продаётся/);

    const o = await sbp.createOrder({ receiver: client, amount: '551,00', asset: 1 });
    assert.deepStrictEqual([o.status, o.amountRub, o.amountChain], ['SBP_ACTIVE', 551, 20]); // 551 ₽ / 27.55 = 20 ERA
    assert.ok(o.payload.startsWith('https://qr.nspk.ru/'));
    assert.strictEqual((await sbp.createOrder({ receiver: client, amount: '551', asset: 1 })).id, o.id); // тот же заказ

    await sbp.tick(); // оплачен, но смена закрыта — ждёт в очереди
    assert.strictEqual(sbp.get(o.id).status, 'ERA_QUEUE');
    assert.match(sbp.get(o.id).message, /Смена закрыта/);

    shiftOpen = true;
    const before = backend.accountsMap.get(client).get(1);
    await sbp.tick();
    const sent = sbp.get(o.id);
    assert.strictEqual(sent.status, 'ERA_SEND');
    assert.strictEqual(backend.accountsMap.get(client).get(1) - before, 2000000000n); // +20 ERA
    const tx = backend.txs.find((t) => t.signature === sent.txId);
    assert.ok(tx.message.startsWith(sent.qrcId + ':')); // метка заказа в сообщении

    backend.height += 2;
    await sbp.tick();
    assert.strictEqual(sbp.get(o.id).status, 'ERA_DONE');
    assert.strictEqual(sbp.stats().creditedRub, 551);

    // отказ банка плательщика (сумма с 13 копейками в эмуляторе)
    const r = await sbp.createOrder({ receiver: client, amount: '100.13', asset: 1048 });
    await sbp.tick();
    assert.strictEqual(sbp.get(r.id).status, 'FAIL_SBP');

    // сбой во время начисления: после перезапуска выплата находится по метке и не повторяется
    const c = await sbp.createOrder({ receiver: client, amount: '200', asset: 1048 });
    await sbp.tick();
    const credited = sbp.get(c.id);
    assert.strictEqual(credited.status, 'ERA_SEND');
    const balance = backend.accountsMap.get(client).get(1048);
    Object.assign(credited, { status: 'ERA_SENDING', txId: null }); // как будто сервер упал до записи результата
    const restarted = new SbpService(sbp.client, backend, store, () => 'demo12345');
    await restarted.tick();
    assert.strictEqual(restarted.get(c.id).status, 'ERA_SEND');
    assert.ok(restarted.get(c.id).txId);
    assert.strictEqual(backend.accountsMap.get(client).get(1048), balance); // второго начисления нет
});

test('СБП: клиент банка «Точка» — пути, тело запроса, разбор статусов', async (t) => {
    const { TochkaSbpClient } = require('../lib/sbp');
    const seen = [];
    const srv = http.createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        const reply = (code, b) => { res.statusCode = code; res.end(JSON.stringify(b)); };
        if (req.url === '/qr-code/merchant/MF01/40702810000000000001/044525104') return reply(200, { Data: { qrcId: 'AD100', payload: 'https://qr.nspk.ru/AD100', image: { mediaType: 'image/png', content: 'iVBOR' } } });
        if (req.url === '/qr-codes/AD100,AD200/payment-status') return reply(200, { Data: { paymentList: [{ qrcId: 'AD200', status: 'Rejected', message: 'нет средств' }, { qrcId: 'AD100', status: 'Accepted', trxId: 'T1' }] } });
        return reply(400, { code: '400', message: 'Что-то пошло не так', Errors: [{ message: 'qrcode not found' }] });
    });
    const base = await listen(srv);
    t.after(() => srv.close());
    const c = new TochkaSbpClient({ token: 'tok', merchantId: 'MF01', account: '40702810000000000001', bik: '044525104', baseUrl: base });
    const qr = await c.createQr({ amountKop: 55095, purpose: 'Паевой взнос', sourceName: A, ttlMinutes: 10 });
    assert.deepStrictEqual([qr.qrcId, qr.image.content], ['AD100', 'iVBOR']);
    assert.strictEqual(seen[0].auth, 'Bearer tok');
    assert.deepStrictEqual(seen[0].body.Data, {
        amount: 55095, currency: 'RUB', qrcType: '02', paymentPurpose: 'Паевой взнос',
        imageParams: { width: 300, height: 300, mediaType: 'image/png' }, sourceName: A, ttl: 10,
    });
    const list = await c.paymentStatuses(['AD100', 'AD200']);
    assert.deepStrictEqual(list.map((p) => p.status), ['Rejected', 'Accepted']);
    await assert.rejects(c.qrInfo('XX'), /qrcode not found/);
});

test('СБП: публичная страница и права сотрудников', async (t) => {
    const { SbpEmulator } = require('../lib/sbp');
    const backend = new DemoBackend();
    const server = createServer(backend, {
        store: new JsonStore(null, { sbpSettings: { payoutAccount: backend.mainAccount } }), sbpClient: new SbpEmulator(), sbpIntervalMs: 0,
    });
    const base = await listen(server);
    t.after(() => server.close());
    const cfg = await (await fetch(base + '/api/public/sbp/config')).json();
    assert.strictEqual(cfg.enabled, true);
    const created = await fetch(base + '/api/public/sbp/orders', { method: 'POST', body: JSON.stringify({ receiver: A, amount: '300', asset: 1048 }) });
    const order = await created.json();
    assert.strictEqual(order.status, 'SBP_ACTIVE');
    assert.strictEqual(order.trxIdSbp, undefined); // служебные поля наружу не отдаются
    const viewed = await (await fetch(base + '/api/public/sbp/orders/' + order.id)).json();
    assert.strictEqual(viewed.id, order.id);
    assert.strictEqual((await fetch(base + '/api/sbp/orders')).status, 401); // список — только сотрудникам
    for (let i = 0; i < 9; i++) await fetch(base + '/api/public/sbp/orders', { method: 'POST', body: JSON.stringify({ receiver: A, amount: String(100 + i), asset: 1048 }) });
    assert.strictEqual((await fetch(base + '/api/public/sbp/orders', { method: 'POST', body: JSON.stringify({ receiver: A, amount: '999', asset: 1048 }) })).status, 429);
});

test('счета на оплату: магазин выставляет, банк находит по телефону и оплачивает, магазин видит оплату', async () => {
    const { Invoices, isPrivateIp, safeCallback } = require('../lib/invoices');
    const backend = new DemoBackend();
    const [payer, shop] = [...backend.accountsMap.keys()];
    const store = new JsonStore(null, { invoiceSettings: { channel: backend.invoiceChannel, trustedBanks: [] } });
    const inv = new Invoices(backend, store);

    await assert.rejects(inv.issue({ from: shop, user: '', sum: '10' }, 'demo12345'), /ID покупателя/);
    const issued = await inv.issue({ from: shop, user: '79161112233', order: 'A-1', sum: '250.5', curr: 643, title: 'Заказ A-1', callback: 'https://shop.example/cb?signature=' }, 'demo12345');
    assert.strictEqual(issued.status, 'issued');

    const found = await inv.find({ user: '79161112233' });
    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual([found[0].order, found[0].sum, found[0].currName, found[0].shop], ['A-1', 250.5, 'RUB', shop]);
    assert.strictEqual((await inv.find({ user: '70000000000' })).length, 0);

    const shopBefore = backend.accountsMap.get(shop).get(1048) || 0n;
    const paid = await inv.pay({ signature: found[0].signature, user: '79161112233', from: payer }, 'demo12345');
    assert.strictEqual(paid.status, 'paid');
    assert.strictEqual((backend.accountsMap.get(shop).get(1048) || 0n) - shopBefore, 25050000000n); // 250.5 «цифровых рублей»
    const tx = backend.txs.find((t) => t.signature === paid.txId);
    assert.deepStrictEqual(JSON.parse(tx.message), { orderSignature: found[0].signature, curr: 643, sum: 250.5 });
    assert.ok(paid.callback && paid.callback.ok === false); // магазин недоступен из теста — оплата всё равно проведена
    await assert.rejects(inv.pay({ signature: found[0].signature, user: '79161112233', from: payer }, 'demo12345'), /уже оплачен/);

    // магазин не доверяет счёту банка — оплата помечается как непроверенная
    let check = await inv.checkIssued('demo12345');
    assert.strictEqual(check.invoices[0].status, 'untrusted');
    // после добавления банка в доверенные следующая оплата засчитывается
    inv.updateSettings({ trustedBanks: [payer] });
    const second = await inv.issue({ from: shop, user: '79161112233', order: 'A-2', curr: 643 }, 'demo12345');
    await assert.rejects(inv.pay({ signature: second.signature, user: '79161112233', from: payer }, 'demo12345'), /без суммы/);
    await inv.pay({ signature: second.signature, user: '79161112233', from: payer, amount: '100' }, 'demo12345');
    check = await inv.checkIssued('demo12345');
    const s2 = check.invoices.find((i) => i.order === 'A-2');
    assert.deepStrictEqual([s2.status, s2.paidSum], ['paid', 100]);

    // просроченный счёт не оплачивается
    const old = await inv.issue({ from: shop, user: '79161112233', order: 'OLD', sum: '1', expire: 1 }, 'demo12345');
    backend.telegrams.find((m) => m.signature === old.signature).message = JSON.stringify({ ...JSON.parse(backend.telegrams.find((m) => m.signature === old.signature).message), date: Date.now() - 120000 });
    await assert.rejects(inv.pay({ signature: old.signature, user: '79161112233', from: payer }, 'demo12345'), /Срок счёта истёк/);

    // обратный вызов не уходит во внутреннюю сеть
    assert.ok(isPrivateIp('127.0.0.1') && isPrivateIp('10.1.2.3') && isPrivateIp('192.168.0.5') && !isPrivateIp('93.184.216.34'));
    assert.match((await safeCallback('http://shop.example/cb', 'S')).error, /https/);
    assert.match((await safeCallback('https://localhost/cb', 'S')).error, /внутренней сети/);
});

test('кредиты: график, выдача в долг, погашение, просрочка с неустойкой, взыскание, заверение', async () => {
    const { Loans, buildSchedule } = require('../lib/loans');
    const sched = buildSchedule({ principal: 120000, ratePct: 12, termMonths: 12, type: 'annuity', startDate: Date.parse('2026-01-15'), scale: 2 });
    assert.strictEqual(sched[0].total, 10661.85);
    assert.strictEqual(sched.reduce((s, r) => s + r.interest, 0).toFixed(2), '7942.26');
    assert.deepStrictEqual(Loans.preview({ principal: '120000', ratePct: '12', termMonths: 12, type: 'diff' }).schedule.map((r) => r.total).slice(0, 2), [11200, 11100]);

    const backend = new DemoBackend();
    const [bank, client] = [...backend.accountsMap.keys()];
    const loans = new Loans(backend, new JsonStore(null, {}));
    const P = 'demo12345';
    await assert.rejects(loans.create({ lender: bank, borrower: bank, asset: 1, principal: '10', ratePct: 10, termMonths: 3 }), /заёмщика/);
    const l = await loans.create({ lender: bank, borrower: client, borrowerName: 'Петров П.П.', asset: 1, assetName: 'ERA', principal: '300', ratePct: '24', termMonths: 3, scale: 2 });
    assert.strictEqual(l.status, 'draft');
    assert.match(l.number, /^КД-\d{4}-0001$/);

    const signed = await loans.sign(l.id, P);
    assert.strictEqual(signed.status, 'signed');
    const doc = backend.txs.find((t) => t.signature === signed.contractTx);
    assert.match(doc.message, /Заёмщик: Петров П\.П\./);
    await assert.rejects(loans.vouch(l.id, P), /ещё не подтверждена/); // заверить можно после блока
    backend.height += 2;
    assert.ok((await loans.vouch(l.id, P)).vouchTx);

    const clientBefore = backend.accountsMap.get(client).get(1);
    const issued = await loans.issue(l.id, P);
    assert.strictEqual(issued.status, 'active');
    assert.strictEqual(backend.accountsMap.get(client).get(1) - clientBefore, 30000000000n); // +300 ERA
    assert.strictEqual(backend.debtOf(bank, 1), 30000000000n); // у банка 300 ERA выдано в долг

    // платёж по графику: сначала проценты (300 * 2% = 6), потом тело
    const firstTotal = issued.schedule[0].total; // 104.03: аннуитет 300 под 24% на 3 месяца
    assert.strictEqual(firstTotal, 104.03);
    let after = await loans.repay(l.id, { amount: String(firstTotal) }, P);
    // срок не наступил — всё в тело досрочно; погашенный целиком период больше не несёт процентов
    assert.deepStrictEqual([after.payments[0].toInterest, after.payments[0].toPrincipal], [0, 104.03]);
    assert.deepStrictEqual([after.schedule[0].interest, after.state.restPrincipal], [0, 195.97]);

    // просрочка: «переносим» время вперёд на 40 дней после второго платежа
    const loan = loans.get(l.id);
    const now = loan.schedule[1].date + 40 * 86400000;
    const st = loans.state(loan, now);
    assert.ok(st.overdue > 0 && st.penalty > 0, JSON.stringify(st));

    // взыскание всей оставшейся задолженности
    after = await loans.confiscate(l.id, { amount: String(loans.state(loan).restPrincipal) }, P);
    assert.strictEqual(after.status, 'closed');
    assert.strictEqual(backend.debtOf(bank, 1), 0n);
    assert.strictEqual(backend.txs.find((t) => t.signature === after.payments[0].tx).typeName, 'Взыскание долга');

    // погашение, которое заёмщик сделал сам: находится по номеру договора
    const l2 = await loans.create({ lender: bank, borrower: client, asset: 1, principal: '100', ratePct: '0', termMonths: 2 });
    await loans.issue(l2.id, P);
    await backend.debtTransfer({ from: client, to: bank, asset: 1, amount: '50', title: `Погашение по договору ${l2.number}` }, P);
    const found = await loans.scan(l2.id, P);
    assert.deepStrictEqual([found.added, found.loan.state.restPrincipal], [1, 50]);
    assert.strictEqual((await loans.scan(l2.id, P)).added, 0); // повторно не засчитывается
});
