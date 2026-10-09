'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp } = require('../server');
const { DemoBackend, toUnits, fromUnits } = require('../lib/demoBackend');
const { NodeBackend } = require('../lib/nodeBackend');
const { validateTransfer } = require('../lib/validate');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function call(base, method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
}

test('конвертация сумм без потери точности', () => {
    assert.strictEqual(toUnits('1.5'), 150000000n);
    assert.strictEqual(fromUnits(toUnits('0.00000001')), '0.00000001');
    assert.strictEqual(fromUnits(toUnits('1250.5') - toUnits('0.1')), '1250.40000000');
});

test('валидация перевода', () => {
    const a = '7' + 'A'.repeat(33);
    const b = '7' + 'B'.repeat(33);
    assert.strictEqual(validateTransfer({ from: a, to: b, asset: 1, amount: '1,5' }).amount, '1.5');
    assert.throws(() => validateTransfer({ from: a, to: a, asset: 1, amount: '1' }), /тот же/);
    assert.throws(() => validateTransfer({ from: a, to: b, asset: 1, amount: '0' }), /сумма/);
    assert.throws(() => validateTransfer({ from: a, to: b, asset: 1, amount: '1.123456789' }), /сумма/);
    assert.throws(() => validateTransfer({ from: a, to: 'xyz', asset: 1, amount: '1' }), /получателя/);
});

test('демо: вход, счета, перевод, история', async (t) => {
    const server = createApp(new DemoBackend());
    const base = await listen(server);
    t.after(() => server.close());

    assert.strictEqual((await call(base, 'GET', '/api/accounts')).status, 401);
    assert.strictEqual((await call(base, 'POST', '/api/login', { password: 'wrong' })).status, 401);

    const { data: { token } } = await call(base, 'POST', '/api/login', { password: 'demo12345' });
    assert.ok(token);

    const { data: accounts } = await call(base, 'GET', '/api/accounts', null, token);
    assert.strictEqual(accounts.length, 2);
    const [a, b] = accounts;

    const tr = await call(base, 'POST', '/api/transfer', { from: a.address, to: b.address, asset: 1, amount: '100.25', title: 'Тест' }, token);
    assert.strictEqual(tr.status, 200, JSON.stringify(tr.data));

    const { data: after } = await call(base, 'GET', '/api/accounts', null, token);
    const bal = (acc, k) => acc.balances.find((x) => x.asset === k).amount;
    assert.strictEqual(bal(after[0], 1), '1150.25000000');
    assert.strictEqual(bal(after[0], 2), '9.99990000');
    assert.strictEqual(bal(after[1], 1), '400.25000000');

    const tooMuch = await call(base, 'POST', '/api/transfer', { from: a.address, to: b.address, asset: 1, amount: '999999' }, token);
    assert.strictEqual(tooMuch.status, 400);
    assert.match(tooMuch.data.error, /Недостаточно/);

    const { data: hist } = await call(base, 'GET', `/api/accounts/${b.address}/history`, null, token);
    assert.strictEqual(hist[0].direction, 'in');
    assert.strictEqual(hist[0].title, 'Тест');

    const { data: opened } = await call(base, 'POST', '/api/accounts', null, token);
    assert.match(opened.address, /^7/);

    await call(base, 'POST', '/api/logout', null, token);
    assert.strictEqual((await call(base, 'GET', '/api/accounts', null, token)).status, 401);
});

test('статика: index и защита от выхода из каталога', async (t) => {
    const server = createApp(new DemoBackend());
    const base = await listen(server);
    t.after(() => server.close());
    const res = await fetch(base + '/');
    assert.match(await res.text(), /Банк Erachain/);
    assert.notStrictEqual((await fetch(base + '/..%2Fserver.js')).status, 200);
});

test('NodeBackend: обращается к RPC ноды и разбирает ответы', async (t) => {
    const A = '7' + 'A'.repeat(33);
    const B = '7' + 'B'.repeat(33);
    const seen = [];
    const node = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        seen.push(url.pathname + url.search);
        const reply = (body) => res.end(typeof body === 'string' ? body : JSON.stringify(body));
        if (url.pathname === '/wallet') return reply({ exists: true, isunlocked: false });
        if (url.pathname === '/blocks/height') return reply('12345');
        if (url.pathname === '/addresses') {
            return url.searchParams.get('password') === 'secret123' ? reply([A]) : reply({ error: 1, message: 'wallet locked' });
        }
        if (url.pathname === `/addresses/assets/${A}`) return reply({ 1: [['10', '7.5'], ['0', '0'], ['0', '0'], ['0', '0'], ['0', '0']] });
        if (url.pathname === '/assets/1') return reply({ name: 'ERA', scale: 8 });
        if (url.pathname.startsWith(`/r_send/${A}/${B}`)) {
            return reply({ signature: 'sig', type_name: 'Send', creator: A, recipient: B, assetKey: 1, amount: '1.5', confirmations: 0, timestamp: 1 });
        }
        res.statusCode = 404;
        reply({ error: 'not found' });
    });
    const rpc = await listen(node);
    t.after(() => node.close());

    const backend = new NodeBackend(rpc);
    assert.deepStrictEqual(await backend.status(), { mode: 'node', node: rpc, height: 12345, walletExists: true, walletUnlocked: false });
    await assert.rejects(backend.login('bad-password'), /wallet locked/);

    const accounts = await backend.accounts('secret123');
    assert.deepStrictEqual(accounts, [{ address: A, balances: [{ asset: 1, name: 'ERA', amount: '7.5' }] }]);

    const tx = await backend.transfer({ from: A, to: B, asset: 1, amount: '1.5', title: 'x', message: '' }, 'secret123');
    assert.strictEqual(tx.direction, 'out');
    const send = seen.find((s) => s.startsWith('/r_send'));
    assert.match(send, /assetKey=1/);
    assert.match(send, /amount=1.5/);
    assert.match(send, /password=secret123/);
});
