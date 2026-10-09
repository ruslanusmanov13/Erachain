'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Простое хранилище в JSON-файле: запись через временный файл и переименование,
 * чтобы файл не повредился при сбое. Для одного сервера банка этого достаточно.
 */
class JsonStore {
    constructor(file, defaults) {
        this.file = file;
        this.data = structuredClone(defaults);
        if (file && fs.existsSync(file)) {
            this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
        }
    }

    save() {
        if (!this.file) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }
}

module.exports = { JsonStore };
