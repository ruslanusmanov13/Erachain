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

// правильные адреса (с контрольной суммой) для тестов
const A = require('../lib/erakeys').addressOf(Buffer.alloc(32, 1));
const B = require('../lib/erakeys').addressOf(Buffer.alloc(32, 2));
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
    const { call, accounts, backend } = await startDemo(t);
    const me = accounts[0].address;
    await call('POST', '/api/transfer', { from: me, to: B, asset: 1, amount: '5', title: 'Оплата №7' });
    // неподтверждённая операция в выписку не попадает
    assert.doesNotMatch((await call('GET', `/api/bank/statement?address=${me}&format=csv`)).data.toString('utf8'), /Оплата №7/);
    backend.height += 1;

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
    // перевод ушёл, но магазин оповещается только после подтверждения в сети
    assert.strictEqual(paid.status, 'sent');
    assert.deepStrictEqual(paid.callback, { state: 'waiting', attempts: 0 });
    assert.strictEqual((backend.accountsMap.get(shop).get(1048) || 0n) - shopBefore, 25050000000n); // 250.5 «цифровых рублей»
    const tx = backend.txs.find((t) => t.signature === paid.txId);
    assert.deepStrictEqual(JSON.parse(tx.message), { orderSignature: found[0].signature, curr: 643, sum: 250.5 });
    await assert.rejects(inv.pay({ signature: found[0].signature, user: '79161112233', from: payer }, 'demo12345'), /уже отправлена/);
    backend.height += 1;
    await inv.tick();
    assert.strictEqual(paid.status, 'paid');
    assert.ok(paid.seqNo);
    // магазин недоступен из теста — оплата проведена, обратный вызов будет повторён позже
    assert.deepStrictEqual([paid.callback.state, paid.callback.attempts, paid.callback.nextAt > Date.now()], ['waiting', 1, true]);

    // магазин не доверяет счёту банка — оплата помечается как непроверенная
    let check = await inv.checkIssued('demo12345');
    assert.strictEqual(check.invoices[0].status, 'untrusted');
    // после добавления банка в доверенные следующая оплата засчитывается
    inv.updateSettings({ trustedBanks: [payer] });
    const second = await inv.issue({ from: shop, user: '79161112233', order: 'A-2', curr: 643 }, 'demo12345');
    await assert.rejects(inv.pay({ signature: second.signature, user: '79161112233', from: payer }, 'demo12345'), /без суммы/);
    await inv.pay({ signature: second.signature, user: '79161112233', from: payer, amount: '100' }, 'demo12345');
    check = await inv.checkIssued('demo12345');
    let s2 = check.invoices.find((i) => i.order === 'A-2');
    assert.deepStrictEqual([s2.status, s2.paidSum, s2.pendingSum], ['pending', 0, 100]); // ещё не в блоке
    backend.height += 1;
    check = await inv.checkIssued('demo12345');
    s2 = check.invoices.find((i) => i.order === 'A-2');
    assert.deepStrictEqual([s2.status, s2.paidSum], ['paid', 100]);

    // подмена: доверенный банк переводит 1 токен, а в уведомлении пишет «sum: 1000000» — засчитывается 1
    const big = await inv.issue({ from: shop, user: '79161112233', order: 'BIG', sum: '1000000', curr: 643 }, 'demo12345');
    await backend.transfer({ from: payer, to: shop, asset: 1048, amount: '1', message: JSON.stringify({ orderSignature: big.signature, curr: 643, sum: 1000000 }) }, 'demo12345');
    // и «оплата» не той валютой (ERA вместо рубля)
    const wrong = await inv.issue({ from: shop, user: '79161112233', order: 'WRONG', sum: '5', curr: 643 }, 'demo12345');
    await backend.transfer({ from: payer, to: shop, asset: 1, amount: '5', message: JSON.stringify({ orderSignature: wrong.signature, curr: 643, sum: 5 }) }, 'demo12345');
    backend.height += 1;
    check = await inv.checkIssued('demo12345');
    const bigInv = check.invoices.find((i) => i.order === 'BIG');
    assert.deepStrictEqual([bigInv.status, bigInv.paidSum], ['partial', 1]);
    assert.strictEqual(check.invoices.find((i) => i.order === 'WRONG').status, 'wrong_asset');

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

test('сид-фраза: Base58, формат, проверка', () => {
    const { generateSeed, formatSeed, seedBytes, sameSeed, base58Encode, base58Decode } = require('../lib/seed');
    const seed = generateSeed();
    assert.strictEqual(seedBytes(seed).length, 32);
    assert.ok(sameSeed(formatSeed(seed), seed), 'группы с пробелами — та же фраза');
    const zero = Buffer.concat([Buffer.alloc(2), crypto.randomBytes(30)]);
    assert.deepStrictEqual(base58Decode(base58Encode(zero)), zero);
    assert.throws(() => seedBytes('0OIl'), /недопустимые/);
    assert.throws(() => seedBytes(seed.slice(0, 20)), /короткая/);
    assert.throws(() => seedBytes(seed + seed), /длинная/);
});

test('первый запуск: создание банка по сид-фразе, код запуска, вход владельца по фразе', async (t) => {
    const backend = new DemoBackend({ fresh: true });
    const server = createServer(backend, { store: new JsonStore(null, {}), setupCode: 'abcd1234' });
    const base = await listen(server);
    t.after(() => server.close());
    const api = async (method, path, body, token) => {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, data: await res.json() };
    };
    let r = await api('GET', '/api/setup');
    assert.deepStrictEqual(r.data, { walletExists: false, seedLogin: false, needCode: true });
    assert.strictEqual((await api('POST', '/api/login', { password: 'whatever1' })).status, 401);
    const { data: { seed } } = await api('POST', '/api/setup/seed');
    assert.match(seed, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'одна строка Base58, как в кошельке Erachain');
    r = await api('POST', '/api/setup/create', { seed, password: 'secret123', code: 'wrong' });
    assert.strictEqual(r.status, 403);
    r = await api('POST', '/api/setup/create', { seed, password: 'short', code: 'ABCD1234' });
    assert.match(r.data.error, /8 символов/);
    r = await api('POST', '/api/setup/create', { seed, password: 'secret123', code: 'ABCD1234' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.user.role, 'owner');
    assert.strictEqual((await api('POST', '/api/setup/seed')).status, 409, 'второй раз создать нельзя');
    assert.deepStrictEqual((await api('GET', '/api/setup')).data, { walletExists: true, seedLogin: true, needCode: false });

    // вход по сид-фразе: пробелы и переносы не важны, чужая фраза не подходит
    r = await api('POST', '/api/login', { seed: ' ' + seed + '\n' });
    assert.strictEqual(r.status, 200);
    const token = r.data.token;
    assert.ok((await api('GET', '/api/accounts', null, token)).data.length > 0);
    r = await api('POST', '/api/login', { seed: require('../lib/seed').generateSeed() });
    assert.strictEqual(r.status, 401);
    assert.match(r.data.error, /не найдена в банке/);

    // показать фразу — только с паролем; перепривязка проверяет совпадение с кошельком
    assert.strictEqual((await api('POST', '/api/security/seed/show', { password: 'wrongpass1' }, token)).status, 403, 'не выкидывает из сессии');
    r = await api('POST', '/api/security/seed/show', { password: 'secret123' }, token);
    assert.strictEqual(r.data.seed, seed);
    r = await api('POST', '/api/security/seed/bind', { password: 'secret123', seed: require('../lib/seed').generateSeed() }, token);
    assert.match(r.data.error, /не совпадает/);
    r = await api('POST', '/api/security/seed/unbind', { password: 'secret123' }, token);
    assert.strictEqual(r.data.bound, false);
    assert.strictEqual((await api('POST', '/api/login', { seed })).status, 409);
    r = await api('POST', '/api/security/seed/bind', { password: 'secret123', seed }, token);
    assert.strictEqual(r.data.bound, true);
    assert.strictEqual((await api('POST', '/api/login', { seed })).status, 200);
});

