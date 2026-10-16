/**
 * Groq AI Quota & Rate Limit Manager
 * Tracks Tokens Per Minute (TPM), Requests Per Minute (RPM), reset countdowns,
 * and real-time availability to inform the user exactly when they can record.
 */

export const GROQ_MODEL_QUOTAS = {
  'llama-3.1-8b-instant': {
    name: 'LLaMA 3.1 8B Instant',
    tpm: 6000,
    rpm: 30,
    minTokensForTx: 350
  },
  'openai/gpt-oss-20b': {
    name: 'GPT-OSS 20B',
    tpm: 8000,
    rpm: 30,
    minTokensForTx: 350
  },
  'openai/gpt-oss-120b': {
    name: 'GPT-OSS 120B',
    tpm: 8000,
    rpm: 30,
    minTokensForTx: 350
  },
  'llama-3.3-70b-versatile': {
    name: 'LLaMA 3.3 70B Versatile',
    tpm: 6000,
    rpm: 30,
    minTokensForTx: 350
  },
  'qwen/qwen3.8-27b': {
    name: 'Qwen 3.8 27B',
    tpm: 6000,
    rpm: 30,
    minTokensForTx: 350
  }
};

const DEFAULT_QUOTA = {
  name: 'Modelo Groq',
  tpm: 6000,
  rpm: 30,
  minTokensForTx: 350
};

class QuotaManager {
  constructor() {
    this.storageKey = 'billetera_groq_quota_v1';
    this.listeners = new Set();
    this.timer = null;

    this.state = this.loadState();
    this.startTicker();
  }

