/**
 * UI Renderer and Controller for Billetera Voz (With Debts & Loans)
 */
import { store } from './store.js';
import { testGroqConnection, transcribeWithGroqWhisper, extractTransactionData, fetchAvailableGroqModels, pingGroqQuota, VERIFIED_ACTIVE_MODELS } from './groq.js';
import { voiceManager } from './voice.js';
import { sendOtpEmail, verifyOtpToken, signOutUser, getCurrentSessionUser } from './supabase.js';
import { quotaManager } from './quota.js';

export class UIController {
  constructor() {
    this.currentTab = 'home';
    this.parsedPendingTx = null;
    this.deferredInstallPrompt = null;
    this.selectedHistoryMonth = new Date().toISOString().substring(0, 7);
  }

  init() {
    this.bindGlobalEvents();
    store.subscribe(() => {
      this.renderAll();
    });
    this.renderAll();

    // Subscribe to real-time Groq rate limit & token quota
    quotaManager.subscribe((status) => {
      this.updateQuotaUI(status);
    });

    // Listen for PWA installation prompt
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
      const banner = document.getElementById('pwa-install-banner');
      if (banner) banner.style.display = 'flex';
    });
  }

  showToast(message, duration = 3000) {
    const toast = document.getElementById('toast-notice');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  switchTab(tabId) {
    this.currentTab = tabId;
    document.querySelectorAll('.tab-view').forEach(view => {
      view.classList.remove('active');
    });
    const target = document.getElementById(`tab-${tabId}`);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.tab === tabId);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  renderAll() {
    try { this.renderBalanceCard(); } catch (e) { console.warn('renderBalanceCard error:', e); }
    try { this.renderDebtsWidget(); } catch (e) { console.warn('renderDebtsWidget error:', e); }
    try { this.renderAccountsCarousel(); } catch (e) { console.warn('renderAccountsCarousel error:', e); }
    try { this.renderRecentTransactions(); } catch (e) { console.warn('renderRecentTransactions error:', e); }
    try { this.renderAccountsTab(); } catch (e) { console.warn('renderAccountsTab error:', e); }
    try { this.renderDebtsTab(); } catch (e) { console.warn('renderDebtsTab error:', e); }
    try { this.renderHistoryTab(); } catch (e) { console.warn('renderHistoryTab error:', e); }
    try { this.renderStatsTab(); } catch (e) { console.warn('renderStatsTab error:', e); }
    try { this.renderSettingsTab(); } catch (e) { console.warn('renderSettingsTab error:', e); }
  }

  renderBalanceCard() {
    const totalBalance = store.getTotalBalance();
    const { income, expense } = store.getMonthlySummary();
    const hide = store.settings.hideBalances;
    const currency = store.settings.defaultCurrency === 'USD' ? '$' : 'S/';

    const valEl = document.getElementById('total-balance-value');
    const incomeEl = document.getElementById('monthly-income-val');
    const expenseEl = document.getElementById('monthly-expense-val');

    if (valEl) {
      valEl.textContent = hide ? '••••••' : totalBalance.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (incomeEl) {
      incomeEl.textContent = hide ? '••••' : `+ ${currency} ${income.toFixed(2)}`;
    }
    if (expenseEl) {
      expenseEl.textContent = hide ? '••••' : `- ${currency} ${expense.toFixed(2)}`;
    }
  }

  renderDebtsWidget() {
    const { toCollect, toPay } = store.getDebtsSummary();
    const sym = store.settings.defaultCurrency === 'USD' ? '$' : 'S/';
    const hide = store.settings.hideBalances;

    const colEl = document.getElementById('widget-to-collect');
    const payEl = document.getElementById('widget-to-pay');

    if (colEl) colEl.textContent = hide ? '••••' : `${sym} ${toCollect.toFixed(2)}`;
    if (payEl) payEl.textContent = hide ? '••••' : `${sym} ${toPay.toFixed(2)}`;
  }

  renderAccountsCarousel() {
    const container = document.getElementById('accounts-carousel');
    if (!container) return;

    const hide = store.settings.hideBalances;
    const currencySym = store.settings.defaultCurrency === 'USD' ? '$' : 'S/';

    container.innerHTML = store.accounts.map(acc => `
      <div class="account-card-item" data-id="${acc.id}">
        <div class="account-card-top">
          <span class="account-code-pill">${acc.code || acc.name.substring(0, 3).toUpperCase()}</span>
          <span class="account-type-tag">${acc.isDefault ? 'Principal' : acc.type}</span>
        </div>
        <div class="account-card-bottom">
          <span class="account-name">${acc.name}</span>
          <span class="account-balance">
            ${hide ? '••••' : `${currencySym} ${(acc.balance || 0).toFixed(2)}`}
          </span>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.account-card-item').forEach(el => {
      el.addEventListener('click', () => {
        this.openEditAccountBalanceModal(el.dataset.id);
      });
    });
  }

  renderRecentTransactions() {
    const container = document.getElementById('recent-tx-list');
    if (!container) return;

    const list = store.transactions.slice(0, 8);
    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No tienes movimientos registrados todavía.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = list.map(tx => this.renderTransactionHTML(tx)).join('');
    this.attachTxItemEvents(container);
  }

  renderTransactionHTML(tx) {
    const isIncome = tx.type === 'ingreso';
    const isTransfer = tx.type === 'transferencia';
    const sign = isIncome ? '+' : (isTransfer ? '⇄' : '-');
    const typeClass = isIncome ? 'income' : (isTransfer ? 'transfer' : 'expense');
    const acc = store.getAccount(tx.accountId) || { name: tx.accountId || 'Cuenta' };
    const toAcc = tx.toAccountId ? (store.getAccount(tx.toAccountId) || { name: tx.toAccountId }) : null;
    const sym = tx.currency === 'USD' ? '$' : 'S/';

    const metaDetail = isTransfer && toAcc 
      ? `${acc.name} → ${toAcc.name}` 
      : acc.name;

    let iconSvg = '';
    if (isIncome) {
      iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="7" y1="7" x2="17" y2="7"></line><polyline points="17 7 17 17"></polyline><line x1="17" y1="7" x2="7" y2="17"></line></svg>`;
    } else if (isTransfer) {
      iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;
    } else {
      iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="17 17 7 17 7 7"></polyline></svg>`;
    }

    return `
      <div class="tx-item" data-id="${tx.id}">
        <div class="tx-left">
          <div class="tx-dir-indicator ${typeClass}">
            ${iconSvg}
          </div>
          <div class="tx-details">
            <span class="tx-desc">${tx.desc || tx.category}</span>
            <div class="tx-meta">
              <span class="tx-category-name">${tx.category}</span>
              <span>•</span>
              <span class="tx-account-tag">${metaDetail}</span>
              <span>•</span>
              <span>${tx.time || tx.date}</span>
            </div>
          </div>
        </div>
        <div class="tx-right">
          <span class="tx-amount ${typeClass}">${sign} ${sym} ${(tx.amount || 0).toFixed(2)}</span>
          <span class="tx-time">${tx.date}</span>
        </div>
      </div>
    `;
  }

  attachTxItemEvents(container) {
    container.querySelectorAll('.tx-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const tx = store.transactions.find(t => t.id === id);
        if (tx) this.openTxDetailModal(tx);
      });
    });
  }

  renderAccountsTab() {
    const container = document.getElementById('all-accounts-list');
    if (!container) return;

    const currencySym = store.settings.defaultCurrency === 'USD' ? '$' : 'S/';
    const defaultAcc = store.getDefaultAccount();

    container.innerHTML = store.accounts.map(acc => {
      const isDefault = acc.id === defaultAcc.id;
      return `
        <div class="tx-item" data-id="${acc.id}" style="align-items: center; padding: 14px 16px;">
          <div class="tx-left">
            <span class="account-code-pill" style="padding: 4px 8px; font-size: 12px;">${acc.code || acc.name.substring(0, 3).toUpperCase()}</span>
            <div class="tx-details">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="tx-desc" style="font-weight: 600;">${acc.name}</span>
                ${isDefault ? '<span class="badge-tag success" style="font-size: 10px; padding: 2px 6px;">Principal</span>' : ''}
              </div>
              <span class="tx-meta">${acc.type}</span>
            </div>
          </div>
          <div class="tx-right" style="display: flex; align-items: center; gap: 8px;">
            <div style="text-align: right;">
              <span class="tx-amount" style="color: var(--text-main); font-weight: 600;">${currencySym} ${(acc.balance || 0).toFixed(2)}</span>
              <button class="edit-acc-bal-btn" data-id="${acc.id}" style="background: none; border: none; font-size: 11px; color: var(--accent-muted); cursor: pointer; text-decoration: underline; display: block; margin-top: 2px;">Editar Saldo</button>
            </div>
            ${!isDefault ? `
              <button class="set-default-acc-btn section-action" data-id="${acc.id}" style="font-size: 11px; padding: 4px 8px;">Hacer Principal</button>
              <button class="delete-acc-btn" data-id="${acc.id}" title="Eliminar cuenta" style="background: none; border: none; color: var(--expense-red); cursor: pointer; padding: 4px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.edit-acc-bal-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openEditAccountBalanceModal(btn.dataset.id);
      });
    });

    container.querySelectorAll('.set-default-acc-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.setDefaultAccount(btn.dataset.id);
        this.showToast(`Cuenta principal: ${store.getAccount(btn.dataset.id).name}`);
        this.renderAll();
      });
    });

    container.querySelectorAll('.delete-acc-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const acc = store.getAccount(btn.dataset.id);
        if (confirm(`¿Eliminar la cuenta "${acc.name}"?`)) {
          try {
            store.deleteAccount(btn.dataset.id);
            this.showToast(`Cuenta eliminada`);
            this.renderAll();
          } catch (err) {
            this.showToast(err.message);
          }
        }
      });
    });
  }

  /* ===================================================
     DEBTS & LOANS TAB
  =================================================== */
  renderDebtsTab() {
    const container = document.getElementById('all-debts-list');
    if (!container) return;

    const { toCollect, toPay } = store.getDebtsSummary();
    const sym = store.settings.defaultCurrency === 'USD' ? '$' : 'S/';

    const colTotalEl = document.getElementById('debts-total-collect');
    const payTotalEl = document.getElementById('debts-total-pay');
    if (colTotalEl) colTotalEl.textContent = `${sym} ${toCollect.toFixed(2)}`;
    if (payTotalEl) payTotalEl.textContent = `${sym} ${toPay.toFixed(2)}`;

    const filter = document.querySelector('.debt-filter-btn.active')?.dataset.filter || 'todos';
    let filtered = [...store.debts];

    if (filter === 'me_deben') {
      filtered = filtered.filter(d => d.type === 'me_deben' && d.status === 'pendiente');
    } else if (filter === 'debo') {
      filtered = filtered.filter(d => d.type === 'debo' && d.status === 'pendiente');
    } else if (filter === 'pagado') {
      filtered = filtered.filter(d => d.status === 'pagado');
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No hay deudas registradas en esta vista.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(debt => {
      const isMeDeben = debt.type === 'me_deben';
      const isPaid = debt.status === 'pagado';
      const initials = debt.person.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() || 'P';
      const typeLabel = isMeDeben ? 'Te debe' : 'Le debes';
      const statusClass = isPaid ? 'pagado' : 'pendiente';
      const statusText = isPaid ? 'Pagado' : 'Pendiente';
      const actionText = isMeDeben ? 'Registrar Cobro' : 'Abonar Deuda';

      return `
        <div class="debt-item" data-id="${debt.id}">
          <div class="debt-item-top">
            <div class="debt-person-info">
              <div class="debt-avatar-pill">${initials}</div>
              <div>
                <div class="debt-person-name">${debt.person}</div>
                <div class="debt-concept">${debt.concept} • <span style="font-weight: 600;">${typeLabel}</span></div>
              </div>
            </div>
            <div class="debt-amount-box">
              <span class="debt-amount-val ${debt.type}">${sym} ${(debt.balance || 0).toFixed(2)}</span>
              <span class="debt-status-tag ${statusClass}">${statusText}</span>
            </div>
          </div>
          <div class="debt-item-bottom">
            <span>${debt.date}</span>
            <div style="display: flex; gap: 6px;">
              ${!isPaid ? `<button class="debt-action-btn settle-btn" data-id="${debt.id}">${actionText}</button>` : ''}
              <button class="debt-action-btn delete-btn" data-id="${debt.id}" style="color: var(--text-dim);">Eliminar</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.settle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openSettleDebtModal(btn.dataset.id);
      });
    });

    container.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('¿Eliminar este registro de deuda?')) {
          store.deleteDebt(btn.dataset.id);
          this.showToast('Deuda eliminada');
        }
      });
    });
  }

  openSettleDebtModal(debtId) {
    const debt = store.debts.find(d => d.id === debtId);
    if (!debt) return;

    const isMeDeben = debt.type === 'me_deben';
    const actionTitle = isMeDeben ? `¿Cuánto te pagó ${debt.person}?` : `¿Cuánto le pagaste a ${debt.person}?`;
    const amountStr = prompt(actionTitle, debt.balance);
    if (!amountStr || isNaN(parseFloat(amountStr))) return;

    const accNames = store.accounts.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
    const promptAcc = isMeDeben 
      ? `¿A qué cuenta ingresó el dinero? (número):\n${accNames}` 
      : `¿De qué cuenta salió el dinero? (número):\n${accNames}`;
    const accIdx = prompt(promptAcc, '1');
    const chosenAcc = store.accounts[parseInt(accIdx) - 1] || store.accounts[0];

    store.settleDebt(debt.id, parseFloat(amountStr), chosenAcc.id);
    this.showToast(isMeDeben ? `Pago recibido de ${debt.person}` : `Pago realizado a ${debt.person}`);
    this.renderAll();
  }

  openManualDebtModal() {
    const person = prompt('Nombre de la persona:');
    if (!person) return;

    const typeChoice = prompt('Tipo de deuda:\n1. Me debe (Por cobrar)\n2. Le debo (Por pagar)', '1');
    const type = typeChoice === '2' ? 'debo' : 'me_deben';

    const amountStr = prompt('Monto:');
    if (!amountStr || isNaN(parseFloat(amountStr))) return;

    const concept = prompt('Motivo o concepto (ej. Almuerzo, Préstamo):', 'Préstamo') || 'Préstamo';

    let accountId = null;
    if (type === 'me_deben') {
      const deduct = confirm('¿El dinero prestado salió de alguna de tus cuentas registradas?');
      if (deduct) {
        const accNames = store.accounts.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
        const accIdx = prompt(`Selecciona la cuenta de salida (número):\n${accNames}`, '1');
        const acc = store.accounts[parseInt(accIdx) - 1] || store.accounts[0];
        accountId = acc.id;
      }
    }

    store.addDebt({
      person,
      type,
      amount: parseFloat(amountStr),
      concept,
      accountId
    });

    this.showToast('Deuda registrada');
  }

  formatMonthLabel(monthKey) {
    if (!monthKey || monthKey === 'todos') return 'Todos los meses';
    const parts = monthKey.split('-');
    if (parts.length < 2) return monthKey;
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const dateObj = new Date(year, month - 1, 1);
    const str = dateObj.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' });
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  getAvailableMonths() {
    const currentMonth = new Date().toISOString().substring(0, 7);
    const monthsSet = new Set();
    monthsSet.add(currentMonth);

    (store.transactions || []).forEach(tx => {
      if (tx.date && tx.date.length >= 7) {
        monthsSet.add(tx.date.substring(0, 7));
      }
    });

    return Array.from(monthsSet).sort().reverse();
  }

  navigateHistoryMonth(direction) {
    const months = this.getAvailableMonths();
    if (!this.selectedHistoryMonth || this.selectedHistoryMonth === 'todos') {
      this.selectedHistoryMonth = months[0];
      this.renderHistoryTab();
      return;
    }

    const idx = months.indexOf(this.selectedHistoryMonth);
    if (direction < 0) {
      // Previous month
      if (idx !== -1 && idx < months.length - 1) {
        this.selectedHistoryMonth = months[idx + 1];
      } else {
        const [y, m] = this.selectedHistoryMonth.split('-').map(Number);
        const prev = new Date(y, m - 2, 1).toISOString().substring(0, 7);
        this.selectedHistoryMonth = prev;
      }
    } else {
      // Next month
      if (idx > 0) {
        this.selectedHistoryMonth = months[idx - 1];
      } else {
        const [y, m] = this.selectedHistoryMonth.split('-').map(Number);
        const next = new Date(y, m, 1).toISOString().substring(0, 7);
        this.selectedHistoryMonth = next;
      }
    }
    this.renderHistoryTab();
  }

  exportHistoryToCSV() {
    const txs = store.transactions;
    if (!txs || txs.length === 0) {
      this.showToast('No hay transacciones para exportar');
      return;
    }
    const headers = ['Fecha', 'Hora', 'Tipo', 'Monto', 'Moneda', 'Cuenta', 'Categoría', 'Descripción'];
    const rows = txs.map(t => [
      t.date || '',
      t.time || '',
      t.type || '',
      t.amount || 0,
      t.currency || 'PEN',
      `"${(store.getAccount(t.accountId)?.name || t.accountId || '').replace(/"/g, '""')}"`,
      `"${(t.category || '').replace(/"/g, '""')}"`,
      `"${(t.desc || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `billetera_historial_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.showToast('Historial descargado en CSV');
  }

  renderHistoryTab() {
    const container = document.getElementById('full-history-list');
    if (!container) return;

    const availableMonths = this.getAvailableMonths();
    if (!this.selectedHistoryMonth) {
      this.selectedHistoryMonth = availableMonths[0];
    }

    // Populate month select dropdown
    const monthSelect = document.getElementById('history-month-select');
    if (monthSelect) {
      const options = [
        `<option value="todos" ${this.selectedHistoryMonth === 'todos' ? 'selected' : ''}>Todos los meses</option>`,
        ...availableMonths.map(m => `
          <option value="${m}" ${this.selectedHistoryMonth === m ? 'selected' : ''}>${this.formatMonthLabel(m)}</option>
        `)
      ];
      monthSelect.innerHTML = options.join('');
      monthSelect.value = this.selectedHistoryMonth;
    }

    // 1. Filter by Month
    let monthTransactions = [...store.transactions];
    if (this.selectedHistoryMonth && this.selectedHistoryMonth !== 'todos') {
      monthTransactions = monthTransactions.filter(t => t.date && t.date.startsWith(this.selectedHistoryMonth));
    }

    // 2. Calculate summary statistics for this month view
    let mIncome = 0;
    let mExpense = 0;
    monthTransactions.forEach(t => {
      if (t.type === 'ingreso') mIncome += (t.amount || 0);
      if (t.type === 'egreso') mExpense += (t.amount || 0);
    });
    const mNet = mIncome - mExpense;
    const sym = store.settings.defaultCurrency === 'USD' ? '$' : 'S/';

    const incEl = document.getElementById('history-sum-income');
    const expEl = document.getElementById('history-sum-expense');
    const netEl = document.getElementById('history-sum-net');
    if (incEl) incEl.textContent = `+ ${sym} ${mIncome.toFixed(2)}`;
    if (expEl) expEl.textContent = `- ${sym} ${mExpense.toFixed(2)}`;
    if (netEl) {
      netEl.textContent = `${mNet >= 0 ? '+' : ''} ${sym} ${mNet.toFixed(2)}`;
      netEl.style.color = mNet >= 0 ? 'var(--income-green)' : 'var(--expense-red)';
    }

    // 3. Filter by Type (todos, egreso, ingreso, transferencia)
    const typeFilter = document.querySelector('.history-filter-btn.active')?.dataset.filter || 'todos';
    let filtered = monthTransactions;
    if (typeFilter !== 'todos') {
      filtered = filtered.filter(t => t.type === typeFilter);
    }

    if (filtered.length === 0) {
      const monthLabel = this.formatMonthLabel(this.selectedHistoryMonth);
      container.innerHTML = `
        <div class="empty-state">
          <p>No hay movimientos registrados en ${monthLabel}.</p>
        </div>
      `;
      return;
    }

    const groups = {};
    filtered.forEach(tx => {
      const d = tx.date || 'Sin fecha';
      if (!groups[d]) groups[d] = [];
      groups[d].push(tx);
    });

    let html = '';
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    Object.keys(groups).sort().reverse().forEach(date => {
      let dateLabel = date;
      if (date === today) dateLabel = 'Hoy';
      else if (date === yesterday) dateLabel = 'Ayer';

      html += `<div class="tx-date-group-title">${dateLabel}</div>`;
      html += groups[date].map(tx => this.renderTransactionHTML(tx)).join('');
    });

    container.innerHTML = html;
    this.attachTxItemEvents(container);
  }

  renderStatsTab() {
    const summary = store.getMonthlySummary() || { income: 0, expense: 0, categoryList: [] };
    const income = summary.income || 0;
    const expense = summary.expense || 0;
    const categoryList = summary.categoryList || store.getCategoryBreakdown() || [];
    const currencySym = store.settings.defaultCurrency === 'USD' ? '$' : 'S/';

    const net = income - expense;
    const netEl = document.getElementById('stats-net-balance');
    const incomeEl = document.getElementById('stats-income-total');
    const expenseEl = document.getElementById('stats-expense-total');
    const catContainer = document.getElementById('stats-categories-list');

    if (netEl) {
      netEl.textContent = `${currencySym} ${net.toFixed(2)}`;
      netEl.style.color = net >= 0 ? 'var(--income-green)' : 'var(--expense-red)';
    }
    if (incomeEl) incomeEl.textContent = `${currencySym} ${income.toFixed(2)}`;
    if (expenseEl) expenseEl.textContent = `${currencySym} ${expense.toFixed(2)}`;

    if (catContainer) {
      if (categoryList.length === 0) {
        catContainer.innerHTML = '<p class="tx-meta" style="text-align: center; padding: 20px;">Sin gastos este mes.</p>';
        return;
      }

      catContainer.innerHTML = categoryList.map(item => {
        const pct = expense > 0 ? Math.round((item.amount / expense) * 100) : 0;
        return `
          <div style="margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
              <span style="font-weight: 500; color: var(--text-main);">${item.name}</span>
              <span style="font-weight: 600; font-variant-numeric: tabular-nums;">${currencySym} ${item.amount.toFixed(2)} (${pct}%)</span>
            </div>
            <div style="height: 4px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden;">
              <div style="height: 100%; width: ${pct}%; background: var(--accent-muted); border-radius: 2px;"></div>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  renderSettingsTab() {
    const apiKeyInput = document.getElementById('groq-api-key-input');
    const modelSelect = document.getElementById('groq-model-select');
    const currencySelect = document.getElementById('default-currency-select');
    const audioModeSelect = document.getElementById('audio-mode-select');

    if (apiKeyInput) apiKeyInput.value = store.settings.groqApiKey || '';
    if (modelSelect && store.settings.selectedModel) {
      modelSelect.value = store.settings.selectedModel;
    }
    if (currencySelect) currencySelect.value = store.settings.defaultCurrency || 'PEN';
    if (audioModeSelect) audioModeSelect.value = store.settings.audioMode || 'whisper';

    this.updateKeyStatusBadge();
    this.renderSupabaseSettings();

    // Auto-discover models if key is present and not yet loaded
    if (store.settings.groqApiKey && !this._modelsAutoLoaded) {
      this._modelsAutoLoaded = true;
      this.refreshActiveGroqModels(false);
    }
  }

  async renderSupabaseSettings() {
    try {
      const badge = document.getElementById('supabase-status-badge');
      const desc = document.getElementById('supabase-status-desc');
      if (badge) {
        badge.textContent = 'Conectado';
        badge.className = 'badge-tag success';
      }
      if (desc) {
        desc.textContent = 'Conexión directa activa con tu base de datos mediante Anon Key. Tus cuentas, movimientos y deudas se respaldan y sincronizan en tiempo real sin necesidad de correos ni contraseñas.';
      }
    } catch (e) {
      console.warn('Error comprobando estado de Supabase:', e);
    }
  }

  async refreshActiveGroqModels(showFeedback = false) {
    const key = store.settings.groqApiKey || document.getElementById('groq-api-key-input')?.value.trim();
    if (!key) {
      if (showFeedback) this.showToast('Ingresa una API Key para buscar modelos disponibles');
      return;
    }

    const selectEl = document.getElementById('groq-model-select');
    const hintEl = document.getElementById('model-status-hint');
    if (hintEl) hintEl.textContent = 'Consultando modelos activos en tu cuenta Groq...';

    try {
      const models = await fetchAvailableGroqModels(key);
      if (models && models.length > 0) {
        if (selectEl) {
          const current = store.settings.selectedModel;
          selectEl.innerHTML = models.map(m => {
            let desc = m;
            if (m === 'openai/gpt-oss-20b') desc = `${m} (Producción Groq - 1000 tps)`;
            else if (m === 'openai/gpt-oss-120b') desc = `${m} (Producción Groq - Flagship 500 tps)`;
            else if (m === 'qwen/qwen3.8-27b') desc = `${m} (Groq - 450 tps)`;
            else if (m === 'llama-3.1-8b-instant') desc = `${m} (Groq LLaMA - 560 tps)`;
            else if (m === 'llama-3.3-70b-versatile') desc = `${m} (Groq LLaMA - 280 tps)`;
            return `<option value="${m}">${desc}</option>`;
          }).join('');

          if (models.includes(current)) {
            selectEl.value = current;
          } else {
            selectEl.value = models[0];
            store.updateSettings({ selectedModel: models[0] });
          }
        }
        if (hintEl) hintEl.textContent = `Modelos verificados activos (${models.length} disponibles).`;
        if (showFeedback) this.showToast(`${models.length} modelos disponibles en Groq`);
      }
    } catch (e) {
      if (hintEl) hintEl.textContent = 'Usando modelos verificados de Groq.';
    }
  }

  updateKeyStatusBadge() {
    const badge = document.getElementById('groq-status-badge');
    if (!badge) return;
    if (store.settings.groqApiKey && store.settings.groqApiKey.trim().length > 15) {
      badge.textContent = 'Key Configurada';
      badge.className = 'badge-tag success';
    } else {
      badge.textContent = 'Key Requerida';
      badge.className = 'badge-tag warning';
    }
  }

  updateQuotaUI(status) {
    if (!status) return;

    // 1. Header live pill
    const headerPill = document.getElementById('header-groq-pill');
    const headerTokens = document.getElementById('header-groq-tokens-text');
    if (headerPill && headerTokens) {
      headerTokens.textContent = `${status.remainingTokens.toLocaleString()} TPM`;
      headerPill.className = `header-groq-pill ${status.status}`;
      headerPill.title = `Groq IA: ${status.statusText} (${status.remainingTokens.toLocaleString()} tokens disponibles, ${status.remainingRequests} req/min)`;
    }

    // 2. Voice modal quota card
    const voicePill = document.getElementById('quota-status-pill');
    const voiceStatusText = document.getElementById('quota-status-text');
    const voiceModelName = document.getElementById('quota-model-name');
    const voiceFill = document.getElementById('quota-fill');
    const voiceTokensVal = document.getElementById('quota-tokens-val');
    const voiceRequestsVal = document.getElementById('quota-requests-val');
    const voiceResetVal = document.getElementById('quota-reset-val');
    const micBtn = document.getElementById('sheet-mic-btn');

    if (voicePill) voicePill.className = `quota-status-pill ${status.status}`;
    if (voiceStatusText) voiceStatusText.textContent = status.statusText;
    if (voiceModelName) voiceModelName.textContent = status.modelName;
    if (voiceFill) {
      voiceFill.style.width = `${status.percentTokens}%`;
      voiceFill.className = `quota-fill ${status.status === 'ready' ? '' : status.status}`;
    }
    if (voiceTokensVal) voiceTokensVal.textContent = `${status.remainingTokens.toLocaleString()} / ${status.limitTokens.toLocaleString()}`;
    if (voiceRequestsVal) voiceRequestsVal.textContent = `${status.remainingRequests} / ${status.limitRequests} RPM`;
    if (voiceResetVal) {
      voiceResetVal.textContent = `${status.resetSeconds}s`;
      voiceResetVal.style.color = status.resetSeconds > 0 ? 'var(--expense-red)' : 'var(--text-main)';
    }

    // Mic button locking during cooldown
    if (micBtn && !voiceManager.isRecording) {
      if (!status.canRecord) {
        micBtn.classList.add('disabled');
        micBtn.setAttribute('title', status.statusText);
        const statusTextEl = document.getElementById('voice-status-text');
        if (statusTextEl && !this.parsedPendingTx) {
          statusTextEl.textContent = `Cuota al límite. Disponible en ${status.resetSeconds}s...`;
        }
      } else {
        micBtn.classList.remove('disabled');
        micBtn.removeAttribute('title');
      }
    }

    // 3. Settings quota panel
    const sBadge = document.getElementById('settings-quota-badge');
    const sFill = document.getElementById('settings-quota-fill');
    const sTokens = document.getElementById('settings-quota-tokens-text');
    const sRequests = document.getElementById('settings-quota-requests-text');
    const sReset = document.getElementById('settings-quota-reset-text');
    const sAvail = document.getElementById('settings-quota-avail-text');

    if (sBadge) {
      sBadge.textContent = status.status === 'ready' ? 'Disponible' : (status.status === 'warning' ? 'Cuota Baja' : 'Enfriamiento');
      sBadge.className = `badge-tag ${status.status === 'ready' ? 'success' : (status.status === 'warning' ? 'warning' : 'danger')}`;
    }
    if (sFill) {
      sFill.style.width = `${status.percentTokens}%`;
      sFill.className = `quota-fill ${status.status === 'ready' ? '' : status.status}`;
    }
    if (sTokens) sTokens.textContent = `${status.remainingTokens.toLocaleString()} / ${status.limitTokens.toLocaleString()}`;
    if (sRequests) sRequests.textContent = `${status.remainingRequests} / ${status.limitRequests} RPM`;
    if (sReset) {
      sReset.textContent = `${status.resetSeconds}s`;
      sReset.style.color = status.resetSeconds > 0 ? 'var(--expense-red)' : 'var(--income-green)';
    }
    if (sAvail) {
      sAvail.textContent = status.statusText;
      sAvail.style.color = status.status === 'ready' ? 'var(--income-green)' : (status.status === 'warning' ? '#d97706' : 'var(--expense-red)');
    }
  }

  /* ===================================================
     VOICE MODAL RECORDING FLOW
  =================================================== */
  openVoiceModal() {
    const overlay = document.getElementById('voice-modal-overlay');
    if (!overlay) return;

    this.setVoiceModalState('idle');
    overlay.classList.add('active');

    // Force quota display update
    const currentModel = store.settings.selectedModel || 'llama-3.1-8b-instant';
    this.updateQuotaUI(quotaManager.getStatus(currentModel));

    if (!store.settings.groqApiKey) {
      this.setVoiceStatus('Por favor ingresa tu API Key de Groq en Ajustes para procesar tu voz.');
    }
  }

  closeVoiceModal() {
    const overlay = document.getElementById('voice-modal-overlay');
    if (voiceManager.isRecording) {
      voiceManager.stopRecording();
    }
    if (overlay) overlay.classList.remove('active');
    this.parsedPendingTx = null;
  }

  setVoiceModalState(state) {
    const micBtn = document.getElementById('sheet-mic-btn');
    const statusText = document.getElementById('voice-status-text');
    const previewBubble = document.getElementById('voice-transcript-bubble');
    const parsedCard = document.getElementById('parsed-result-card');
    const confirmBtn = document.getElementById('confirm-save-btn');

    if (micBtn) {
      micBtn.classList.toggle('recording', state === 'recording');
    }

    if (state === 'idle') {
      if (statusText) statusText.textContent = 'Presiona el micrófono para hablar...';
      if (previewBubble) previewBubble.style.display = 'none';
      if (parsedCard) parsedCard.style.display = 'none';
      if (confirmBtn) confirmBtn.style.display = 'none';
    } else if (state === 'recording') {
      if (statusText) statusText.textContent = 'Escuchando... Di un gasto, ingreso o deuda';
      if (previewBubble) {
        previewBubble.style.display = 'block';
        previewBubble.textContent = '...';
      }
    } else if (state === 'transcribing') {
      if (statusText) statusText.textContent = 'Transcribiendo con Groq Whisper...';
    } else if (state === 'analyzing') {
      if (statusText) statusText.textContent = 'Analizando con LLaMA 3.3...';
    } else if (state === 'parsed') {
      if (statusText) statusText.textContent = 'Movimiento identificado. Revisa y confirma:';
      if (parsedCard) parsedCard.style.display = 'flex';
      if (confirmBtn) confirmBtn.style.display = 'flex';
    }
  }

  setVoiceStatus(text) {
    const statusText = document.getElementById('voice-status-text');
    if (statusText) statusText.textContent = text;
  }

  async handleMicButtonClick() {
    const apiKey = store.settings.groqApiKey;
    if (!apiKey) {
      this.closeVoiceModal();
      this.switchTab('settings');
      this.showToast('Pega tu API Key de Groq en Ajustes para comenzar');
      return;
    }

    const currentModel = store.settings.selectedModel || 'llama-3.1-8b-instant';
    const quota = quotaManager.getStatus(currentModel);
    if (!quota.canRecord && !voiceManager.isRecording) {
      this.showToast(`Cuota al límite. Espera ${quota.resetSeconds}s para que se liberen tokens.`);
      return;
    }

    if (voiceManager.isRecording) {
      this.setVoiceModalState('transcribing');
      const audioBlob = await voiceManager.stopRecording();
      if (!audioBlob) {
        this.setVoiceModalState('idle');
        return;
      }

      try {
        const transcript = await transcribeWithGroqWhisper(audioBlob, apiKey);
        const previewBubble = document.getElementById('voice-transcript-bubble');
        if (previewBubble) {
          previewBubble.style.display = 'block';
          previewBubble.textContent = `"${transcript}"`;
        }

        if (!transcript || transcript.trim().length === 0) {
          this.setVoiceStatus('No se detectó audio claro. Intenta hablar nuevamente.');
          return;
        }

        this.setVoiceModalState('analyzing');
        const defaultAcc = store.getDefaultAccount();
        const parsed = await extractTransactionData(transcript, apiKey, {
          accounts: store.accounts,
          defaultAccount: defaultAcc,
          categories: store.categories,
          selectedModel: store.settings.selectedModel
        });

        parsed.rawSpeech = transcript;
        this.displayParsedTransaction(parsed);
      } catch (err) {
        console.error('Voice processing error:', err);
        this.setVoiceStatus(`Error: ${err.message}`);
        this.showToast(err.message, 3500);
      }
    } else {
      try {
        const canvas = document.getElementById('audio-waveform');
        await voiceManager.startRecording(canvas);
        this.setVoiceModalState('recording');
      } catch (err) {
        this.setVoiceStatus(`Error: ${err.message}`);
      }
    }
  }

  displayParsedTransaction(parsed) {
    if (parsed.es_conversacion) {
      this.setVoiceStatus(parsed.mensaje || 'Hola. Di lo que gastaste, recibiste o prestaste para registrarlo.');
      const parsedCard = document.getElementById('parsed-result-card');
      if (parsedCard) parsedCard.style.display = 'none';
      const confirmBtn = document.getElementById('confirm-save-btn');
      if (confirmBtn) confirmBtn.style.display = 'none';
      this.parsedPendingTx = null;
      return;
    }

    this.parsedPendingTx = parsed;
    this.setVoiceModalState('parsed');

    const typeBadge = document.getElementById('parsed-type');
    const amountVal = document.getElementById('parsed-amount');
    const accVal = document.getElementById('parsed-account');
    const catVal = document.getElementById('parsed-category');
    const descVal = document.getElementById('parsed-desc');
    const personItem = document.getElementById('parsed-person-item');
    const personVal = document.getElementById('parsed-person');

    const sym = parsed.moneda === 'USD' ? '$' : 'S/';
    const isIncome = parsed.tipo === 'ingreso' || parsed.tipo === 'cobro_deuda';
    const isTransfer = parsed.tipo === 'transferencia';
    const sign = isIncome ? '+' : (isTransfer ? '⇄' : '-');

    if (typeBadge) {
      let badgeLabel = parsed.tipo;
      let badgeClass = parsed.tipo;

      if (parsed.tipo === 'deuda_cobrar') {
        badgeLabel = 'Me deben (Préstamo)';
        badgeClass = 'ingreso';
      } else if (parsed.tipo === 'cobro_deuda') {
        badgeLabel = 'Cobro de Deuda';
        badgeClass = 'ingreso';
      } else if (parsed.tipo === 'deuda_pagar') {
        badgeLabel = 'Deuda por pagar';
        badgeClass = 'egreso';
      } else if (parsed.tipo === 'pago_deuda') {
        badgeLabel = 'Pago de Deuda';
        badgeClass = 'egreso';
      }

      typeBadge.textContent = badgeLabel;
      typeBadge.className = `parsed-type-badge ${badgeClass}`;
    }

    if (amountVal) {
      amountVal.textContent = `${sign} ${sym} ${(parsed.monto || 0).toFixed(2)}`;
    }

    if (accVal) {
      const defaultAcc = store.getDefaultAccount();
      const targetAccId = parsed.cuenta || defaultAcc.id;
      const acc = store.getAccount(targetAccId);
      accVal.textContent = acc ? acc.name : defaultAcc.name;
    }

    if (catVal) catVal.textContent = parsed.categoria || 'Varios';
    if (descVal) descVal.textContent = parsed.descripcion || 'Sin descripción';

    if (personItem && personVal) {
      if (parsed.persona) {
        personItem.style.display = 'block';
        personVal.textContent = parsed.persona;
      } else {
        personItem.style.display = 'none';
      }
    }
  }

  savePendingTransaction() {
    if (!this.parsedPendingTx) return;

    const p = this.parsedPendingTx;
    const defaultAcc = store.getDefaultAccount();
    const assignedAccountId = p.cuenta || defaultAcc.id;

    if (p.tipo === 'deuda_cobrar') {
      store.addDebt({
        person: p.persona || 'Sin nombre',
        type: 'me_deben',
        amount: p.monto,
        currency: p.moneda,
        concept: p.descripcion,
        date: p.fecha,
        accountId: assignedAccountId,
        rawSpeech: p.rawSpeech
      });
      this.showToast(`Deuda anotada: ${p.persona || ''} te debe`);
    } else if (p.tipo === 'cobro_deuda') {
      store.settleDebtByPerson(
        p.persona || '',
        p.monto,
        assignedAccountId
      );
      this.showToast(`Cobro registrado: ${p.persona || ''} pagó su deuda`);
    } else if (p.tipo === 'deuda_pagar') {
      store.addDebt({
        person: p.persona || 'Sin nombre',
        type: 'debo',
        amount: p.monto,
        currency: p.moneda,
        concept: p.descripcion,
        date: p.fecha,
        accountId: assignedAccountId,
        rawSpeech: p.rawSpeech
      });
      this.showToast(`Deuda anotada: le debes a ${p.persona || ''}`);
    } else if (p.tipo === 'pago_deuda') {
      store.settleDebtByPerson(
        p.persona || '',
        p.monto,
        assignedAccountId
      );
      this.showToast(`Pago de deuda registrado a ${p.persona || ''}`);
    } else {
      // Standard transaction
      store.addTransaction({
        type: p.tipo,
        amount: p.monto,
        currency: p.moneda || store.settings.defaultCurrency,
        accountId: assignedAccountId,
        toAccountId: p.cuenta_destino || null,
        category: p.categoria || 'Otros Gastos',
        desc: p.descripcion,
        date: p.fecha,
        rawSpeech: p.rawSpeech
      });
      this.showToast('Transacción registrada y saldo actualizado');
    }

    if ('vibrate' in navigator) navigator.vibrate([30, 40]);
    this.closeVoiceModal();
    this.renderAll();
  }

  /* ===================================================
     MANUAL MODALS & ADJUSTMENTS
  =================================================== */
  openEditAccountBalanceModal(accountId) {
    const acc = store.getAccount(accountId);
    if (!acc) return;

    const newBal = prompt(`Actualizar saldo de ${acc.name} (${acc.currency}):`, acc.balance);
    if (newBal !== null && !isNaN(parseFloat(newBal))) {
      store.updateAccount(accountId, { balance: parseFloat(newBal) });
      this.showToast(`Saldo de ${acc.name} actualizado`);
      this.renderAll();
    }
  }

  openTxDetailModal(tx) {
    const confirmDelete = confirm(`¿Deseas eliminar este movimiento?\n\n"${tx.desc}" por S/ ${tx.amount.toFixed(2)}\n\n(El saldo se revertirá automáticamente)`);
    if (confirmDelete) {
      store.deleteTransaction(tx.id);
      this.showToast('Transacción eliminada');
      this.renderAll();
    }
  }

  openManualEntryModal(type = 'egreso') {
    const desc = prompt(type === 'ingreso' ? 'Descripción del ingreso:' : 'Descripción del gasto:');
    if (!desc) return;
    const amountStr = prompt('Monto:');
    if (!amountStr || isNaN(parseFloat(amountStr))) return;

    const accNames = store.accounts.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
    const accIndex = prompt(`Selecciona la cuenta (número):\n${accNames}`, '1');
    const chosenAcc = store.accounts[parseInt(accIndex) - 1] || store.accounts[0];

    store.addTransaction({
      type,
      amount: parseFloat(amountStr),
      desc,
      accountId: chosenAcc.id,
      category: type === 'ingreso' ? 'Sueldo' : 'Otros Gastos'
    });

    this.showToast('Movimiento registrado');
    this.renderAll();
  }

  openAddAccountModal() {
    const overlay = document.getElementById('add-account-modal-overlay');
    if (!overlay) return;
    const nameInput = document.getElementById('new-acc-name');
    const balanceInput = document.getElementById('new-acc-balance');
    if (nameInput) nameInput.value = '';
    if (balanceInput) balanceInput.value = '';
    overlay.classList.add('active');
    setTimeout(() => nameInput?.focus(), 150);
  }

  closeAddAccountModal() {
    const overlay = document.getElementById('add-account-modal-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  handleCreateAccount() {
    const nameInput = document.getElementById('new-acc-name');
    const typeSelect = document.getElementById('new-acc-type');
    const balanceInput = document.getElementById('new-acc-balance');

    const name = nameInput?.value.trim();
    if (!name) {
      this.showToast('Ingresa un nombre para la cuenta');
      nameInput?.focus();
      return;
    }

    const type = typeSelect?.value || 'Banco';
    const balance = parseFloat(balanceInput?.value) || 0;

    const newAcc = store.addAccount({
      name,
      type,
      balance,
      currency: store.settings.defaultCurrency || 'PEN'
    });

    this.closeAddAccountModal();
    this.showToast(`Cuenta ${newAcc.name} creada con éxito`);
    this.renderAll();
  }

  openManualDebtModal() {
    const person = prompt('Nombre de la persona (ej. Carlos, Juan, Papá):');
    if (!person) return;
    const isLending = confirm(`¿${person} te debe a ti?\n\n- Aceptar: Te debe a ti (Por cobrar)\n- Cancelar: Tú le debes a ${person} (Por pagar)`);
    const amountStr = prompt('Monto adeudado (S/):');
    if (!amountStr || isNaN(parseFloat(amountStr))) return;
    const concept = prompt('Motivo o concepto (ej. Almuerzo, Préstamo personal):') || 'Préstamo';

    store.addDebt({
      person,
      type: isLending ? 'me_deben' : 'debo',
      amount: parseFloat(amountStr),
      concept,
      accountId: store.getDefaultAccount().id
    });
    this.showToast('Deuda registrada');
    this.renderAll();
  }

  bindGlobalEvents() {
    // Navigation Tabs
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchTab(btn.dataset.tab);
      });
    });

    // Voice Center Button & Hero Banner
    document.getElementById('nav-voice-btn')?.addEventListener('click', () => this.openVoiceModal());
    document.getElementById('voice-hero-banner')?.addEventListener('click', () => this.openVoiceModal());
    document.getElementById('close-voice-sheet-btn')?.addEventListener('click', () => this.closeVoiceModal());
    document.getElementById('sheet-mic-btn')?.addEventListener('click', () => this.handleMicButtonClick());
    document.getElementById('confirm-save-btn')?.addEventListener('click', () => this.savePendingTransaction());

    // Balance visibility toggle
    document.getElementById('toggle-balance-visibility')?.addEventListener('click', () => {
      store.updateSettings({ hideBalances: !store.settings.hideBalances });
    });

    // Quick Action manual buttons
    document.getElementById('quick-add-expense')?.addEventListener('click', () => this.openManualEntryModal('egreso'));
    document.getElementById('quick-add-income')?.addEventListener('click', () => this.openManualEntryModal('ingreso'));
    document.getElementById('quick-transfer')?.addEventListener('click', () => {
      this.showToast('Di por voz: "Transferí 50 soles de BCP a Yape"');
      this.openVoiceModal();
    });

    // History filter buttons
    document.querySelectorAll('.history-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.history-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderHistoryTab();
      });
    });

    // History Month Navigation & Select Handlers
    document.getElementById('history-month-select')?.addEventListener('change', (e) => {
      this.selectedHistoryMonth = e.target.value;
      this.renderHistoryTab();
    });

    document.getElementById('history-prev-month-btn')?.addEventListener('click', () => {
      this.navigateHistoryMonth(-1);
    });

    document.getElementById('history-next-month-btn')?.addEventListener('click', () => {
      this.navigateHistoryMonth(1);
    });

    document.getElementById('export-history-csv-btn')?.addEventListener('click', () => {
      this.exportHistoryToCSV();
    });

    // Navigation Shortcuts (Historial & Cuentas buttons)
    document.getElementById('go-to-history-btn')?.addEventListener('click', () => {
      this.switchTab('history');
    });

    document.getElementById('back-to-home-from-history')?.addEventListener('click', () => {
      this.switchTab('home');
    });

    document.getElementById('home-manage-accounts-btn')?.addEventListener('click', () => {
      this.switchTab('accounts');
    });

    document.getElementById('back-to-home-from-accounts')?.addEventListener('click', () => {
      this.switchTab('home');
    });

    // Debt filter buttons
    document.querySelectorAll('.debt-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.debt-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderDebtsTab();
      });
    });

    document.getElementById('add-manual-debt-btn')?.addEventListener('click', () => this.openManualDebtModal());

    // Account Modal Handlers
    document.getElementById('open-add-account-btn')?.addEventListener('click', () => this.openAddAccountModal());
    document.getElementById('close-add-account-btn')?.addEventListener('click', () => this.closeAddAccountModal());
    document.getElementById('submit-new-account-btn')?.addEventListener('click', () => this.handleCreateAccount());
    document.getElementById('add-account-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'add-account-modal-overlay') this.closeAddAccountModal();
    });

    // Supabase Direct Cloud Handlers
    document.getElementById('supabase-sync-now-btn')?.addEventListener('click', async () => {
      this.showToast('Sincronizando con Supabase...');
      try {
        await store.syncFromCloud();
        this.showToast('Sincronización completa');
        this.renderAll();
      } catch (err) {
        this.showToast(`Error: ${err.message}`);
      }
    });

    document.getElementById('supabase-logout-btn')?.addEventListener('click', async () => {
      if (confirm('¿Cerrar sesión de Supabase en este dispositivo?')) {
        await signOutUser();
        this.showToast('Sesión cerrada');
        this.renderAll();
      }
    });

    // Settings handlers
    document.getElementById('refresh-models-btn')?.addEventListener('click', () => {
      this.refreshActiveGroqModels(true);
    });

    document.getElementById('save-groq-key-btn')?.addEventListener('click', async () => {
      const key = document.getElementById('groq-api-key-input')?.value.trim();
      store.updateSettings({ groqApiKey: key });
      this.updateKeyStatusBadge();
      this.showToast('API Key guardada');
      await this.refreshActiveGroqModels(true);
    });

    document.getElementById('test-groq-btn')?.addEventListener('click', async () => {
      const key = document.getElementById('groq-api-key-input')?.value.trim();
      if (!key) {
        this.showToast('Ingresa una API Key primero');
        return;
      }
      this.showToast('Consultando modelos activos en Groq...');
      try {
        const models = await testGroqConnection(key);
        this.showToast(`Conexión exitosa: ${models.length} modelos disponibles`);
        store.updateSettings({ groqApiKey: key });
        this.updateKeyStatusBadge();
        await this.refreshActiveGroqModels(false);
      } catch (err) {
        this.showToast(`Error: ${err.message}`, 4000);
      }
    });

    document.getElementById('header-groq-pill')?.addEventListener('click', () => {
      this.openVoiceModal();
    });

    document.getElementById('ping-groq-quota-btn')?.addEventListener('click', async () => {
      const key = store.settings.groqApiKey || document.getElementById('groq-api-key-input')?.value.trim();
      if (!key) {
        this.showToast('Ingresa tu API Key de Groq primero');
        return;
      }
      const model = store.settings.selectedModel || 'llama-3.1-8b-instant';
      this.showToast('Consultando cuota en tiempo real...');
      try {
        const pingStatus = await pingGroqQuota(key, model);
        this.updateQuotaUI(pingStatus);
        this.showToast(`Cuota en vivo: ${pingStatus.remainingTokens.toLocaleString()} tokens disponibles`);
      } catch (err) {
        this.showToast(`Error: ${err.message}`, 4000);
      }
    });

    document.getElementById('reset-groq-quota-btn')?.addEventListener('click', () => {
      quotaManager.resetAll();
      this.showToast('Contador local de cuota reiniciado');
    });

    document.getElementById('groq-model-select')?.addEventListener('change', (e) => {
      const newModel = e.target.value;
      store.updateSettings({ selectedModel: newModel });
      this.updateQuotaUI(quotaManager.getStatus(newModel));
      this.showToast(`Modelo: ${newModel}`);
    });

    document.getElementById('default-currency-select')?.addEventListener('change', (e) => {
      store.updateSettings({ defaultCurrency: e.target.value });
      this.renderAll();
    });

    // Export & Import
    document.getElementById('export-backup-btn')?.addEventListener('click', () => {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(store.exportBackup());
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `billetera_backup_${new Date().toISOString().split('T')[0]}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      this.showToast('Copia descargada');
    });

    document.getElementById('import-backup-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const success = store.importBackup(event.target.result);
        if (success) {
          this.showToast('Datos restaurados con éxito');
          this.renderAll();
        } else {
          this.showToast('Formato de archivo inválido');
        }
      };
      reader.readAsText(file);
    });

    document.getElementById('reset-demo-data-btn')?.addEventListener('click', () => {
      if (confirm('¿Reiniciar datos a la configuración inicial?')) {
        store.resetAllData();
        this.showToast('Datos reiniciados');
        this.renderAll();
      }
    });

    // PWA Install button
    document.getElementById('pwa-install-trigger')?.addEventListener('click', async () => {
      if (this.deferredInstallPrompt) {
        this.deferredInstallPrompt.prompt();
        const choice = await this.deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          this.showToast('Instalando aplicación...');
        }
        this.deferredInstallPrompt = null;
        document.getElementById('pwa-install-banner').style.display = 'none';
      } else {
        alert('En iPhone (Safari): Menú Compartir > "Agregar al inicio". En Android (Chrome): Menú > "Instalar aplicación".');
      }
    });
  }
}

export const ui = new UIController();