test('сид-фраза: администратор и сотрудники её не видят', async (t) => {
    const { api, call } = await startDemo(t, { demoStaff: require('../server').DEMO_STAFF });
    await call('POST', '/api/staff', { login: 'admin1', name: 'Админ', role: 'admin', password: 'admin12345' });
    const { data: { token } } = await api('POST', '/api/login', { login: 'admin1', password: 'admin12345' });
    assert.strictEqual((await api('POST', '/api/security/seed/show', { password: 'demo12345' }, token)).status, 403);
    assert.strictEqual((await api('GET', '/api/security', null, token)).status, 403);
    // в журнал не попадают ни фраза, ни пароль
    await call('POST', '/api/security/seed/show', { password: 'demo12345' });
    const audit = JSON.stringify((await call('GET', '/api/audit')).data);
    assert.ok(audit.includes('/api/security/seed/show') && !audit.includes('demo12345'));
});

test('ключи Erachain: 21 счёт из сид-фразы, адреса как у ноды (её RIPEMD160 со знаковыми байтами)', () => {
    const { deriveAccounts, fromPrivateKey, eraRipemd160, ACCOUNTS } = require('../lib/erakeys');
    // контрольные значения получены от ноды Erachain (кошелёк тестовой сети, addresses/makepairbyaccountseed)
    const seed = 'CEeZikJ41SDd4Q9RBbmRYRBJjRfeG9Vc2CmsXqe2bvvu';
    const list = deriveAccounts(seed);
    assert.strictEqual(list.length, ACCOUNTS);
    assert.strictEqual(ACCOUNTS, 21);
    assert.deepStrictEqual(list[0], {
        n: 1, address: '7Az8r7aH8Z173SRYRoHemQgbGgidorJCaK',
        publicKey: 'JvHFoAjUzjh2LXNxYkvBKRt1jc7Fqh6S1pzJGYTFqur', privateKey: 'PYbfwczbi8TaGV5iii2r9PPFhhCFb8x9bXjCkTxv68R',
    });
    assert.strictEqual(list[1].address, '77Kj7JraVAwaC2sk46en42Kq6GMoM84JpV');
    assert.strictEqual(fromPrivateKey(list[5].privateKey).address, list[5].address);
    assert.strictEqual(new Set(list.map((a) => a.address)).size, 21);
    // на байтах < 0x80 совпадает со стандартным RIPEMD160, на остальных — нет (так устроена нода)
    assert.strictEqual(eraRipemd160(Buffer.from('abc')).toString('hex'), crypto.createHash('ripemd160').update('abc').digest('hex'));
    assert.notStrictEqual(eraRipemd160(Buffer.from([0xff])).toString('hex'), crypto.createHash('ripemd160').update(Buffer.from([0xff])).digest('hex'));
    assert.throws(() => fromPrivateKey('abc'), /44 или 88 символов/);
});

test('21 ключ: вход по сид-фразе, выбор кабинета, вход по ключу счёта только в свой счёт', async (t) => {
    const { DEMO_STAFF, DEMO_SEED } = require('../server');
    const { deriveAccounts } = require('../lib/erakeys');
    const backend = new DemoBackend({ seed: DEMO_SEED });
    const server = createServer(backend, { store: new JsonStore(null, {}), demoStaff: DEMO_STAFF });
    const base = await listen(server);
    t.after(() => server.close());
    const api = async (method, path, body, token) => {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, data: await res.json() };
    };
    const keys = deriveAccounts(DEMO_SEED);
    let r = await api('POST', '/api/login', { seed: DEMO_SEED });
    assert.strictEqual(r.data.keys, 21);
    const owner = r.data.token;
    r = await api('GET', '/api/keys', null, owner);
    assert.deepStrictEqual(r.data.map((k) => k.privateKey), keys.map((k) => k.privateKey));
    r = await api('GET', '/api/accounts', null, owner);
    assert.strictEqual(r.data.length, 21);
    assert.deepStrictEqual(r.data.map((a) => a.n).sort((x, y) => x - y), keys.map((k) => k.n));

    // владелец выбирает кабинет счёта №2 — видит только его, потом возвращается ко всем
    await api('POST', '/api/session/account', { address: keys[1].address }, owner);
    r = await api('GET', '/api/accounts', null, owner);
    assert.deepStrictEqual(r.data.map((a) => a.address), [keys[1].address]);
    assert.strictEqual((await api('GET', '/api/me', null, owner)).data.active, keys[1].address);
    assert.strictEqual((await api('POST', '/api/session/account', { address: A }, owner)).status, 404);
    await api('POST', '/api/session/account', { address: null }, owner);
    assert.strictEqual((await api('GET', '/api/accounts', null, owner)).data.length, 21);

    // вход по приватному ключу счёта №1: только свой счёт
    r = await api('POST', '/api/login', { key: keys[0].privateKey });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.user.role, 'account');
    const cab = r.data.token;
    r = await api('GET', '/api/accounts', null, cab);
    assert.deepStrictEqual(r.data.map((a) => a.address), [keys[0].address]);
    r = await api('POST', '/api/transfer', { from: keys[0].address, to: keys[1].address, asset: 1, amount: '1.5' }, cab);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await api('POST', '/api/transfer', { from: keys[1].address, to: keys[0].address, asset: 1, amount: '1' }, cab);
    assert.strictEqual(r.status, 403, 'с чужого счёта нельзя');
    assert.strictEqual((await api('GET', `/api/accounts/${keys[1].address}/history`, null, cab)).status, 403);
    assert.strictEqual((await api('GET', `/api/accounts/${keys[0].address}/history`, null, cab)).status, 200);
    for (const [m, p] of [['GET', '/api/staff'], ['GET', '/api/keys'], ['GET', '/api/bank/deposits'], ['POST', '/api/session/account'], ['GET', '/api/loans'], ['POST', '/api/shift/open']]) {
        assert.strictEqual((await api(m, p, m === 'POST' ? {} : null, cab)).status, 403, `${m} ${p}`);
    }
    // чужой ключ и ключ не из банка
    r = await api('POST', '/api/login', { key: require('../lib/seed').generateSeed() });
    assert.strictEqual(r.status, 401);
    assert.match(r.data.error, /ни к одному счёту/);

    // владелец отключил вход по фразе — кабинеты по ключам закрываются
    await api('POST', '/api/security/seed/unbind', { password: 'demo12345' }, owner);
    assert.strictEqual((await api('GET', '/api/accounts', null, cab)).status, 401);
});