  loadState() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(this.storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          return {
            history: Array.isArray(parsed.history) ? parsed.history : [],
            lockouts: parsed.lockouts || {},
            headersInfo: parsed.headersInfo || null
          };
        }
      }
    } catch (e) {
      console.warn('Error al cargar estado de cuota de Groq:', e);
    }
    return {
      history: [],
      lockouts: {},
      headersInfo: null
    };
  }

  saveState() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.storageKey, JSON.stringify(this.state));
      }
    } catch (e) {
      console.warn('Error al guardar estado de cuota:', e);
    }
  }

  startTicker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
  }

  tick() {
    this.cleanOldEntries();
    this.notify();
  }

  cleanOldEntries() {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const initialLen = this.state.history.length;
    this.state.history = this.state.history.filter(item => (now - item.timestamp) < windowMs);

    // Clean expired lockouts
    let lockoutsChanged = false;
    for (const [model, exp] of Object.entries(this.state.lockouts)) {
      if (now >= exp) {
        delete this.state.lockouts[model];
        lockoutsChanged = true;
      }
    }

    if (initialLen !== this.state.history.length || lockoutsChanged) {
      this.saveState();
    }
  }

  getQuotaConfig(model) {
    if (!model) return DEFAULT_QUOTA;
    return GROQ_MODEL_QUOTAS[model] || {
      name: model.split('/').pop(),
      tpm: 6000,
      rpm: 30,
      minTokensForTx: 350
    };
  }

  recordUsage(model, tokens, headers = null) {
    const now = Date.now();
    const tokenCount = typeof tokens === 'number' && tokens > 0 ? tokens : 350;

    this.state.history.push({
      timestamp: now,
      tokens: tokenCount,
      model: model || 'llama-3.1-8b-instant'
    });

    if (headers) {
      try {
        const remTokens = headers.get?.('x-ratelimit-remaining-tokens') || headers['x-ratelimit-remaining-tokens'];
        const limTokens = headers.get?.('x-ratelimit-limit-tokens') || headers['x-ratelimit-limit-tokens'];
        const resTokens = headers.get?.('x-ratelimit-reset-tokens') || headers['x-ratelimit-reset-tokens'];
        const remReq = headers.get?.('x-ratelimit-remaining-requests') || headers['x-ratelimit-remaining-requests'];
        const limReq = headers.get?.('x-ratelimit-limit-requests') || headers['x-ratelimit-limit-requests'];

        if (remTokens !== null && remTokens !== undefined) {
          this.state.headersInfo = {
            remainingTokens: parseInt(remTokens, 10),
            limitTokens: limTokens ? parseInt(limTokens, 10) : null,
            resetTokensStr: resTokens,
            remainingRequests: remReq ? parseInt(remReq, 10) : null,
            limitRequests: limReq ? parseInt(limReq, 10) : null,
            updatedAt: now
          };
        }
      } catch (err) {
        console.warn('No se pudieron leer cabeceras de cuota Groq:', err);
      }
    }

    this.cleanOldEntries();
    this.saveState();
    this.notify();
  }

  recordLockout(model, waitSeconds = 5, reason = '') {
    const now = Date.now();
    const safeWait = Math.max(1, Math.min(60, Number(waitSeconds) || 5));
    const lockoutUntil = now + (safeWait * 1000);

    const mKey = model || 'default';
    this.state.lockouts[mKey] = lockoutUntil;

    this.saveState();
    this.notify();
  }

  /**
   * Return real-time status for the given model
   */
  getStatus(model = 'llama-3.1-8b-instant') {
    this.cleanOldEntries();
    const now = Date.now();
    const config = this.getQuotaConfig(model);

    // Calculate tokens and requests used in last 60 seconds
    const mHistory = this.state.history.filter(item => !item.model || item.model === model);
    const usedTokens = mHistory.reduce((sum, item) => sum + item.tokens, 0);
    const usedRequests = mHistory.length;

    // Remaining capacity
    const limitTokens = (this.state.headersInfo && this.state.headersInfo.limitTokens) || config.tpm;
    const remainingTokens = Math.max(0, limitTokens - usedTokens);

    const limitRequests = (this.state.headersInfo && this.state.headersInfo.limitRequests) || config.rpm;
    const remainingRequests = Math.max(0, limitRequests - usedRequests);

    // Check lockout
    const mLockout = this.state.lockouts[model] || this.state.lockouts['default'] || 0;
    const isLockedOut = now < mLockout;
    const lockoutSecondsRemaining = isLockedOut ? Math.ceil((mLockout - now) / 1000) : 0;

    // Time until oldest consumption expires and frees tokens
    let secondsUntilOldestFreed = 0;
    if (mHistory.length > 0) {
      const oldest = mHistory[0];
      const elapsed = now - oldest.timestamp;
      secondsUntilOldestFreed = Math.max(0, Math.ceil((60000 - elapsed) / 1000));
    }

    const resetSeconds = isLockedOut ? lockoutSecondsRemaining : secondsUntilOldestFreed;

    // Evaluate availability
    let canRecord = true;
    let status = 'ready'; // ready | warning | cooldown
    let statusText = 'Disponible para registrar';

    if (isLockedOut) {
      canRecord = false;
      status = 'cooldown';
      statusText = `Pausa de cuota: espera ${lockoutSecondsRemaining}s`;
    } else if (remainingTokens < config.minTokensForTx || remainingRequests <= 0) {
      canRecord = false;
      status = 'cooldown';
      statusText = `Cuota al límite: espera ${resetSeconds}s`;
    } else if (remainingTokens < config.minTokensForTx * 2) {
      canRecord = true;
      status = 'warning';
      statusText = `Pocos tokens (${remainingTokens} disp.)`;
    }

    const percentTokens = Math.max(0, Math.min(100, Math.round((remainingTokens / limitTokens) * 100)));

    return {
      model,
      modelName: config.name,
      canRecord,
      status, // 'ready' | 'warning' | 'cooldown'
      statusText,
      remainingTokens,
      limitTokens,
      usedTokens,
      percentTokens,
      remainingRequests,
      limitRequests,
      usedRequests,
      resetSeconds
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    // Initial call
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.getStatus());
      } catch (e) {
        console.error('Error in quota listener:', e);
      }
    }
  }

  resetAll() {
    this.state = {
      history: [],
      lockouts: {},
      headersInfo: null
    };
    this.saveState();
    this.notify();
  }
}

export const quotaManager = new QuotaManager();
