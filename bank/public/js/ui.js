// Общие элементы интерфейса: построение DOM, форматирование, диалоги, уведомления.

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'value') node.value = v;
        else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : String(c));
    }
    return node;
}

export function fmt(amount, max = 8) {
    const n = Number(amount);
    if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) return '—';
    return n.toLocaleString('ru-RU', { minimumFractionDigits: Math.min(2, max), maximumFractionDigits: max });
}

export function short(address) {
    return address ? address.slice(0, 6) + '…' + address.slice(-5) : '—';
}

export function date(ts) {
    return ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

export function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 3800);
}

export function card(...children) {
    return el('section', { class: 'card' }, ...children);
}

export function sectionTitle(text) {
    return el('h3', { class: 'section-title' }, text);
}

export function empty(text) {
    return el('div', { class: 'empty' }, text);
}

export function spinner() {
    return el('div', { class: 'spinner' }, 'Загрузка…');
}

export function field(label, input, hint) {
    return el('label', {}, label, input, hint ? el('span', { class: 'tiny muted' }, hint) : null);
}

export function input(name, attrs = {}) {
    return el('input', { name, autocomplete: 'off', ...attrs });
}

export function select(name, options, value) {
    const s = el('select', { name });
    for (const o of options) {
        const opt = el('option', { value: String(o.value) }, o.label);
        if (String(o.value) === String(value)) opt.selected = true;
        s.append(opt);
    }
    return s;
}

export function badge(text, kind = '') {
    return el('span', { class: 'badge ' + kind }, text);
}

export function kv(pairs) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of pairs) {
        if (v === undefined || v === null || v === '') continue;
        dl.append(el('dt', {}, k), el('dd', {}, v));
    }
    return dl;
}

export function tabs(items, active, onChange) {
    const bar = el('div', { class: 'tabs', role: 'tablist' });
    for (const [key, label] of items) {
        const b = el('button', { class: 'tab' + (key === active ? ' active' : ''), type: 'button', role: 'tab' }, label);
        b.addEventListener('click', () => {
            for (const x of bar.children) x.classList.toggle('active', x === b);
            onChange(key);
        });
        bar.append(b);
    }
    return bar;
}

// Форма с кнопкой отправки, блокировкой на время запроса и выводом ошибки
export function form(children, submitLabel, onSubmit, { confirm: confirmText } = {}) {
    const error = el('p', { class: 'error' });
    const button = el('button', { class: 'btn primary block', type: 'submit' }, submitLabel);
    const f = el('form', { class: 'stack', novalidate: true }, ...children, error, button);
    f.addEventListener('submit', async (e) => {
        e.preventDefault();
        error.textContent = '';
        const data = Object.fromEntries(new FormData(f).entries());
        if (confirmText) {
            const text = typeof confirmText === 'function' ? confirmText(data) : confirmText;
            if (text && !(await confirm(text))) return;
        }
        button.disabled = true;
        try {
            await onSubmit(data, f);
        } catch (err) {
            error.textContent = err.message;
        } finally {
            button.disabled = false;
        }
    });
    return f;
}

// Диалоги

export function openDialog(...children) {
    const dialog = $('dialog');
    const body = $('dialogBody');
    body.replaceChildren(...children);
    if (!dialog.open) dialog.showModal();
    return dialog;
}

export function closeDialog() {
    const dialog = $('dialog');
    if (dialog.open) dialog.close();
}

export function confirm(text, okLabel = 'Подтвердить') {
    return new Promise((resolve) => {
        const dialog = $('dialog');
        let result = false;
        const done = () => resolve(result);
        dialog.addEventListener('close', done, { once: true });
        openDialog(
            el('h3', {}, 'Подтверждение'),
            el('p', { class: 'pre-line' }, text),
            el('div', { class: 'row end' },
                el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Отмена'),
                el('button', { class: 'btn primary', type: 'button', onclick: () => { result = true; dialog.close(); } }, okLabel)),
        );
    });
}

export async function copy(text, done = 'Скопировано') {
    try {
        await navigator.clipboard.writeText(text);
        toast(done);
    } catch (e) {
        openDialog(el('h3', {}, 'Скопируйте вручную'), el('p', { class: 'mono' }, text),
            el('button', { class: 'btn', onclick: closeDialog }, 'Закрыть'));
    }
}

export async function share(text, title) {
    const plugins = window.Capacitor && window.Capacitor.Plugins;
    try {
        if (plugins && plugins.Share) return await plugins.Share.share({ title, text });
        if (navigator.share) return await navigator.share({ title, text });
    } catch (e) {
        return null;
    }
    return copy(text);
}

// Выбор файла и чтение как base64
export function pickFile(accept) {
    return new Promise((resolve) => {
        const i = el('input', { type: 'file', accept, class: 'hidden' });
        i.addEventListener('change', () => {
            resolve(i.files[0] || null);
            i.remove();
        });
        document.body.append(i);
        i.click();
    });
}

export async function fileToBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

// Фото для персоны: уменьшаем и сжимаем в JPEG 10–30 КБ (требование сети Erachain)
export async function photoToBase64(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('Не удалось открыть изображение'));
            i.src = url;
        });
        let size = 360;
        for (let attempt = 0; attempt < 12; attempt++) {
            const scale = Math.min(1, size / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * scale);
            c.height = Math.round(img.height * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            for (const q of [0.92, 0.85, 0.75, 0.65, 0.55, 0.45]) {
                const data = c.toDataURL('image/jpeg', q).split(',')[1];
                const bytes = data.length * 3 / 4;
                if (bytes >= 10240 && bytes <= 30720) return data;
                if (bytes < 10240) break; // слишком мало — увеличим размер
            }
            const probe = c.toDataURL('image/jpeg', 0.45).length * 3 / 4;
            size = probe > 30720 ? Math.round(size * 0.8) : Math.round(size * 1.3);
        }
        throw new Error('Не удалось сжать фото до 10–30 КБ, выберите другое изображение');
    } finally {
        URL.revokeObjectURL(url);
    }
}

// QR-код (SVG) для адреса или платёжной ссылки — можно отсканировать другим кошельком
export async function qrCode(text, size = 220) {
    const { default: qrcode } = await import('./vendor/qrcode.js');
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `-2 -2 ${n + 4} ${n + 4}`);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('class', 'qr');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR-код: ' + text);
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', '-2'); bg.setAttribute('y', '-2'); bg.setAttribute('width', String(n + 4)); bg.setAttribute('height', String(n + 4));
    bg.setAttribute('fill', '#ffffff');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000000');
    svg.append(bg, path);
    return svg;
}
