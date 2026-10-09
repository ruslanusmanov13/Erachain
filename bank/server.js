'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NodeBackend } = require('./lib/nodeBackend');
const { DemoBackend } = require('./lib/demoBackend');
const { isAddress, validateTransfer, BankError } = require('./lib/validate');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 15 * 60 * 1000;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

function createApp(backend) {
    // token -> { password, expires }; пароль кошелька хранится только в памяти сервера
    const sessions = new Map();

    function openSession(password) {
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, { password, expires: Date.now() + SESSION_TTL_MS });
        return token;
    }

    function requireSession(req) {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const s = sessions.get(token);
        if (!s || s.expires < Date.now()) {
            sessions.delete(token);
            throw new BankError('Сессия истекла, войдите снова', 401);
        }
        s.expires = Date.now() + SESSION_TTL_MS;
        return { token, password: s.password };
    }

    async function readJson(req) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 64 * 1024) throw new BankError('Слишком большой запрос', 413);
            chunks.push(chunk);
        }
        if (!chunks.length) return {};
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
            throw new BankError('Некорректный JSON');
        }
    }

    async function api(req, res, url) {
        const route = req.method + ' ' + url.pathname;

        if (route === 'GET /api/status') return backend.status();

        if (route === 'POST /api/login') {
            const { password } = await readJson(req);
            if (typeof password !== 'string' || !password) throw new BankError('Введите пароль кошелька');
            await backend.login(password);
            return { token: openSession(password) };
        }

        const session = requireSession(req);

        if (route === 'POST /api/logout') {
            sessions.delete(session.token);
            return { ok: true };
        }
        if (route === 'GET /api/accounts') return backend.accounts(session.password);
        if (route === 'POST /api/accounts') return backend.openAccount(session.password);

        const hist = url.pathname.match(/^\/api\/accounts\/([^/]+)\/history$/);
        if (req.method === 'GET' && hist) {
            const address = decodeURIComponent(hist[1]);
            if (!isAddress(address)) throw new BankError('Неверный адрес');
            const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 50, 1), 200);
            return backend.history(address, limit);
        }

        if (route === 'POST /api/transfer') {
            const transfer = validateTransfer(await readJson(req));
            return backend.transfer(transfer, session.password);
        }

        throw new BankError('Метод не найден', 404);
    }

    function serveStatic(req, res, url) {
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const file = path.normalize(path.join(PUBLIC_DIR, rel));
        if (!file.startsWith(PUBLIC_DIR + path.sep)) {
            res.writeHead(403).end();
            return;
        }
        fs.readFile(file, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff',
            }).end(data);
        });
    }

    return http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith('/api/')) {
            serveStatic(req, res, url);
            return;
        }
        let status = 200;
        let body;
        try {
            body = await api(req, res, url);
        } catch (e) {
            status = e instanceof BankError ? e.status : 500;
            body = { error: e instanceof BankError ? e.message : 'Внутренняя ошибка сервера' };
            if (!(e instanceof BankError)) console.error(e);
        }
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    });
}

if (require.main === module) {
    const demo = process.argv.includes('--demo') || process.env.BANK_DEMO === '1';
    const port = Number(process.env.PORT || 8080);
    const host = process.env.HOST || '127.0.0.1';
    const rpc = process.env.ERA_RPC || 'http://127.0.0.1:9048';
    const backend = demo ? new DemoBackend() : new NodeBackend(rpc);
    createApp(backend).listen(port, host, () => {
        console.log(`Банк Erachain: http://${host}:${port}`);
        console.log(demo ? 'Демо-режим, пароль кошелька: demo12345' : 'RPC ноды: ' + rpc);
    });
}

module.exports = { createApp };