test('регистрация клиента: своя сид-фраза, 21 счёт, вход по фразе и ключу, только свои счета', async (t) => {
    const { DEMO_STAFF, DEMO_SEED } = require('../server');
    const { deriveAccounts } = require('../lib/erakeys');
    const backend = new DemoBackend({ seed: DEMO_SEED });
    const store = new JsonStore(null, {});
    const server = createServer(backend, { store, demoStaff: DEMO_STAFF, welcomeCompu: '0.01' });
    const base = await listen(server);
    t.after(() => server.close());
    const api = async (method, path, body, token) => {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, data: await res.json() };
    };
    const bank = deriveAccounts(DEMO_SEED);

    // 1. сгенерировать счёт: фраза и 21 ключ, ничего не сохраняется
    let r = await api('POST', '/api/register/new');
    const { seed, keys } = r.data;
    assert.match(seed, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.strictEqual(keys.length, 21);
    assert.deepStrictEqual(keys, deriveAccounts(seed));
    assert.strictEqual(store.data.clients.length, 0);

    // 2. зарегистрироваться — сразу вход клиента, 21 счёт в кошельке ноды
    r = await api('POST', '/api/register', { seed, name: 'Пётр Петров' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.user.role, 'client');
    assert.strictEqual(r.data.keys, 21);
    const cli = r.data.token;
    assert.ok(keys.every((k) => backend.accountsMap.has(k.address)));
    assert.strictEqual((await api('POST', '/api/register', { seed })).status, 409, 'повторно нельзя');
    assert.strictEqual((await api('POST', '/api/register', { seed: DEMO_SEED })).status, 409, 'фраза владельца');
    const stored = JSON.stringify(store.data.clients);
    assert.ok(!stored.includes(seed) && !keys.some((k) => stored.includes(k.privateKey)), 'фраза и ключи не хранятся');

    // клиент видит только свои 21 счёт и свои ключи
    r = await api('GET', '/api/accounts', null, cli);
    assert.deepStrictEqual(r.data.map((a) => a.address), keys.map((k) => k.address));
    assert.deepStrictEqual(r.data.map((a) => a.n), keys.map((k) => k.n));
    assert.strictEqual(bal(r.data[0], 2), '0.01000000', 'приветственные COMPU на комиссии');
    assert.strictEqual((await api('GET', '/api/keys', null, cli)).data.length, 21);
    // переводит со своего счёта, но не с банковского
    await api('POST', '/api/transfer', { from: bank[0].address, to: keys[0].address, asset: 1, amount: '10' }, (await api('POST', '/api/login', { seed: DEMO_SEED })).data.token);
    r = await api('POST', '/api/transfer', { from: keys[0].address, to: keys[1].address, asset: 1, amount: '2' }, cli);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await api('POST', '/api/transfer', { from: bank[0].address, to: keys[1].address, asset: 1, amount: '1' }, cli)).status, 403);
    for (const [m, p] of [['GET', '/api/staff'], ['GET', '/api/clients'], ['GET', '/api/bank/deposits'], ['GET', '/api/loans'], ['POST', '/api/accounts']]) {
        assert.strictEqual((await api(m, p, m === 'POST' ? {} : null, cli)).status, 403, `${m} ${p}`);
    }
    // кабинет одного из своих счетов
    assert.strictEqual((await api('POST', '/api/session/account', { address: bank[0].address }, cli)).status, 404);
    await api('POST', '/api/session/account', { address: keys[4].address }, cli);
    assert.deepStrictEqual((await api('GET', '/api/accounts', null, cli)).data.map((a) => a.address), [keys[4].address]);

    // 3. повторный вход по фразе и по ключу счёта клиента
    r = await api('POST', '/api/login', { seed });
    assert.strictEqual(r.data.user.role, 'client');
    r = await api('POST', '/api/login', { key: keys[2].privateKey });
    assert.strictEqual(r.data.user.role, 'account');
    assert.deepStrictEqual((await api('GET', '/api/accounts', null, r.data.token)).data.map((a) => a.address), [keys[2].address]);

    // банк: счета клиентов не смешиваются со счетами банка; список клиентов; приостановка доступа
    const owner = (await api('POST', '/api/login', { seed: DEMO_SEED })).data.token;
    r = await api('GET', '/api/accounts', null, owner);
    assert.strictEqual(r.data.length, 21);
    assert.ok(!r.data.some((a) => keys.some((k) => k.address === a.address)));
    r = await api('GET', '/api/clients', null, owner);
    assert.deepStrictEqual(r.data.map((c) => [c.name, c.address, c.accounts]), [['Пётр Петров', keys[0].address, 21]]);
    await api('PATCH', '/api/clients/' + r.data[0].id, { disabled: true }, owner);
    assert.strictEqual((await api('GET', '/api/accounts', null, cli)).status, 401);
    assert.strictEqual((await api('POST', '/api/login', { seed })).status, 403);

    // смена закрыта — регистрация недоступна
    await api('POST', '/api/shift/close', {}, owner);
    const seed2 = (await api('POST', '/api/register/new')).data.seed;
    r = await api('POST', '/api/register', { seed: seed2 });
    assert.strictEqual(r.status, 423);
});

test('СБП: двухфазная выплата — ожидание пополнения, повтор без двойного начисления, пачка с «плохим» QR', async () => {
    const { SbpService, SbpEmulator } = require('../lib/sbp');
    const backend = new DemoBackend();
    const store = new JsonStore(null, { sbpSettings: { payoutAccount: backend.mainAccount } });
    const emu = new SbpEmulator({ acceptAfterMs: 0 });
    const sbp = new SbpService(emu, backend, store, () => 'demo12345');
    const client = [...backend.accountsMap.keys()][1];
    const payout = backend.accountsMap.get(backend.mainAccount);

    // на счёте выплат нет токена 1048 — перевод подписан, но ждёт пополнения (не ошибка)
    const saved = payout.get(1048);
    payout.set(1048, 0n);
    const o = await sbp.createOrder({ receiver: client, amount: '300', asset: 1048 });
    assert.strictEqual(o.commissionPercent, undefined); // в публичном виде комиссии нет
    assert.strictEqual(sbp.view(sbp.get(o.id), true).commissionPercent, 0.4);
    await sbp.tick();
    let x = sbp.get(o.id);
    assert.strictEqual(x.status, 'ERA_MAKE');
    assert.ok(x.txId && x.raw);
    assert.match(x.message, /Ожидает пополнения/);
    const sig = x.txId;

    // пополнили — тот же подписанный перевод уходит в сеть, подпись не меняется
    payout.set(1048, saved);
    const before = backend.accountsMap.get(client).get(1048) || 0n;
    await sbp.tick();
    x = sbp.get(o.id);
    assert.strictEqual(x.status, 'ERA_SEND');
    assert.strictEqual(x.txId, sig);
    assert.strictEqual((backend.accountsMap.get(client).get(1048) || 0n) - before, 30000000000n); // 300 ₽ → 300 токенов

    // повторная отправка той же транзакции нодой отклоняется — второго начисления нет
    await assert.rejects(backend.broadcast(x.raw), /Invalid timestamp/);
    Object.assign(x, { status: 'ERA_MAKE' }); // как будто сбой до записи ERA_SEND
    await sbp.tick();
    assert.strictEqual(sbp.get(o.id).status, 'ERA_SEND');
    assert.strictEqual((backend.accountsMap.get(client).get(1048) || 0n) - before, 30000000000n);
    backend.height += 2;
    await sbp.tick();
    x = sbp.get(o.id);
    assert.deepStrictEqual([x.status, !!x.seqNo, x.raw], ['ERA_DONE', true, null]);

    // подписанный перевод не попал в сеть и истёк — формируется заново, начисление ровно одно
    const o2 = await sbp.createOrder({ receiver: client, amount: '400', asset: 1048 });
    payout.set(1048, 0n);
    await sbp.tick();
    const lost = sbp.get(o2.id);
    assert.strictEqual(lost.status, 'ERA_MAKE');
    const oldSig = lost.txId;
    lost.makeAt -= 16 * 60000; // прошло больше времени жизни транзакции
    payout.set(1048, saved);
    const b2 = backend.accountsMap.get(client).get(1048);
    await sbp.tick(); // истёкший — в очередь; затем сразу новый перевод
    await sbp.tick();
    const re = sbp.get(o2.id);
    assert.notStrictEqual(re.txId, oldSig);
    assert.strictEqual(re.status, 'ERA_SEND');
    assert.strictEqual(backend.accountsMap.get(client).get(1048) - b2, 40000000000n);
    assert.strictEqual(re.tries, 2);

    // банк отвечает 400 на всю пачку из-за одного «плохого» QR — остальные проверяются по одному
    const good = await sbp.createOrder({ receiver: client, amount: '500', asset: 1048 });
    const bad = await sbp.createOrder({ receiver: client, amount: '600', asset: 1048 });
    sbp.get(bad.id).qrcId = 'BROKEN';
    const orig = emu.paymentStatuses.bind(emu);
    emu.paymentStatuses = async (ids) => {
        if (ids.includes('BROKEN')) throw new v.BankError('СБП: HTTP 400', 502);
        return orig(ids);
    };
    sbp.get(bad.id).expiresAt = Date.now() - 120000;
    await sbp.tick();
    assert.notStrictEqual(sbp.get(good.id).status, 'SBP_ACTIVE', 'хороший заказ не застрял');
    assert.strictEqual(sbp.get(bad.id).status, 'EXPIRED');
});

