import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://hypuboxghqukxphgwgqb.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh5cHVib3hnaHF1a3hwaGd3Z3FiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwOTQ5MjgsImV4cCI6MjEwNzY3MDkyOH0.eHj3V5IJVFzAs5uBHoJJRHJiSycp3veS9qoT3_S2pCI';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

let realtimeChannel = null;

/**
 * Authentication helpers (Passwordless Email OTP / Magic Link)
 */
export async function sendOtpEmail(email) {
  const cleanEmail = email.trim();
  const redirectTo = window.location.origin + window.location.pathname;
  const { data, error } = await supabase.auth.signInWithOtp({
    email: cleanEmail,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: redirectTo
    }
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function verifyOtpToken(email, token) {
  const cleanEmail = email ? email.trim() : '';
  const cleanToken = token ? token.trim() : '';

  // If user pasted the redirect URL, hash fragment, or access_token
  if (cleanToken.includes('access_token=') || cleanToken.includes('#') || cleanToken.startsWith('http')) {
    const hashPart = cleanToken.includes('#') ? cleanToken.split('#')[1] : cleanToken;
    const params = new URLSearchParams(hashPart.replace(/^\?/, ''));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (accessToken && refreshToken) {
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (error) throw new Error(error.message);
      return data;
    }
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email: cleanEmail,
    token: cleanToken,
    type: 'email'
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function signOutUser() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function getCurrentSessionUser() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user || null;
}

/**
 * Cloud Data Sync (Direct Anon Key & Authenticated support)
 */
export async function fetchCloudData() {
  try {
    const user = await getCurrentSessionUser();

    // 1. Fetch Accounts
    const { data: accounts, error: accErr } = await supabase
      .from('accounts')
      .select('*')
      .order('created_at', { ascending: true });

    if (accErr) {
      console.error('Error fetching accounts from Supabase:', accErr);
      throw accErr;
    }

    // If user has no accounts yet in DB, ensure Interbank primary account is created
    let finalAccounts = accounts || [];
    if (finalAccounts.length === 0) {
      const { data: newIbk, error: createErr } = await supabase
        .from('accounts')
        .insert({
          user_id: user?.id || null,
          name: 'Interbank',
          code: 'IBK',
          type: 'Banco',
          balance: 0.00,
          currency: 'PEN',
          is_default: true
        })
        .select()
        .single();

      if (!createErr && newIbk) {
        finalAccounts = [newIbk];
      }
    }

    // 2. Fetch Transactions
    const { data: transactions, error: txErr } = await supabase
      .from('transactions')
      .select('*')
      .order('date', { ascending: false })
      .order('time', { ascending: false });

    if (txErr) console.error('Error fetching transactions:', txErr);

    // 3. Fetch Debts
    const { data: debts, error: debtsErr } = await supabase
      .from('debts')
      .select('*')
      .order('created_at', { ascending: false });

    if (debtsErr) console.error('Error fetching debts:', debtsErr);

    return {
      accounts: finalAccounts.map(a => ({
        id: a.id,
        name: a.name,
        code: a.code,
        type: a.type,
        balance: parseFloat(a.balance) || 0,
        currency: a.currency,
        isDefault: a.is_default
      })),
      transactions: (transactions || []).map(t => ({
        id: t.id,
        date: t.date,
        time: t.time,
        type: t.type,
        amount: parseFloat(t.amount) || 0,
        currency: t.currency,
        accountId: t.account_id,
        toAccountId: t.to_account_id,
        category: t.category,
        desc: t.description,
        rawSpeech: t.raw_speech || ''
      })),
      debts: (debts || []).map(d => ({
        id: d.id,
        person: d.person,
        type: d.type,
        amount: parseFloat(d.amount) || 0,
        balance: parseFloat(d.balance) || 0,
        currency: d.currency,
        concept: d.concept,
        date: d.date,
        status: d.status,
        accountId: d.account_id
      }))
    };
  } catch (err) {
    console.error('Error in fetchCloudData:', err);
    return null;
  }
}

/**
 * Push new transaction to Supabase
 */
export async function pushTransactionToCloud(tx) {
  try {
    const user = await getCurrentSessionUser();
    const payload = {
      id: (tx.id && !tx.id.startsWith('tx_')) ? tx.id : undefined,
      user_id: user?.id || null,
      account_id: tx.accountId,
      to_account_id: tx.toAccountId || null,
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      category: tx.category,
      description: tx.desc,
      date: tx.date,
      time: tx.time,
      raw_speech: tx.rawSpeech || ''
    };

    const { data, error } = await supabase.from('transactions').insert(payload).select().single();
    if (error) console.error('Error saving transaction in Supabase:', error);

    // Update account balance in cloud
    if (tx.accountId) {
      const { data: acc } = await supabase.from('accounts').select('balance').eq('id', tx.accountId).single();
      if (acc) {
        let newBal = parseFloat(acc.balance) || 0;
        if (tx.type === 'egreso') newBal -= tx.amount;
        if (tx.type === 'ingreso') newBal += tx.amount;
        if (tx.type === 'transferencia') newBal -= tx.amount;
        await supabase.from('accounts').update({ balance: newBal }).eq('id', tx.accountId);
      }
    }

    return data;
  } catch (e) {
    console.error('pushTransactionToCloud error:', e);
    return null;
  }
}

/**
 * Delete transaction in Supabase and revert balance
 */
export async function deleteTransactionInCloud(tx) {
  try {
    await supabase.from('transactions').delete().eq('id', tx.id);

    if (tx.accountId) {
      const { data: acc } = await supabase.from('accounts').select('balance').eq('id', tx.accountId).single();
      if (acc) {
        let newBal = parseFloat(acc.balance) || 0;
        if (tx.type === 'egreso') newBal += tx.amount;
        if (tx.type === 'ingreso') newBal -= tx.amount;
        await supabase.from('accounts').update({ balance: newBal }).eq('id', tx.accountId);
      }
    }
  } catch (e) {
    console.error('deleteTransactionInCloud error:', e);
  }
}

/**
 * Push debt to Supabase
 */
export async function pushDebtToCloud(debt) {
  try {
    const user = await getCurrentSessionUser();
    const payload = {
      id: (debt.id && !debt.id.startsWith('debt_')) ? debt.id : undefined,
      user_id: user?.id || null,
      person: debt.person,
      type: debt.type,
      amount: debt.amount,
      balance: debt.balance,
      currency: debt.currency,
      concept: debt.concept,
      date: debt.date,
      status: debt.status,
      account_id: debt.accountId || null
    };

    const { data, error } = await supabase.from('debts').insert(payload).select().single();
    if (error) console.error('Error saving debt in Supabase:', error);
    return data;
  } catch (e) {
    console.error('pushDebtToCloud error:', e);
    return null;
  }
}

/**
 * Settle debt in Supabase
 */
export async function updateDebtInCloud(debtId, balance, status) {
  try {
    await supabase.from('debts').update({
      balance: balance,
      status: status
    }).eq('id', debtId);
  } catch (e) {
    console.error('updateDebtInCloud error:', e);
  }
}

/**
 * Push account updates to Supabase
 */
export async function pushAccountToCloud(account) {
  try {
    const user = await getCurrentSessionUser();
    const payload = {
      user_id: user?.id || null,
      name: account.name,
      code: account.code,
      type: account.type,
      balance: account.balance,
      currency: account.currency,
      is_default: account.isDefault || false
    };

    const { data, error } = await supabase.from('accounts').insert(payload).select().single();
    if (error) console.error('Error saving account in Supabase:', error);
    return data;
  } catch (e) {
    console.error('pushAccountToCloud error:', e);
    return null;
  }
}

export async function updateAccountBalanceInCloud(accountId, newBalance) {
  try {
    await supabase.from('accounts').update({ balance: newBalance }).eq('id', accountId);
  } catch (e) {
    console.error('updateAccountBalanceInCloud error:', e);
  }
}

export async function deleteAccountInCloud(accountId) {
  try {
    await supabase.from('accounts').delete().eq('id', accountId);
  } catch (e) {
    console.error('deleteAccountInCloud error:', e);
  }
}

/**
 * Realtime Subscription for multi-device live sync
 */
export function setupRealtimeSync(onUpdateCallback) {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabase
    .channel('billetera_realtime_sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
      onUpdateCallback('transactions');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'debts' }, () => {
      onUpdateCallback('debts');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, () => {
      onUpdateCallback('accounts');
    })
    .subscribe();

  return realtimeChannel;
}

/**
 * Call the Supabase Edge Function (/process-voice) for secure server-side processing
 */
export async function processVoiceWithEdgeFunction(audioBlob) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Debes iniciar sesión con tu correo para usar la función de voz en la nube.');

  const formData = new FormData();
  const ext = audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
  formData.append('file', audioBlob, `voice.${ext}`);

  const { data, error } = await supabase.functions.invoke('process-voice', {
    body: formData,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (error) {
    throw new Error(error.message || 'Error en Edge Function process-voice');
  }

  return data;
}
