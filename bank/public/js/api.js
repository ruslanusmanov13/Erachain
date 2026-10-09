// Клиент API сервера банка. В браузере сервер — тот же origin; в Android-приложении
// адрес сервера задаётся в настройках (запросы идут через нативный HTTP Capacitor).

const store = {
    get(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
        try {
            if (value === null || value === undefined) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch (e) { /* хранилище недоступно */ }
    },
};

export const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

export const session = {
    token: (() => { try { return sessionStorage.getItem('bankToken'); } catch (e) { return null; } })(),
    setToken(token) {
        this.token = token;
        try {
            if (token) sessionStorage.setItem('bankToken', token);
            else sessionStorage.removeItem('bankToken');
        } catch (e) { /* ignore */ }
    },
};

export function serverUrl() {
    return (store.get('serverUrl') || '').replace(/\/+$/, '');
}

export function setServerUrl(url) {
    store.set('serverUrl', url ? url.replace(/\/+$/, '') : null);
}

export function needsServer() {
    return isNative() && !serverUrl();
}

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
    onUnauthorized = fn;
}

export async function api(method, path, body, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (session.token) headers.Authorization = 'Bearer ' + session.token;
    const base = isNative() ? serverUrl() : '';
    let res;
    try {
        res = await fetch(base + '/api/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
        throw new ApiError(isNative() ? `Сервер банка недоступен (${base || 'адрес не задан'})` : 'Нет связи с сервером банка', 0);
    }
    const data = await res.json().catch(() => ({ error: 'Некорректный ответ сервера (HTTP ' + res.status + ')' }));
    if (res.status === 401 && path !== 'login') {
        session.setToken(null);
        onUnauthorized();
    }
    if (!res.ok || (data && data.error)) throw new ApiError((data && data.error) || 'HTTP ' + res.status, res.status);
    return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const put = (path, body) => api('PUT', path, body);
export const patch = (path, body) => api('PATCH', path, body);

// Скачивание файла (выписки, платёжные поручения): сервер отдаёт base64 в JSON
export async function download(method, path, body) {
    const f = await api(method, path, body, { 'X-File-As': 'json' });
    await saveFile(f.filename, f.base64, f.mime);
    return f.filename;
}

export async function saveFile(filename, base64, mime) {
    // встраивающая страница (например, демо) может показать файл вместо скачивания
    if (typeof window.bankSaveFileHook === 'function') return window.bankSaveFileHook(filename, base64, mime);
    const plugins = window.Capacitor && window.Capacitor.Plugins;
    if (isNative() && plugins && plugins.Filesystem && plugins.Share) {
        // Android: сохраняем во временную папку и открываем «Поделиться» (почта, 1С, диск, мессенджеры)
        const written = await plugins.Filesystem.writeFile({ path: filename, data: base64, directory: 'CACHE' });
        await plugins.Share.share({ title: filename, url: written.uri, dialogTitle: 'Сохранить или отправить файл' });
        return;
    }
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