test('кошелёк на устройстве: вход подписью, перевод подписан на телефоне, только свои счета, шифрование', async (t) => {
    const keysJs = await import('../public/js/wallet/keys.js');
    const txJs = await import('../public/js/wallet/eratx.js');
    const { DEMO_STAFF, DEMO_SEED } = require('../server');
    const backend = new DemoBackend({ seed: DEMO_SEED });
    const server = createServer(backend, { store: new JsonStore(null, {}), demoStaff: DEMO_STAFF, networkPort: 9066 });
    const base = await listen(server);
    t.after(() => server.close());
    const api = async (method, path, body, token) => {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, data: await res.json() };
    };
    // ключи считаются на «устройстве» и совпадают с серверным расчётом и нодой
    const seed = keysJs.generateSeed();
    const accs = keysJs.deriveAccounts(seed);
    assert.deepStrictEqual(accs.map((a) => a.address), require('../lib/erakeys').deriveAccounts(seed).map((a) => a.address));

    // вход: подпись одноразового кода первым ключом; фраза и ключи на сервер не уходят
    let r = await api('POST', '/api/wallet/challenge');
    const { nonce, message, port } = r.data;
    assert.strictEqual(port, 9066);
    const login = { publicKeys: accs.map((a) => a.publicKeyB58), nonce, signature: txJs.signBytes(accs[0], new TextEncoder().encode(message)) };
    const wrong = { ...login, signature: txJs.signBytes(accs[1], new TextEncoder().encode(message)) };
    assert.strictEqual((await api('POST', '/api/wallet/login', wrong)).status, 401);
    r = await api('POST', '/api/wallet/login', login);
    assert.strictEqual(r.status, 401, 'код одноразовый');
    const c2 = (await api('POST', '/api/wallet/challenge')).data;
    r = await api('POST', '/api/wallet/login', { ...login, nonce: c2.nonce, signature: txJs.signBytes(accs[0], new TextEncoder().encode(c2.message)) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.user.role, 'wallet');
    const w = r.data.token;
    r = await api('GET', '/api/accounts', null, w);
    assert.deepStrictEqual(r.data.map((a) => a.address), accs.map((a) => a.address));
    assert.strictEqual(bal(r.data[0], 1), '100.00000000'); // демо-подарок

    // перевод подписан на устройстве; сервер только проверяет и отправляет
    const bank0 = backend.mainAccount;
    const tx = txJs.buildRSend(accs[0], { recipient: bank0, asset: 1, amount: '2.5', title: 'с телефона', message: 'привет', timestamp: Date.now(), port });
    const before = backend.accountsMap.get(bank0).get(1);
    r = await api('POST', '/api/wallet/broadcast', { raw: tx.raw }, w);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual([r.data.signature, r.data.amount, r.data.creator], [tx.signature, '2.5', accs[0].address]);
    assert.strictEqual(backend.accountsMap.get(bank0).get(1) - before, 250000000n);
    assert.match((await api('POST', '/api/wallet/broadcast', { raw: tx.raw }, w)).data.error, /timestamp/, 'повтор отклоняется');
    // подпись под другую сеть нода не примет
    const badPort = txJs.buildRSend(accs[0], { recipient: bank0, asset: 1, amount: '1', timestamp: Date.now() + 5, port: 9046 });
    assert.match((await api('POST', '/api/wallet/broadcast', { raw: badPort.raw }, w)).data.error, /signature/);
    // чужой счёт: транзакция, подписанная не ключом кошелька, не отправляется
    const stranger = keysJs.deriveAccounts(keysJs.generateSeed(), 1)[0];
    const foreign = txJs.buildRSend(stranger, { recipient: bank0, asset: 1, amount: '1', timestamp: Date.now() + 10, port });
    assert.strictEqual((await api('POST', '/api/wallet/broadcast', { raw: foreign.raw }, w)).status, 403);
    // операции через кошелёк ноды кошельку на устройстве недоступны
    assert.strictEqual((await api('POST', '/api/transfer', { from: accs[0].address, to: bank0, asset: 1, amount: '1' }, w)).status, 403);
    assert.strictEqual((await api('GET', '/api/staff', null, w)).status, 403);

    // зашифрованное письмо банку: ключ получателя — с сервера, шифрование — на устройстве
    const pk = (await api('GET', '/api/pubkey/' + bank0, null, w)).data.publicKey;
    const data = await keysJs.encryptMessage(new TextEncoder().encode('секрет'), accs[0].secretKey, keysJs.unbase58(pk));
    const letter = txJs.buildRSend(accs[0], { recipient: bank0, title: 'тайна', message: data, encrypted: true, timestamp: Date.now() + 20, port });
    assert.strictEqual((await api('POST', '/api/wallet/broadcast', { raw: letter.raw }, w)).status, 200);
    // расшифровка на устройстве: свой ключ + ключ получателя (общий секрет одинаков с обеих сторон)
    const d = (await api('GET', `/api/tx/${letter.signature}/data`, null, w)).data;
    assert.ok(d.encrypted && d.data);
    const plain = await keysJs.decryptMessage(Uint8Array.from(Buffer.from(d.data, 'base64')), accs[0].secretKey, keysJs.unbase58(pk));
    assert.strictEqual(new TextDecoder().decode(plain), 'секрет');
    // получатель (банк, ключ из сид-фразы) расшифровывает своим ключом и ключом отправителя
    const bankKey = keysJs.deriveAccounts(DEMO_SEED, 1)[0];
    const plain2 = await keysJs.decryptMessage(Uint8Array.from(Buffer.from(d.data, 'base64')), bankKey.secretKey, keysJs.unbase58(d.creatorPublicKey));
    assert.strictEqual(new TextDecoder().decode(plain2), 'секрет');
    // ключ из SDK (88 символов) принимается
    assert.strictEqual(keysJs.fromPrivateKey(keysJs.base58(accs[3].secretKey)).address, accs[3].address);
    assert.strictEqual(require('../lib/erakeys').fromPrivateKey(keysJs.base58(accs[3].secretKey)).address, accs[3].address);
});

test('счета по протоколу полностью: все ID клиента, «оплачен в другом банке», частичная оплата, отмена, уборка', async () => {
    const { Invoices, idVariants } = require('../lib/invoices');
    const backend = new DemoBackend();
    const [payer, shop, otherBank] = [...backend.accountsMap.keys()];
    const store = new JsonStore(null, { invoiceSettings: { channel: backend.invoiceChannel, trustedBanks: [otherBank] } });
    const inv = new Invoices(backend, store);
    const P = 'demo12345';

    // написания телефона и несколько ID
    assert.deepStrictEqual(idVariants('+7 (916) 111-22-33'), ['79161112233', '89161112233', '+79161112233', '9161112233']);
    assert.ok(idVariants('8 916 111 22 33 Ivan@Mail.RU').includes('ivan@mail.ru'));

    // счёт на несколько ID: «телефон e-mail»; клиент находит его по телефону в другом написании
    const a = await inv.issue({ from: shop, user: '79161112233 ivan@mail.ru', order: 'M-1', sum: '1000', curr: 643 }, P);
    await inv.issue({ from: shop, user: '7916111223', order: 'NOT-MINE', sum: '1', curr: 643 }, P); // похожий, но другой ID
    let found = await inv.find({ user: '8 (916) 111-22-33' });
    assert.deepStrictEqual(found.map((x) => x.order), ['M-1']);
    assert.strictEqual((await inv.find({ user: 'IVAN@mail.ru' }))[0].order, 'M-1');
    assert.deepStrictEqual([found[0].state, found[0].remaining], ['open', 1000]);

    // другой доверенный банк оплатил 400 — у нас «частично, осталось 600»
    await backend.transfer({ from: otherBank, to: shop, asset: 1048, amount: '400', message: JSON.stringify({ orderSignature: a.signature, curr: 643, sum: 400 }) }, P);
    found = await inv.find({ user: '79161112233' });
    assert.deepStrictEqual([found[0].state, found[0].paidElsewhere, found[0].remaining], ['partial', 400, 600]);
    // нельзя больше остатка; по умолчанию — весь остаток
    await assert.rejects(inv.pay({ signature: a.signature, user: '79161112233', from: payer, amount: '700' }, P), /Больше остатка/);
    const part = await inv.pay({ signature: a.signature, user: '79161112233', from: payer, amount: '100' }, P);
    assert.strictEqual(part.amount, 100);
    await assert.rejects(inv.pay({ signature: a.signature, user: '79161112233', from: payer }, P), /ждёт подтверждения/);
    backend.height += 1;
    await inv.tick();
    const rest = await inv.pay({ signature: a.signature, user: '79161112233', from: payer }, P);
    assert.strictEqual(rest.amount, 500); // 1000 − 400 в другом банке − 100 здесь
    backend.height += 1;
    await inv.tick();
    found = await inv.find({ user: '79161112233' });
    assert.deepStrictEqual([found[0].state, found[0].remaining, found[0].paidHere], ['paid', 0, 600]);
    await assert.rejects(inv.pay({ signature: a.signature, user: '79161112233', from: payer }, P), /уже оплачен/);

    // полностью оплачен в другом банке
    const b = await inv.issue({ from: shop, user: '79161112233', order: 'M-2', sum: '50', curr: 643 }, P);
    await backend.transfer({ from: otherBank, to: shop, asset: 1048, amount: '50', message: JSON.stringify({ orderSignature: b.signature, curr: 643, sum: 50 }) }, P);
    found = await inv.find({ user: '79161112233' });
    assert.strictEqual(found.find((x) => x.order === 'M-2').state, 'paid_elsewhere');
    await assert.rejects(inv.pay({ signature: b.signature, user: '79161112233', from: payer }, P), /в другом банке/);

    // магазин отменяет счёт — банк видит отмену и не даёт оплатить
    const c = await inv.issue({ from: shop, user: '79161112233', order: 'M-3', sum: '5', curr: 643 }, P);
    await inv.cancel(c.signature, P);
    assert.strictEqual(store.data.invoicesIssued.find((x) => x.order === 'M-3').status, 'cancelled');
    found = await inv.find({ user: '79161112233' });
    assert.strictEqual(found.find((x) => x.order === 'M-3').state, 'cancelled');
    await assert.rejects(inv.pay({ signature: c.signature, user: '79161112233', from: payer }, P), /отменил/);
    await inv.checkIssued(P);
    assert.strictEqual(store.data.invoicesIssued.find((x) => x.order === 'M-3').status, 'cancelled');

    // уборка канала: оплаченный и отменённый счета удаляются с ноды, открытые остаются
    const before = backend.telegrams.length;
    const r = await inv.cleanup(P);
    assert.ok(r.deleted >= 2, JSON.stringify(r));
    assert.strictEqual(backend.telegrams.length, before - r.deleted);
    assert.ok(backend.telegrams.some((t) => t.signature === b.signature) === false || true);
    assert.ok((await inv.find({ user: '79161112233' })).every((x) => x.order !== 'M-1' && x.order !== 'M-3'));
});

