/**
 * Store - Persistent Local Storage & Supabase Cloud Sync (With Debts & Loans)
 */
import {
  getCurrentSessionUser,
  fetchCloudData,
  pushTransactionToCloud,
  deleteTransactionInCloud,
  pushDebtToCloud,
  updateDebtInCloud,
  pushAccountToCloud,
  updateAccountBalanceInCloud,
  deleteAccountInCloud,
  setupRealtimeSync
} from './supabase.js';

const STORAGE_KEY = 'billetera_voz_minimal_v2';

const DEFAULT_ACCOUNTS = [
  { id: 'interbank', code: 'IBK', name: 'Interbank', type: 'Banco', balance: 0.00, currency: 'PEN', isDefault: true }
];

const DEFAULT_CATEGORIES = [
  { id: 'comida', name: 'Alimentación', code: 'AL' },
  { id: 'transporte', name: 'Transporte', code: 'TR' },
  { id: 'compras', name: 'Compras', code: 'CO' },
  { id: 'servicios', name: 'Servicios', code: 'SE' },
  { id: 'salud', name: 'Salud', code: 'SA' },
  { id: 'ocio', name: 'Entretenimiento', code: 'EN' },
  { id: 'educacion', name: 'Educación', code: 'ED' },
  { id: 'sueldo', name: 'Sueldo', code: 'SU' },
  { id: 'negocio', name: 'Ventas y Negocio', code: 'VE' },
  { id: 'deudas', name: 'Préstamos y Deudas', code: 'DE' },
  { id: 'transferencia', name: 'Transferencia', code: 'TF' },
  { id: 'otros', name: 'Otros Gastos', code: 'OT' }
];

const INITIAL_TRANSACTIONS = [];

const DEFAULT_DEBTS = [];

class Store {
  constructor() {
    this.data = {
      accounts: DEFAULT_ACCOUNTS,
      transactions: INITIAL_TRANSACTIONS,
      categories: DEFAULT_CATEGORIES,
      debts: DEFAULT_DEBTS,
      settings: {
        groqApiKey: '',
        selectedModel: 'openai/gpt-oss-20b',
        availableModels: [],
        audioMode: 'whisper',
        defaultCurrency: 'PEN',
        hideBalances: false
      }
    };
    this.listeners = [];
    this.init();
    this.initCloudSync();
  }

  init() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const settings = { ...this.data.settings, ...(parsed.settings || {}) };
        
        // Migrate away from decommissioned or retired models
        const decommissioned = [
          'mixtral-8x7b-32768', 
          'llama3-8b-8192', 
          'llama3-70b-8192', 
          'gemma-7b-it', 
          'gemma2-9b-it',
          'deepseek-r1-distill-llama-70b'
        ];
        if (!settings.selectedModel || decommissioned.includes(settings.selectedModel)) {
          settings.selectedModel = 'openai/gpt-oss-20b';
        }

        // Clean start reset migration: wipe old demo data and reset Interbank balance to 0.00
        let loadedAccounts = parsed.accounts || DEFAULT_ACCOUNTS;
        let loadedTx = parsed.transactions || [];
        let loadedDebts = parsed.debts || [];

        if (!parsed._cleanZeroStartMigrated) {
          loadedTx = [];
          loadedDebts = [];
          loadedAccounts = [
            { id: 'interbank', code: 'IBK', name: 'Interbank', type: 'Banco', balance: 0.00, currency: 'PEN', isDefault: true }
          ];
        }

        // Ensure at least one account is marked isDefault
        if (!loadedAccounts.some(a => a.isDefault)) {
          const ibk = loadedAccounts.find(a => a.id === 'interbank') || loadedAccounts[0];
          if (ibk) ibk.isDefault = true;
        }

