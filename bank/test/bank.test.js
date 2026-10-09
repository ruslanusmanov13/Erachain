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
    assert.strictEqual(hist.data.done.length, 1);
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
    assert.deepStrictEqual(await swap.history(order.id), { unconfirmed: [], inProcess: [], done: [] }); // ещё нет платежей
    await assert.rejects(swap.quote({ from: 'DOGE', to: 'ERA', amount: '1' }), /не принимает DOGE/);
    await assert.rejects(swap.quote({ from: 'BTC', to: 'ERA', amount: '0.02' }), /7Pay: not found/);
});