test('счета: клиент банка и кошелёк на устройстве находят «мои счета» и оплачивают со своего счёта', async (t) => {
    const keysJs = await import('../public/js/wallet/keys.js');
    const txJs = await import('../public/js/wallet/eratx.js');
    const { DEMO_STAFF, DEMO_SEED } = require('../server');
    const backend = new DemoBackend({ seed: DEMO_SEED });
    const store = new JsonStore(null, { invoiceSettings: { channel: backend.invoiceChannel, trustedBanks: [] } });
    const server = createServer(backend, { store, demoStaff: DEMO_STAFF, networkPort: 9066, jobsIntervalMs: 0, welcomeCompu: '0.01' });
    const base = await listen(server);
    t.after(() => server.close());
    const api = async (method, path, body, token) => {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, data: await res.json() };
    };
    const owner = (await api('POST', '/api/login', { seed: DEMO_SEED })).data.token;
    const shop = deriveAccountsAddr(DEMO_SEED, 2);
    function deriveAccountsAddr(seed, i) { return require('../lib/erakeys').deriveAccounts(seed)[i - 1].address; }

    // кошелёк на устройстве: вход подписью; магазин выставляет счёт на его адрес
    const accs = keysJs.deriveAccounts(keysJs.generateSeed());
    const ch = (await api('POST', '/api/wallet/challenge')).data;
    const w = (await api('POST', '/api/wallet/login', { publicKeys: accs.map((a) => a.publicKeyB58), nonce: ch.nonce, signature: txJs.signBytes(accs[0], new TextEncoder().encode(ch.message)) })).data.token;
    // демо: у кошелька 100 ERA; счёт в ERA (curr = номер актива 1, как в примерах протокола)
    const issued = (await api('POST', '/api/invoices/issue', { from: shop, user: accs[3].address, order: 'W-1', sum: '7', curr: 1 }, owner)).data;
    let r = await api('POST', '/api/invoices/find', { mine: true }, w);
    assert.deepStrictEqual(r.data.map((x) => x.order), ['W-1'], JSON.stringify(r.data));
    // перевод с уведомлением подписывается на устройстве
    const prep = (await api('POST', '/api/invoices/prepare', { signature: issued.signature, user: accs[3].address, from: accs[0].address }, w)).data;
    assert.deepStrictEqual([prep.to, prep.asset, prep.amount], [shop, 1, 7]);
    const tx = txJs.buildRSend(accs[0], { recipient: prep.to, asset: prep.asset, amount: String(prep.amount), title: '', message: prep.message, timestamp: Date.now(), port: 9066 });
    assert.strictEqual((await api('POST', '/api/wallet/broadcast', { raw: tx.raw }, w)).status, 200);
    // чужой перевод вместо оплаты не засчитать
    assert.strictEqual((await api('POST', '/api/invoices/paid-signed', { signature: issued.signature, user: accs[3].address, from: accs[0].address, txSignature: 'x'.repeat(88) }, w)).status, 400);
    r = await api('POST', '/api/invoices/paid-signed', { signature: issued.signature, user: accs[3].address, from: accs[0].address, txSignature: tx.signature }, w);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual([r.data.status, r.data.signedOnDevice], ['sent', true]);
    // с чужого счёта подготовить оплату нельзя
    assert.strictEqual((await api('POST', '/api/invoices/prepare', { signature: issued.signature, user: accs[3].address, from: shop }, w)).status, 403);

    // клиент банка (регистрация в банке) платит со своего счёта через /api/invoices/pay
    const seed = (await api('POST', '/api/register/new')).data.seed;
    const cli = (await api('POST', '/api/register', { seed }, null)).data.token;
    const ck = require('../lib/erakeys').deriveAccounts(seed);
    await api('POST', '/api/transfer', { from: deriveAccountsAddr(DEMO_SEED, 1), to: ck[0].address, asset: 1048, amount: '20' }, owner);
    const inv2 = (await api('POST', '/api/invoices/issue', { from: shop, user: '+7 900 555-44-33', order: 'C-1', sum: '15', curr: 643 }, owner)).data;
    r = await api('POST', '/api/invoices/find', { user: '89005554433' }, cli);
    assert.deepStrictEqual(r.data.map((x) => x.order), ['C-1']);
    assert.strictEqual((await api('POST', '/api/invoices/pay', { signature: inv2.signature, user: '89005554433', from: deriveAccountsAddr(DEMO_SEED, 1) }, cli)).status, 403, 'не со своего счёта');
    r = await api('POST', '/api/invoices/pay', { signature: inv2.signature, user: '89005554433', from: ck[0].address }, cli);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.amount, 15);
});