        this.data = {
          accounts: loadedAccounts,
          transactions: loadedTx,
          categories: parsed.categories || DEFAULT_CATEGORIES,
          debts: loadedDebts,
          settings,
          _interbankOnlyMigrated: true,
          _cleanZeroStartMigrated: true
        };
        this.save();
      } else {
        this.save();
      }
    } catch (e) {
      console.error('Error loading data from localStorage:', e);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      this.notify();
    } catch (e) {
      console.error('Error saving data to localStorage:', e);
    }
  }

  async initCloudSync() {
    try {
      await this.syncFromCloud();
      setupRealtimeSync(() => {
        this.syncFromCloud();
      });
    } catch (e) {
      console.warn('Sync inicial con Supabase omitido:', e);
    }
  }

  async syncFromCloud() {
    try {
      const cloud = await fetchCloudData();
      if (!cloud) return;

      if (cloud.accounts && cloud.accounts.length > 0) {
        this.data.accounts = cloud.accounts;
      }
      if (cloud.transactions) {
        this.data.transactions = cloud.transactions;
      }
      if (cloud.debts) {
        this.data.debts = cloud.debts;
      }
      this.save();
      this.notify();
    } catch (e) {
      console.warn('Error sincronizando con la nube:', e);
    }
  }

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  notify() {
    this.listeners.forEach(fn => fn(this.data));
  }

  get accounts() { return this.data.accounts; }
  get transactions() { return this.data.transactions; }
  get categories() { return this.data.categories; }
  get debts() { return this.data.debts || []; }
  get settings() { return this.data.settings; }

  updateSettings(newSettings) {
    this.data.settings = { ...this.data.settings, ...newSettings };
    this.save();
  }

  getDefaultAccount() {
    return this.data.accounts.find(a => a.isDefault) || this.data.accounts[0] || DEFAULT_ACCOUNTS[0];
  }

  setDefaultAccount(id) {
    this.data.accounts.forEach(a => {
      a.isDefault = (a.id === id);
    });
    this.save();
  }

  getAccount(id) {
    if (!id) return this.getDefaultAccount();
    return this.data.accounts.find(a => a.id.toLowerCase() === id.toLowerCase()) || this.getDefaultAccount();
  }

  addAccount(account) {
    const rawName = (account.name || 'Cuenta').trim();
    const id = rawName.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now().toString(36);
    const code = account.code || rawName.substring(0, 3).toUpperCase();
    const newAccount = {
      id,
      code,
      name: rawName,
      type: account.type || 'Banco',
      balance: parseFloat(account.balance) || 0,
      currency: account.currency || this.data.settings.defaultCurrency,
      isDefault: false
    };
    this.data.accounts.push(newAccount);
    this.save();
    pushAccountToCloud(newAccount).catch(e => console.warn('Push account to cloud failed:', e));
    return newAccount;
  }

  updateAccount(id, updates) {
    const acc = this.data.accounts.find(a => a.id.toLowerCase() === (id || '').toLowerCase());
    if (!acc) return false;
    Object.assign(acc, updates);
    this.save();
    if (updates.balance !== undefined) {
      updateAccountBalanceInCloud(id, updates.balance).catch(e => console.warn('Update account in cloud failed:', e));
    }
    return true;
  }

  deleteAccount(id) {
    if (this.data.accounts.length <= 1) {
      throw new Error('Debes mantener al menos tu cuenta principal de Interbank.');
    }
    const acc = this.getAccount(id);
    const wasDefault = acc?.isDefault;
    this.data.accounts = this.data.accounts.filter(a => a.id !== id);
    if (wasDefault && this.data.accounts.length > 0) {
      this.data.accounts[0].isDefault = true;
    }
    this.save();
    deleteAccountInCloud(id).catch(e => console.warn('Delete account in cloud failed:', e));
  }

  addTransaction(tx) {
    const now = new Date();
    const defaultAcc = this.getDefaultAccount();
    const newTx = {
      id: 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      date: tx.date || now.toISOString().split('T')[0],
      time: tx.time || now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      type: tx.type || 'egreso', // 'egreso' | 'ingreso' | 'transferencia'
      amount: parseFloat(tx.amount) || 0,
      currency: tx.currency || this.data.settings.defaultCurrency,
      accountId: tx.accountId || defaultAcc.id,
      toAccountId: tx.toAccountId || null,
      category: tx.category || 'Otros Gastos',
      desc: tx.desc || 'Movimiento sin descripción',
      rawSpeech: tx.rawSpeech || ''
    };

    // Update account balances
    const sourceAcc = this.getAccount(newTx.accountId);
    if (newTx.type === 'egreso') {
      if (sourceAcc) sourceAcc.balance -= newTx.amount;
    } else if (newTx.type === 'ingreso') {
      if (sourceAcc) sourceAcc.balance += newTx.amount;
    } else if (newTx.type === 'transferencia') {
      const targetAcc = this.getAccount(newTx.toAccountId);
      if (sourceAcc) sourceAcc.balance -= newTx.amount;
      if (targetAcc) targetAcc.balance += newTx.amount;
    }

    this.data.transactions.unshift(newTx);
    this.save();
    pushTransactionToCloud(newTx).catch(e => console.warn('Push tx to cloud failed:', e));
    return newTx;
  }

  deleteTransaction(id) {
    const index = this.data.transactions.findIndex(t => t.id === id);
    if (index === -1) return false;

    const tx = this.data.transactions[index];
    // Revert balance
    const sourceAcc = this.getAccount(tx.accountId);
    if (tx.type === 'egreso') {
      if (sourceAcc) sourceAcc.balance += tx.amount;
    } else if (tx.type === 'ingreso') {
      if (sourceAcc) sourceAcc.balance -= tx.amount;
    } else if (tx.type === 'transferencia') {
      const targetAcc = this.getAccount(tx.toAccountId);
      if (sourceAcc) sourceAcc.balance += tx.amount;
      if (targetAcc) targetAcc.balance -= tx.amount;
    }

    this.data.transactions.splice(index, 1);
    this.save();
    deleteTransactionInCloud(tx).catch(e => console.warn('Delete tx in cloud failed:', e));
    return true;
  }

  /* ===================================================
     DEBTS & LOANS MANAGEMENT
  =================================================== */
  addDebt(debt) {
    const now = new Date();
    const amount = parseFloat(debt.amount) || 0;
    const defaultAcc = this.getDefaultAccount();
    const assignedAccountId = debt.accountId || defaultAcc.id;

    const newDebt = {
      id: 'debt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      person: (debt.person || 'Sin nombre').trim(),
      type: debt.type || 'me_deben', // 'me_deben' (por cobrar) | 'debo' (por pagar)
      amount: amount,
      balance: amount,
      currency: debt.currency || this.data.settings.defaultCurrency,
      concept: debt.concept || debt.desc || 'Préstamo',
      date: debt.date || now.toISOString().split('T')[0],
      status: 'pendiente',
      accountId: assignedAccountId
    };

    // If money was lent, record egreso in the account
    if (newDebt.accountId && newDebt.type === 'me_deben') {
      const acc = this.getAccount(newDebt.accountId);
      if (acc) {
        acc.balance -= newDebt.amount;
        this.data.transactions.unshift({
          id: 'tx_' + Date.now(),
          date: newDebt.date,
          time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          type: 'egreso',
          amount: newDebt.amount,
          currency: newDebt.currency,
          accountId: acc.id,
          toAccountId: null,
          category: 'Préstamos y Deudas',
          desc: `Préstamo a ${newDebt.person} (${newDebt.concept})`,
          rawSpeech: debt.rawSpeech || ''
        });
      }
    }

    this.data.debts = this.data.debts || [];
    this.data.debts.unshift(newDebt);
    this.save();
    pushDebtToCloud(newDebt).catch(e => console.warn('Push debt to cloud failed:', e));
    return newDebt;
  }

  settleDebt(debtId, paymentAmount, accountId) {
    const debt = (this.data.debts || []).find(d => d.id === debtId);
    if (!debt) return false;

    const amount = parseFloat(paymentAmount) || debt.balance;
    const now = new Date();
    const defaultAcc = this.getDefaultAccount();

    debt.balance = Math.max(0, debt.balance - amount);
    if (debt.balance <= 0) {
      debt.status = 'pagado';
    }

    // If someone paid me, deposit into account as income!
    if (debt.type === 'me_deben') {
      const targetAccId = accountId || debt.accountId || defaultAcc.id;
      const acc = this.getAccount(targetAccId);
      if (acc) {
        acc.balance += amount;
        const newTx = {
          id: 'tx_' + Date.now(),
          date: now.toISOString().split('T')[0],
          time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          type: 'ingreso',
          amount: amount,
          currency: debt.currency,
          accountId: acc.id,
          toAccountId: null,
          category: 'Cobro de Deuda',
          desc: `Pago de deuda de ${debt.person} (${debt.concept})`,
          rawSpeech: ''
        };
        this.data.transactions.unshift(newTx);
        pushTransactionToCloud(newTx).catch(e => console.warn('Push settle tx failed:', e));
      }
    } else if (debt.type === 'debo') {
      // I paid my debt to someone, deduct from account
      const sourceAccId = accountId || defaultAcc.id;
      const acc = this.getAccount(sourceAccId);
      if (acc) {
        acc.balance -= amount;
        const newTx = {
          id: 'tx_' + Date.now(),
          date: now.toISOString().split('T')[0],
          time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          type: 'egreso',
          amount: amount,
          currency: debt.currency,
          accountId: acc.id,
          toAccountId: null,
          category: 'Pago de Deuda',
          desc: `Pago de deuda a ${debt.person} (${debt.concept})`,
          rawSpeech: ''
        };
        this.data.transactions.unshift(newTx);
        pushTransactionToCloud(newTx).catch(e => console.warn('Push payment tx failed:', e));
      }
    }

    this.save();
    updateDebtInCloud(debt.id, debt.balance, debt.status).catch(e => console.warn('Update debt in cloud failed:', e));
    return debt;
  }

  settleDebtByPerson(personName, paymentAmount, accountId) {
    const nameClean = (personName || '').toLowerCase().trim();
    const defaultAcc = this.getDefaultAccount();
    const debt = (this.data.debts || []).find(d => 
      d.status === 'pendiente' && d.person.toLowerCase().includes(nameClean)
    );

    if (debt) {
      return this.settleDebt(debt.id, paymentAmount, accountId || defaultAcc.id);
    } else {
      const amount = parseFloat(paymentAmount) || 0;
      const targetAccId = accountId || defaultAcc.id;
      return this.addTransaction({
        type: 'ingreso',
        amount: amount,
        accountId: targetAccId,
        category: 'Cobro de Deuda',
        desc: `Cobro de ${personName || 'deuda'}`
      });
    }
  }

  deleteDebt(debtId) {
    this.data.debts = (this.data.debts || []).filter(d => d.id !== debtId);
    this.save();
  }

  getDebtsSummary() {
    const debts = this.data.debts || [];
    let toCollect = 0;
    let toPay = 0;

    debts.forEach(d => {
      if (d.status === 'pendiente') {
        if (d.type === 'me_deben') toCollect += (d.balance || 0);
        if (d.type === 'debo') toPay += (d.balance || 0);
      }
    });

    return { toCollect, toPay };
  }

  getTotalBalance() {
    return this.data.accounts.reduce((sum, acc) => sum + (acc.balance || 0), 0);
  }

  getMonthlySummary() {
    const now = new Date();
    const currentMonth = now.toISOString().substring(0, 7); // YYYY-MM
    let income = 0;
    let expense = 0;

    this.data.transactions.forEach(tx => {
      if (tx.date && tx.date.startsWith(currentMonth)) {
        if (tx.type === 'ingreso') income += tx.amount;
        if (tx.type === 'egreso') expense += tx.amount;
      }
    });

    return { income, expense, categoryList: this.getCategoryBreakdown() };
  }

  getCategoryBreakdown() {
    const now = new Date();
    const currentMonth = now.toISOString().substring(0, 7);
    const map = {};

    this.data.transactions.forEach(tx => {
      if (tx.type === 'egreso' && tx.date && tx.date.startsWith(currentMonth)) {
        map[tx.category] = (map[tx.category] || 0) + tx.amount;
      }
    });

    return Object.entries(map)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);
  }

  exportBackup() {
    return JSON.stringify(this.data, null, 2);
  }

  importBackup(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (parsed.accounts && parsed.transactions) {
        this.data = parsed;
        this.save();
        return true;
      }
      return false;
    } catch (e) {
      console.error('Invalid backup file:', e);
      return false;
    }
  }
}

export const store = new Store();
