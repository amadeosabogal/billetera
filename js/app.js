/**
 * Application Entry Point - Service Worker Registration & Initialization
 */
import { ui } from './ui.js';
import { store } from './store.js';
import { supabase } from './supabase.js';

document.addEventListener('DOMContentLoaded', () => {
  // Initialize UI controller
  ui.init();

  // Listen to Supabase Auth state changes (Magic link redirects, logins, token verifications)
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      console.log('Autenticado en Supabase:', session.user.email);
      if (window.location.hash || window.location.search.includes('code=')) {
        window.history.replaceState(null, '', window.location.pathname);
      }
      await store.syncFromCloud();
      ui.renderAll();
      ui.showToast(`¡Sesión iniciada como ${session.user.email}!`);
    } else if (event === 'SIGNED_OUT') {
      ui.renderAll();
    }
  });

  // Handle URL shortcut actions (e.g. from PWA shortcut)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('action') === 'voice') {
    setTimeout(() => {
      ui.openVoiceModal();
    }, 400);
  } else if (urlParams.get('tab')) {
    ui.switchTab(urlParams.get('tab'));
  }

  // Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => {
          console.log('Service Worker registered with scope:', reg.scope);
        })
        .catch(err => {
          console.warn('Service Worker registration failed:', err);
        });
    });
  }

  // Network connection listener
  const updateOnlineStatus = () => {
    const dot = document.getElementById('connection-status-dot');
    const label = document.getElementById('connection-status-label');
    if (dot && label) {
      if (navigator.onLine) {
        dot.className = 'status-dot';
        label.textContent = 'En línea';
      } else {
        dot.className = 'status-dot offline';
        label.textContent = 'Sin conexión';
      }
    }
  };

  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();
});