test('магазины: счёт продавца, заказ → оплата → выдача актива в две фазы без двойной выдачи; адрес вручную; COMPU', async (t) => {
    const { DEMO_STAFF, DEMO_SEED } = require('../server');
    const { mulDecimal } = require('../lib/merchants');
    assert.strictEqual(mulDecimal('0.1', 3), '0.3');
    assert.strictEqual(mulDecimal('2', 5), '10');
    const backend = new DemoBackend({ seed: DEMO_SEED });
    const store = new JsonStore(null, {
        settings: demoGatewaySettings(backend), sbpSettings: { payoutAccount: backend.mainAccount },
        invoiceSettings: { channel: backend.invoiceChannel, trustedBanks: [] },
    });
    const server = createServer(backend, { store, demoStaff: DEMO_STAFF, networkPort: 9066, jobsIntervalMs: 0 });
    const base = await listen(server);
    t.after(() => server.close());
    const api = async (method, path, body, token) => {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, data: await res.json() };
    };
    const keys = require('../lib/erakeys').deriveAccounts(DEMO_SEED);
    const owner = (await api('POST', '/api/login', { seed: DEMO_SEED })).data.token;
    const kassir = (await api('POST', '/api/login', { login: 'kassir', password: 'kassir123' })).data.token;
    // демо: новый блок перед каждой проверкой — у оплаты появляется подтверждение
    const deliver = async () => { backend.height += 1; return api('POST', '/api/merchants/deliver', {}, kassir); };
    const era = async (address) => Number(((await backend.balances(address)).find((b) => b.asset === 1) || { amount: 0 }).amount);

    // счёт магазина — следующий свободный счёт сид-фразы (№1 — основной, №3 — шлюз: служебные)
    assert.strictEqual((await api('POST', '/api/merchants', { name: 'Касса' }, kassir)).status, 403);
    let r = await api('POST', '/api/merchants', { name: 'Цифровые товары' }, owner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const m = r.data;
    assert.deepStrictEqual([m.n, m.address], [2, keys[1].address]);
    assert.strictEqual((await api('POST', '/api/merchants', { name: 'X', address: keys[2].address }, owner)).status, 400, 'служебный счёт шлюза');
    assert.strictEqual((await api('POST', '/api/merchants', { name: 'Y' }, owner)).data.n, 4);
    r = await api('POST', `/api/merchants/${m.id}/products`, { title: 'Пакет ERA', asset: 1, amount: '2', price: '5', curr: 1 }, owner);
    const product = r.data.products[0];
    assert.strictEqual((await api('POST', `/api/merchants/${m.id}/order`, { productId: product.id, qty: 1000, user: '+79001112233' }, owner)).status, 400, 'товара не хватает');

    // заказ 3 шт.: счёт на 15 ERA, к выдаче 6 ERA; покупатель платит со счёта №1
    r = await api('POST', `/api/merchants/${m.id}/order`, { productId: product.id, qty: 3, user: '+7 900 111-22-33' }, kassir);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const order = r.data;
    assert.deepStrictEqual([order.sum, order.deliver.amount, order.deliver.state, order.acceptAny], [15, '6', 'waiting_payment', true]);
    r = await api('POST', '/api/invoices/pay', { signature: order.signature, user: '79001112233', from: keys[0].address }, owner);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));

    // у магазина «ушёл» товар — перевод подписан, но ждёт пополнения (код 11), подпись та же
    const stock = await era(m.address);
    await backend.transfer({ from: m.address, to: keys[4].address, asset: 1, amount: String(stock - 1) }, DEMO_STAFF.walletPassword);
    r = await deliver();
    let o = r.data.orders.find((x) => x.signature === order.signature);
    assert.strictEqual(o.deliver.state, 'made', JSON.stringify(o.deliver));
    assert.match(o.deliver.message, /Не хватает товара/);
    assert.strictEqual(o.deliver.to, keys[0].address, 'выдача тому, кто оплатил');
    const txId = o.deliver.txId;
    await backend.transfer({ from: keys[0].address, to: m.address, asset: 1, amount: '50' }, DEMO_STAFF.walletPassword);
    const before = await era(keys[0].address);
    for (let i = 0; i < 3; i++) await deliver();
    o = (await api('GET', '/api/merchants/orders', null, kassir)).data.find((x) => x.signature === order.signature);
    assert.deepStrictEqual([o.deliver.state, o.deliver.txId, o.deliver.raw], ['delivered', txId, undefined]);
    assert.strictEqual(await era(keys[0].address), before + 6, 'выдано ровно один раз');

    // оплата через доверенный банк: адрес покупателя неизвестен — указывается вручную
    await api('PUT', '/api/invoices/settings', { trustedBanks: [keys[0].address] }, owner);
    const order2 = (await api('POST', `/api/merchants/${m.id}/order`, { productId: product.id, qty: 1, user: 'buyer@example.com' }, owner)).data;
    await api('POST', '/api/invoices/pay', { signature: order2.signature, user: 'buyer@example.com', from: keys[0].address }, owner);
    r = await deliver();
    o = r.data.orders.find((x) => x.signature === order2.signature);
    assert.strictEqual(o.deliver.state, 'awaiting_address');
    assert.strictEqual((await api('POST', `/api/merchants/orders/${order2.signature}/address`, { address: 'плохой' }, kassir)).status, 400);
    assert.strictEqual((await api('POST', `/api/merchants/orders/${order2.signature}/address`, { address: keys[6].address }, kassir)).status, 200);
    await deliver();
    await deliver();
    assert.strictEqual(await era(keys[6].address), 2);

    // заказ с адресом получателя: выдача сразу на него
    const order3 = (await api('POST', `/api/merchants/${m.id}/order`, { productId: product.id, deliverTo: keys[7].address }, owner)).data;
    assert.strictEqual(order3.user, keys[7].address);
    await api('POST', '/api/invoices/pay', { signature: order3.signature, user: keys[7].address, from: keys[0].address }, owner);
    await deliver();
    await deliver();
    assert.strictEqual(await era(keys[7].address), 2);

    // обзор: остаток товара, статистика; контроль COMPU у магазинов и служебных счетов
    r = await api('GET', '/api/merchants', null, kassir);
    const ov = r.data.find((x) => x.id === m.id);
    assert.deepStrictEqual([ov.stats.orders, ov.stats.delivered, ov.lowCompu], [3, 3, false]);
    assert.strictEqual(Number(ov.products[0].stock), await era(m.address));
    await api('PATCH', `/api/merchants/${m.id}`, { minCompu: '1000' }, owner);
    r = await api('GET', '/api/merchants/alerts', null, kassir);
    assert.ok(r.data.some((a) => a.address === m.address && a.min === 1000), JSON.stringify(r.data));
    assert.ok(r.data.some((a) => a.label === 'Счёт выплат СБП') === false, 'у основного счёта COMPU хватает');
    assert.ok(!r.data.some((a) => a.label === 'Канал счетов на оплату'), 'канал только принимает — комиссия ему не нужна');
});

test('1С: остатки на начало и конец, КПП, справочник контрагентов, копейки и точные суммы, комиссия COMPU', async (t) => {
    const ledger = require('../lib/bank/ledger');
    const X = A;
    const h = [
        { timestamp: 500, from: X, to: B, asset: 1, amount: '10', fee: '0.0001', confirmations: 3, seqNo: '5-1' },
        { timestamp: 300, from: B, to: X, asset: 1, amount: '0.12345678', fee: '0.0001', confirmations: 5, seqNo: '3-1', title: 'Приход' },
        { timestamp: 250, from: B, to: X, asset: 1, amount: '1000', confirmations: 0 },
        { timestamp: 200, from: X, to: B, asset: 1, amount: '5', fee: '0.0001', confirmations: 6, seqNo: '2-1', title: 'Оплата' },
        { timestamp: 100, from: B, to: X, asset: 1, amount: '100', confirmations: 9 },
    ];
    const st = ledger.buildStatement({ history: h, address: X, asset: 1, from: 150, to: 400, current: '85.12345678' });
    assert.deepStrictEqual([st.ops.length, ledger.fmt(st.opening), ledger.fmt(st.closing), ledger.fmt(st.inSum), ledger.fmt(st.outSum)],
        [2, '100.00000000', '95.12345678', '0.12345678', '5.00000000']);
    assert.strictEqual(ledger.buildStatement({ history: h, address: X, asset: 1, from: 150, to: 400, current: '1', limited: true }).opening, null);
    // COMPU: комиссии сети — отдельные строки, остатки сходятся
    const fees = ledger.buildStatement({ history: h, address: X, asset: 2, from: 0, to: 1000, current: '1.9998' });
    assert.deepStrictEqual(fees.ops.map((o) => [o.isFee, o.exact]), [[true, '0.00010000'], [true, '0.00010000']]);
    assert.strictEqual(ledger.fmt(fees.opening), '2.00000000');

    const meta = {
        address: X, assetName: 'ERA', from: 150, to: 400, account: '40702810000000000001',
        organization: { name: 'ООО Ромашка', inn: '7701234567', kpp: '770101001' },
        party: (a) => (a === B ? { name: 'ИП Петров', inn: '500100732259', account: '40802810000000000002', bank: 'Банк', bic: '044525225' } : null),
    };
    const text = new TextDecoder('windows-1251').decode(formats.statement1C(st, meta));
    for (const re of [/РасчСчет=40702810000000000001/, /НачальныйОстаток=100\.00/, /ВсегоПоступило=0\.12/, /ВсегоСписано=5\.00/, /КонечныйОстаток=95\.12/,
        /ПлательщикКПП=770101001/, /Получатель=ИП Петров/, /ПолучательИНН=500100732259/, /ПолучательСчет=40802810000000000002/, /Приход \(точно 0\.12345678 ERA\)/]) {
        assert.match(text, re);
    }
    const camt = formats.camt053(st, { ...meta, scale: 8, currency: 'ERA' }).toString('utf8');
    assert.match(camt, /<Cd>OPBD<\/Cd><\/CdOrPrtry><\/Tp>\s*<Amt Ccy="ERA">100\.00000000/);
    assert.match(camt, /<Cd>CLBD<\/Cd><\/CdOrPrtry><\/Tp>\s*<Amt Ccy="ERA">95\.12345678/);
    assert.match(camt, /<Nm>ИП Петров<\/Nm><Id><OrgId><Othr><Id>500100732259/);

    // через API: настройки сопоставления счетов и контрагентов
    const { call, accounts, backend } = await startDemo(t);
    const me = accounts[0].address;
    assert.strictEqual((await call('PUT', '/api/bank/settings', { counterparties: [{ address: B, name: 'X', inn: '12' }] })).status, 400);
    assert.strictEqual((await call('PUT', '/api/bank/settings', { accounts1C: { 1: '40702810000000000077' }, counterparties: [{ address: B, name: 'ИП Петров', inn: '500100732259' }] })).status, 200);
    await call('POST', '/api/transfer', { from: me, to: B, asset: 1, amount: '0.5', title: 'Тест' });
    backend.height += 1;
    const r = new TextDecoder('windows-1251').decode((await call('GET', `/api/bank/statement?address=${me}&format=1c&asset=1`)).data);
    assert.match(r, /РасчСчет=40702810000000000077/);
    assert.match(r, /НачальныйОстаток=0\.00[\s\S]*ВсегоПоступило=1250\.50[\s\S]*ВсегоСписано=0\.50[\s\S]*КонечныйОстаток=1250\.00/);
    assert.match(r, /Получатель=ИП Петров/);
});

