'use strict';

const { BankError, text } = require('./validate');

/**
 * Подключение банка к приёму платежей СБП через «Точку» прямо из админки (по era-polza-sbp):
 *   1) клиент «Точки» по коду клиента (customerCode) и БИК банка;
 *   2) регистрация юрлица в СБП → legalId;
 *   3) счёт для зачисления оплат;
 *   4) регистрация торговой точки (ТСП) → merchantId;
 *   5) включение: реквизиты (merchantId, счёт, БИК) применяются к приёму платежей.
 * Токен API «Точки» — только в переменной окружения TOCHKA_SBP_TOKEN, в данных не хранится.
 */

const MCC_RE = /^\d{4}$/;

class SbpOnboarding {
    constructor(client, store) {
        this.client = client;
        this.store = store;
        store.data.sbpOnboarding = store.data.sbpOnboarding || { step: 'customer', log: [] };
        // реквизиты из админки действуют и после перезапуска
        const t = store.data.sbpSettings && store.data.sbpSettings.tochka;
        if (t && client.configure) client.configure(t);
    }

    state() {
        return this.store.data.sbpOnboarding;
    }

    note(text1) {
        const s = this.state();
        s.log = [{ at: Date.now(), text: text1 }, ...(s.log || [])].slice(0, 50);
        this.store.save();
    }

    async customer(body) {
        const customerCode = text(String(body.customerCode ?? ''), 20);
        const bankCode = text(String(body.bankCode ?? '044525104'), 9);
        if (!/^\d{9}$/.test(bankCode)) throw new BankError('БИК банка — 9 цифр');
        if (!/^\d{6,12}$/.test(customerCode)) throw new BankError('Код клиента «Точки» — цифры (из интернет-банка или API open-banking)');
        const info = await this.client.customerInfo(customerCode, bankCode);
        Object.assign(this.state(), {
            customerCode, bankCode, customer: { name: info.fullName || info.shortName || '', inn: info.taxCode || '', type: info.customerType || '' },
            legalId: info.legalId || this.state().legalId || null, step: info.legalId ? 'account' : 'legal',
        });
        this.note(`Клиент найден: ${this.state().customer.name}`);
        return this.state();
    }

    async registerLegal() {
        const s = this.state();
        if (!s.customerCode) throw new BankError('Сначала найдите клиента «Точки»');
        if (!s.legalId) {
            const r = await this.client.registerLegalEntity(s.customerCode, s.bankCode);
            if (!r.legalId) throw new BankError('«Точка» не вернула legalId');
            s.legalId = r.legalId;
            this.note('Юрлицо зарегистрировано в СБП: ' + s.legalId);
        }
        const le = await this.client.legalEntity(s.legalId).catch(() => ({}));
        if (le.status && le.status !== 'Active') {
            await this.client.setLegalEntityStatus(s.legalId, 'Active');
            this.note('Юрлицо в СБП включено');
        }
        s.step = 'account';
        s.accounts = await this.client.accounts(s.legalId);
        this.store.save();
        return s;
    }

    async chooseAccount(body) {
        const s = this.state();
        if (!s.legalId) throw new BankError('Сначала зарегистрируйте юрлицо в СБП');
        const list = s.accounts && s.accounts.length ? s.accounts : await this.client.accounts(s.legalId);
        const acc = list.find((a) => a.accountCode === body.accountCode);
        if (!acc) throw new BankError('Выберите счёт из списка «Точки»');
        if (acc.status && acc.status !== 'Active') await this.client.setAccountStatus(s.legalId, acc.accountCode, 'Active');
        Object.assign(s, { account: acc.accountCode, bik: acc.bankCode || s.bankCode, step: 'merchant' });
        this.note('Счёт для зачисления: ' + acc.accountCode);
        return s;
    }

    async registerMerchant(body) {
        const s = this.state();
        if (!s.account) throw new BankError('Сначала выберите счёт');
        const m = {
            brandName: text(body.brandName, 100), address: text(body.address, 160), city: text(body.city, 60),
            countryCode: 'RU', countrySubDivisionCode: text(String(body.region ?? ''), 2), zipCode: text(String(body.zipCode ?? ''), 6),
            mcc: text(String(body.mcc ?? ''), 4), contactPhoneNumber: text(String(body.phone ?? ''), 16).replace(/[^\d+]/g, ''),
            capabilities: '011', // статические и динамические QR, без платёжных ссылок подписки
            additionalContacts: [],
        };
        if (!m.brandName) throw new BankError('Название торговой точки (так его увидит плательщик)');
        if (!m.address || !m.city) throw new BankError('Адрес и город торговой точки');
        if (!/^\d{2}$/.test(m.countrySubDivisionCode)) throw new BankError('Код региона — 2 цифры (например, 45 — Москва по ОКАТО)');
        if (!/^\d{6}$/.test(m.zipCode)) throw new BankError('Индекс — 6 цифр');
        if (!MCC_RE.test(m.mcc)) throw new BankError('MCC — 4 цифры (вид деятельности, например 6012 — финансовые услуги)');
        if (!/^\+?7\d{10}$/.test(m.contactPhoneNumber)) throw new BankError('Телефон в формате +7XXXXXXXXXX');
        const r = await this.client.registerMerchant(s.legalId, m);
        if (!r.merchantId) throw new BankError('«Точка» не вернула merchantId');
        Object.assign(s, { merchantId: r.merchantId, merchant: m, step: 'activate' });
        this.note('ТСП зарегистрирована: ' + r.merchantId);
        return s;
    }

    async merchants() {
        const s = this.state();
        if (!s.legalId) return [];
        return this.client.merchants(s.legalId);
    }

    // выбрать уже существующую ТСП вместо регистрации новой
    async useMerchant(body) {
        const s = this.state();
        const list = await this.merchants();
        const m = list.find((x) => x.merchantId === body.merchantId);
        if (!m) throw new BankError('ТСП не найдена у этого юрлица');
        Object.assign(s, { merchantId: m.merchantId, step: 'activate' });
        this.note('Выбрана ТСП ' + m.merchantId);
        return s;
    }

    /** Включить: ТСП активна, реквизиты приёма платежей — из мастера. */
    async activate() {
        const s = this.state();
        if (!s.merchantId || !s.account) throw new BankError('Пройдите шаги: юрлицо, счёт, ТСП');
        await this.client.setMerchantStatus(s.merchantId, 'Active');
        const tochka = { merchantId: s.merchantId, account: s.account, bik: s.bik || s.bankCode };
        this.store.data.sbpSettings = { ...(this.store.data.sbpSettings || {}), tochka };
        if (this.client.configure) this.client.configure(tochka);
        Object.assign(s, { step: 'done', activatedAt: Date.now() });
        this.note('Приём платежей включён: ТСП ' + s.merchantId);
        return s;
    }

    async suspend() {
        const s = this.state();
        if (!s.merchantId) throw new BankError('ТСП не подключена');
        await this.client.setMerchantStatus(s.merchantId, 'Suspended');
        s.step = 'activate';
        this.note('ТСП приостановлена');
        return s;
    }

    reset() {
        this.store.data.sbpOnboarding = { step: 'customer', log: [{ at: Date.now(), text: 'Мастер начат заново' }] };
        this.store.save();
        return this.state();
    }
}

module.exports = { SbpOnboarding };