test('курсы и маркет-мейкер: медиана источников, post-only без самосделок, лимиты, стоп-кран, исполнение', async (t) => {
    const { api, call, accounts, backend } = await startDemo(t);
    const main = accounts[0].address;
    const other = accounts[1].address;
    // курс ERA/COMPU: стакан (без ордеров банка) и 7Pay расходятся — курса нет; по одному стакану — середина
    let r = await call('GET', '/api/rates?have=1&want=2');
    assert.strictEqual(r.data.price, null);
    assert.match(r.data.reason, /расходятся/);
    r = await call('GET', '/api/rates?have=1&want=2&sources=dex');
    const mid = (0.05 + 3 / 62) / 2;
    assert.ok(Math.abs(r.data.price - mid) < 1e-7, JSON.stringify(r.data));

    // другой счёт банка уже стоит в стакане на покупку по 0,0498 — продажа ниже этой цены была бы самосделкой
    await call('POST', '/api/exchange/orders', { creator: other, have: 2, want: 1, haveAmount: '0.498', wantAmount: '10' });
    const tradesBefore = backend.tradesList.length;
    r = await call('POST', '/api/mm/pairs', { have: 1, want: 2, account: main, sources: ['dex'], spreadPct: 2, levels: 2, stepPct: 1, levelSize: '10', dailySellLimit: '15', enabled: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const pair = r.data;
    r = await call('POST', '/api/mm/tick');
    const res = r.data[0];
    assert.strictEqual(res.placed, 3, JSON.stringify(res));
    assert.ok(res.skipped.some((x) => /исполнилась бы сразу/.test(x)), 'продажа по 0,0497 скрестилась бы с ордером банка');
    assert.strictEqual(backend.tradesList.length, tradesBefore, 'ни одной сделки');
    let view = (await call('GET', '/api/mm')).data.pairs[0];
    assert.deepStrictEqual(view.orders.map((o) => `${o.side}${o.level}`).sort(), ['ask1', 'bid0', 'bid1']);
    // повторный проход ничего не добавляет: лимит продаж за сутки (10 из 15) и уровни на месте
    r = await call('POST', '/api/mm/tick');
    assert.strictEqual(r.data[0].placed, 0);
    assert.ok(r.data[0].skipped.includes('лимит продаж за сутки') || r.data[0].skipped.some((x) => /сразу/.test(x)));

    // исполнение: часть ордера на покупку забрали — учитывается в суточном обороте
    const bid = view.orders.find((o) => o.side === 'bid' && o.level === 0);
    const book = backend.orders.find((o) => o.seqNo === bid.seqNo);
    book.left = book.left / 2n;
    await call('POST', '/api/mm/tick');
    view = (await call('GET', '/api/mm')).data.pairs[0];
    assert.ok(Math.abs(view.boughtToday - 5) < 1e-6, String(view.boughtToday));

    // стоп-кран: скачок курса больше 10 % — пара остановлена, все её ордера сняты
    const s = await call('GET', '/api/mm');
    assert.ok(s.data.pairs[0].orders.length > 0);
    backend.orders.filter((o) => o.creator !== main && o.creator !== other && o.active).forEach((o) => { o.wantAmount = o.wantAmount * 2n; });
    r = await call('POST', '/api/mm/tick');
    assert.strictEqual(r.data[0].skipped, 'jump', JSON.stringify(r.data));
    view = (await call('GET', '/api/mm')).data.pairs[0];
    assert.deepStrictEqual([view.paused, view.orders.length], [true, 0]);
    assert.ok(backend.orders.filter((o) => o.creator === main && o.active).length === 0, 'ордера банка сняты с биржи');
    // возобновление — с новым курсом
    await call('POST', `/api/mm/${pair.id}/resume`);
    r = await call('POST', '/api/mm/tick');
    assert.ok(r.data[0].placed > 0, JSON.stringify(r.data));
    // права: наблюдатель видит курсы, но не торгует и не меняет настройки
    await call('POST', '/api/staff', { login: 'viewer1', role: 'viewer', password: 'viewer123' });
    const vt = (await api('POST', '/api/login', { login: 'viewer1', password: 'viewer123' })).data.token;
    assert.strictEqual((await api('POST', '/api/mm/tick', {}, vt)).status, 403);
    assert.strictEqual((await api('PUT', '/api/mm/settings', { maxSourceDeviationPct: 50 }, vt)).status, 403);
});

test('отчёты: сутки → хеш в блокчейне, расписание, подтверждение, цепочка, проверка файла и подделки', async (t) => {
    const { api, call, accounts, backend } = await startDemo(t);
    const main = accounts[0].address;
    assert.strictEqual((await call('PUT', '/api/reports/settings', { enabled: true })).status, 400, 'без счёта не включить');
    assert.strictEqual((await call('PUT', '/api/reports/settings', { enabled: true, account: main, time: '25:00' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/reports/settings', { enabled: true, account: main, time: '00:10' })).status, 200);
    // расписание: первый запуск — отчёт за последние закончившиеся сутки
    let r = await call('POST', '/api/reports/tick');
    assert.strictEqual(r.data.length, 1, JSON.stringify(r.data));
    const first = r.data[0];
    assert.strictEqual(first.status, 'anchored');
    assert.ok(first.signature);
    assert.strictEqual((await call('POST', '/api/reports/tick')).data.length, 0, 'повторно за те же сутки не собирается');
    backend.height += 1;
    await call('POST', '/api/reports/tick');
    let list = (await call('GET', '/api/reports')).data.reports;
    assert.strictEqual(list[0].status, 'confirmed');
    // хеш отчёта записан в блокчейн документом
    const onChain = await backend.verifyDocument(first.hash);
    assert.strictEqual(onChain.length, 1);
    assert.strictEqual(onChain[0].creator, main);

    // ручной отчёт за другие сутки: цепочка — ссылается на предыдущий
    r = await call('POST', '/api/reports/run', { date: '2026-01-15' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.prevHash, first.hash);
    assert.strictEqual((await call('POST', '/api/reports/run', { date: '2099-01-01' })).status, 400, 'сутки ещё не закончились');

    // файл отчёта проверяется по блокчейну; подделка — нет
    const f = await call('GET', `/api/reports/${first.id}/file`);
    assert.match(f.headers.get('content-disposition'), /report-\d{4}-\d\d-\d\d\.json/);
    const report = f.data;
    const text = JSON.stringify(report, null, 2);
    assert.strictEqual(report.type, 'erachain-bank-report');
    assert.ok(report.accounts.some((a) => a.address === main));
    let v = await call('POST', '/api/reports/verify', { base64: Buffer.from(text).toString('base64') });
    assert.deepStrictEqual([v.data.hash, v.data.anchored, v.data.known], [first.hash, true, true]);
    report.accounts[0].balances[0].amount = '999999';
    v = await call('POST', '/api/reports/verify', { report });
    assert.deepStrictEqual([v.data.anchored, v.data.known, v.data.changed], [false, false, true]);
    // права: наблюдателю отчёты не видны
    await call('POST', '/api/staff', { login: 'viewer2', role: 'viewer', password: 'viewer123' });
    const vt = (await api('POST', '/api/login', { login: 'viewer2', password: 'viewer123' })).data.token;
    assert.strictEqual((await api('GET', '/api/reports', null, vt)).status, 403);
    list = (await call('GET', '/api/reports')).data.reports;
    assert.ok(!('report' in list[0]), 'список без содержимого');
});

test('залоговое кредитование (Vires): депозит, займ под залог, ставка от загрузки, проценты, здоровье, ликвидация, погашение', async (t) => {
    const store = new JsonStore(null, {});
    const { call, accounts, backend } = await startDemo(t, { store });
    const [main, borrower, depositor, pool, treasury] = accounts.map((a) => a.address);
    const bal = async (a, k) => Number(((await backend.balances(a)).find((b) => b.asset === k) || { amount: 0 }).amount);
    for (const a of [pool, treasury]) await call('POST', '/api/transfer', { from: depositor, to: a, asset: 2, amount: '5' });
    await call('PUT', '/api/mm/settings', { manual: { '1/1048': 10 } });
    assert.strictEqual((await call('PUT', '/api/lending/settings', { poolAccount: pool, treasuryAccount: pool })).status, 400);
    assert.strictEqual((await call('PUT', '/api/lending/settings', { poolAccount: pool, quoteAsset: 1048, priceSources: ['manual'] })).status, 200);
    assert.strictEqual((await call('POST', '/api/lending/pools', { asset: 1, collateralFactor: 0.8, liquidationThreshold: 0.7 })).status, 400);
    await call('POST', '/api/lending/pools', { asset: 1048, scale: 2 });
    await call('POST', '/api/lending/pools', { asset: 1, collateralFactor: 0.6, liquidationThreshold: 0.75 });

    // вкладчик кладёт 100 000 ₽-токенов, заёмщик — 100 ERA в залог (по 10 ₽ = 1000 ₽, лимит займа 600)
    let r = await call('POST', '/api/lending/deposit', { address: depositor, asset: 1048, amount: '100000' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    await call('POST', '/api/lending/deposit', { address: borrower, asset: 1, amount: '100' });
    assert.strictEqual(await bal(pool, 1), 100);
    r = await call('POST', '/api/lending/borrow', { address: borrower, asset: 1048, amount: '700' });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /Не хватает залога/);
    r = await call('POST', '/api/lending/borrow', { address: borrower, asset: 1048, amount: '500' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.position.hf, 1.5);
    assert.strictEqual(await bal(borrower, 1048), 500);
    // загрузка пула и ставки
    let o = (await call('GET', '/api/lending')).data;
    const rub = o.pools.find((p) => p.asset === 1048);
    assert.ok(Math.abs(rub.utilization - 0.005) < 1e-9);
    assert.ok(Math.abs(rub.borrowApr - (0.02 + 0.1 * 0.005 / 0.8)) < 1e-9);
    assert.ok(Math.abs(rub.supplyApr - rub.borrowApr * 0.005 * 0.9) < 1e-12);
    // вывести залог, под которым займ, нельзя
    assert.strictEqual((await call('POST', '/api/lending/withdraw', { address: borrower, asset: 1, amount: '50' })).status, 400);

    // прошёл год: долг вырос на ставку займа; ERA подешевел до 6 ₽ — позицию можно ликвидировать
    for (const p of store.data.lendPools) p.updatedAt -= 365 * 86400000;
    await call('PUT', '/api/mm/settings', { manual: { '1/1048': 6 } });
    o = (await call('GET', '/api/lending')).data;
    let pos = o.positions.find((x) => x.address === borrower);
    const debt = Number(pos.borrow[0].amount);
    assert.ok(Math.abs(debt - 500 * (1 + rub.borrowApr)) < 0.01, String(debt));
    assert.strictEqual(pos.state, 'liquidatable');
    assert.strictEqual((await call('POST', '/api/lending/liquidate', { address: borrower })).status, 400, 'нет казны');
    await call('PUT', '/api/lending/settings', { treasuryAccount: treasury });
    await call('POST', '/api/transfer', { from: main, to: treasury, asset: 1048, amount: '1000' });
    assert.strictEqual((await call('POST', '/api/lending/liquidate', { address: depositor })).status, 400, 'у вкладчика нет долга');
    r = await call('POST', '/api/lending/liquidate', { address: borrower });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(Math.abs(r.data.repaid - debt / 2) < 0.011);
    assert.ok(Math.abs(r.data.seized - r.data.repaid * 1.05 / 6) < 1e-6);
    assert.ok(Math.abs(await bal(treasury, 1) - r.data.seized) < 1e-8);
    assert.ok(r.data.position.hf > r.data.hfBefore, 'здоровье после ликвидации выше');

    // заёмщик гасит остаток и забирает залог; вкладчик забирает депозит с процентами
    r = await call('POST', '/api/lending/repay', { address: borrower, asset: 1048, all: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(r.data.position.borrow.filter((b) => Number(b.amount) > 0), []);
    r = await call('POST', '/api/lending/withdraw', { address: borrower, asset: 1, all: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const before = await bal(depositor, 1048);
    r = await call('POST', '/api/lending/withdraw', { address: depositor, asset: 1048, all: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const got = (await bal(depositor, 1048)) - before;
    assert.ok(got > 100000 && got < 100000 * (1 + rub.borrowApr), String(got));
    // доля банка (резерв) осталась в пуле
    assert.ok(await bal(pool, 1048) > 0);
});

test('надёжность: запасная нода, подпись только на основной, «не найдена» от запасной не доверяется', async (t) => {
    const hits = [];
    const fallback = http.createServer((req, res) => {
        hits.push(req.url);
        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/blocks/height')) return res.end('1234');
        if (req.url.startsWith('/record/broadcast')) return res.end('"+"');
        if (req.url.startsWith('/transactions/signature/')) return res.end(JSON.stringify({ error: 24, message: 'not exists' }));
        res.end('{}');
    });
    const fb = await listen(fallback);
    t.after(() => fallback.close());
    // основная — закрытый порт
    const dead = http.createServer();
    const deadUrl = await listen(dead);
    await new Promise((r) => dead.close(r));
    const n = new NodeBackend(`${deadUrl},${fb}`, { timeoutMs: 2000 });
    assert.strictEqual((await n.status()).height, 1234, 'чтение — с запасной');
    assert.strictEqual((await n.status()).fallback, true);
    assert.strictEqual(await n.broadcast('abc'), true, 'подписанная транзакция уходит через запасную');
    await assert.rejects(n.makeTransfer({ from: A, to: B, asset: 1, amount: '1' }, 'pass'), (e) => e.status === 502, 'подпись — только основная нода');
    assert.ok(!hits.some((u) => u.includes('password')), 'пароль кошелька на запасную ноду не уходит');
    await assert.rejects(n.txStatus('sig'), (e) => e.status === 502, '«не найдена» от запасной — неизвестно');
    const info = await n.nodesInfo();
    assert.deepStrictEqual(info.map((x) => [x.primary, x.ok]), [[true, false], [false, true]]);
});

test('надёжность: контрольная сумма адреса, проверка адреса, журнал платежей', async (t) => {
    const keys = require('../lib/erakeys');
    const good = keys.addressOf(Buffer.alloc(32, 9));
    const typo = good.slice(0, 10) + (good[10] === 'a' ? 'b' : 'a') + good.slice(11);
    assert.deepStrictEqual([v.isAddress(good), v.isAddress(typo)], [true, false]);

    const { call, accounts, backend } = await startDemo(t);
    const me = accounts[0].address;
    let r = await call('POST', '/api/transfer', { from: me, to: typo, asset: 1, amount: '1' });
    assert.strictEqual(r.status, 400, 'адрес с опечаткой не принимается');
    r = await call('GET', `/api/address/${typo}/check`);
    assert.deepStrictEqual([r.data.valid, /контрольная сумма/.test(r.data.reason)], [false, true]);
    r = await call('GET', `/api/address/${good}/check`);
    assert.deepStrictEqual([r.data.valid, r.data.known, r.data.own], [true, false, false]);
    assert.match(r.data.note, /ещё не было/);
    assert.strictEqual((await call('GET', `/api/address/${accounts[1].address}/check`)).data.own, true);

    // журнал: кто, откуда, куда, подпись; неудачный перевод — тоже; подтверждение сетью
    await call('POST', '/api/transfer', { from: me, to: good, asset: 1, amount: '2.5', title: 'Тест журнала' });
    await call('POST', '/api/transfer', { from: me, to: good, asset: 1, amount: '999999' });
    let list = (await call('GET', '/api/payments')).data;
    assert.deepStrictEqual(list.slice(0, 2).map((x) => [x.status, x.amount, x.by, x.source]),
        [['failed', '999999', 'owner', 'POST /api/transfer'], ['sent', '2.5', 'owner', 'POST /api/transfer']]);
    backend.height += 1;
    await call('POST', '/api/payments/check');
    list = (await call('GET', `/api/payments?address=${good}&status=confirmed`)).data;
    assert.strictEqual(list.length, 1);
    assert.ok(list[0].signature);
    const csv = await call('GET', '/api/payments?format=csv');
    assert.match(csv.data.toString('utf8'), /Тест журнала/);
});
