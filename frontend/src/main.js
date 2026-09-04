import { io } from 'socket.io-client';
import { zipSync } from 'fflate';
import {
  generateDeviceKeypair,
  importPrivateKey,
  importPublicKey,
  deriveConversationKey,
  encryptText,
  decryptText,
} from './crypto.js';

// ============================================================
// Boot splash: covers the app until we know whether to show the name
// prompt or jump straight into a reconnected session. Hidden as soon as
// there's something meaningful to look at (name prompt, or first data from
// the backend) — never blocks longer than a few seconds even if the
// backend is unreachable, since the header's own connection indicator
// takes over from there.
// ============================================================
const bootSplash = document.getElementById('bootSplash');
const bootStatus = document.getElementById('bootStatus');
let bootSplashHidden = false;
function hideBootSplash() {
  if (bootSplashHidden) return;
  bootSplashHidden = true;
  bootSplash.classList.add('hidden');
  setTimeout(() => bootSplash.remove(), 400);
}
function setBootStatus(text) {
  if (bootStatus) bootStatus.textContent = text;
}
// Safety net: don't leave the person staring at the splash forever if the
// backend never responds — the connection banner in the header explains
// what's going on from here.
setTimeout(hideBootSplash, 6000);

// ============================================================
// Toasts
// ============================================================
const toastHost = document.getElementById('toastHost');
function showToast(message, kind = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// A toast with an inline action button (e.g. "Turn on notifications?" → Enable),
// instead of just an FYI message. Stays up until the person acts or dismisses it.
function showActionToast(message, actionLabel, onAction, onDismiss) {
  const el = document.createElement('div');
  el.className = 'toast toast-info toast-action';
  const text = document.createElement('span');
  text.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'toast-action-buttons';
  const actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  actionBtn.className = 'toast-action-btn';
  actionBtn.textContent = actionLabel;
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'toast-dismiss-btn';
  dismissBtn.textContent = 'Not now';
  actions.append(actionBtn, dismissBtn);
  el.append(text, actions);
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  function remove() {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }
  actionBtn.addEventListener('click', () => { remove(); onAction?.(); });
  dismissBtn.addEventListener('click', () => { remove(); onDismiss?.(); });
}

// ============================================================
// Theme: Light / Dark / System (default). Applied via a `data-theme` attribute
// on <html>, which style.css keys off of. "System" tracks the OS preference
// live (no reload needed if the OS theme flips while the tab is open).
// ============================================================
const THEME_KEY = 'lan-share-theme';
let theme = localStorage.getItem(THEME_KEY) || 'system';
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme() {
  const resolved = theme === 'system' ? (systemThemeQuery.matches ? 'light' : 'dark') : theme;
  document.documentElement.setAttribute('data-theme', resolved);
  document.querySelectorAll('.theme-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}
function setTheme(next) {
  theme = next;
  localStorage.setItem(THEME_KEY, theme);
  applyTheme();
}
systemThemeQuery.addEventListener('change', () => {
  if (theme === 'system') applyTheme();
});
applyTheme();

document.getElementById('themeRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-option');
  if (btn) setTheme(btn.dataset.theme);
});

// ============================================================
// Notifications: Notification API-based (no external push service needed,
// which matters here since this app is meant to run over plain HTTP on a
// LAN address rather than a publicly reachable HTTPS host). An explicit
// enable/disable toggle in Settings drives whether we ever ask, and whether
// we actually surface anything once permission is granted.
// ============================================================
const NOTIF_PREF_KEY = 'lan-share-notifications';
const NOTIF_ASKED_KEY = 'lan-share-notifications-asked';
const notifToggleBtn = document.getElementById('notifToggleBtn');
const notifStatusText = document.getElementById('notifStatusText');
const notifStatusLabel = document.getElementById('notifStatusLabel');
const notifHint = document.getElementById('notifHint');
const notificationsSupported = 'Notification' in window;
const faviconLink = document.querySelector('link[rel="icon"]');
let notificationsEnabled = localStorage.getItem(NOTIF_PREF_KEY) === 'on'
  && notificationsSupported
  && Notification.permission === 'granted';

function makeUnreadFavicon(count) {
  const safeCount = Math.min(count, 99);
  const label = safeCount >= 99 ? '99+' : String(safeCount);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#0f766e"/>
      <path d="M16 27a23 23 0 0 1 32 0M22 34a14 14 0 0 1 20 0M29 41a5 5 0 0 1 6 0" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
      <circle cx="32" cy="49" r="3" fill="#fff"/>
      <circle cx="50" cy="14" r="12" fill="#ef4444"/>
      <text x="50" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" font-family="Arial, sans-serif">${label}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function updateTabBadge() {
  const count = unreadConversations.size;
  document.title = count > 0 ? `(${count}) LAN Chat` : 'LAN Chat';
  if (faviconLink) {
    faviconLink.href = count > 0 ? makeUnreadFavicon(count) : '/favicon.svg';
  }
}

function updateNotifUI() {
  if (!notificationsSupported) {
    notifStatusLabel.textContent = 'Not supported in this browser';
    notifToggleBtn.classList.add('hidden');
    notifHint.textContent = 'This browser does not support desktop notifications.';
    return;
  }
  if (Notification.permission === 'denied') {
    notifStatusLabel.textContent = 'Blocked in browser settings';
    notifToggleBtn.classList.add('hidden');
    notifHint.textContent = 'Notifications were blocked for this site — re-enable them from your browser\'s site settings.';
    return;
  }
  notifToggleBtn.classList.remove('hidden');
  notifStatusLabel.textContent = notificationsEnabled ? 'Notifications are on' : 'Notifications are off';
  notifToggleBtn.textContent = notificationsEnabled ? 'Disable' : 'Enable';
  notifToggleBtn.classList.toggle('on', notificationsEnabled);
  notifHint.textContent = "Get notified about new messages when this tab isn't focused.";
}
updateNotifUI();

async function requestNotificationPermission() {
  if (!notificationsSupported) return false;
  localStorage.setItem(NOTIF_ASKED_KEY, '1');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission === 'granted') {
    notificationsEnabled = true;
    localStorage.setItem(NOTIF_PREF_KEY, 'on');
  } else {
    notificationsEnabled = false;
    localStorage.setItem(NOTIF_PREF_KEY, 'off');
    if (permission === 'denied') showToast('Notifications were blocked by the browser.', 'error');
  }
  updateNotifUI();
  return permission === 'granted';
}

notifToggleBtn.addEventListener('click', async () => {
  if (!notificationsSupported) return;
  if (notificationsEnabled) {
    notificationsEnabled = false;
    localStorage.setItem(NOTIF_PREF_KEY, 'off');
    updateNotifUI();
    return;
  }
  await requestNotificationPermission();
});

// Proactive nudge: if notifications are supported and the browser hasn't been asked
// yet (and hasn't already been explicitly turned off), offer to turn them on rather
// than leaving it buried in Settings. Shown once per page load, a couple seconds in
// so it doesn't compete with the initial connect/join flow.
function maybeOfferNotifications() {
  if (!notificationsSupported) return;
  if (Notification.permission !== 'default') return; // already granted or denied — nothing to ask
  if (localStorage.getItem(NOTIF_ASKED_KEY)) return; // already asked this browser before
  showActionToast(
    'Turn on notifications for new messages?',
    'Enable',
    async () => { await requestNotificationPermission(); },
    () => { localStorage.setItem(NOTIF_ASKED_KEY, '1'); }
  );
}

function notifyIncomingMessage(msg, conversationLabel) {
  if (!notificationsEnabled || !notificationsSupported || Notification.permission !== 'granted') return;
  if (msg.type === 'system') return;
  if (!document.hidden && document.hasFocus()) return; // only nudge when they're not already looking at it

  let body;
  if (msg.type === 'text') body = msg.text;
  else if (msg.type === 'text-encrypted') body = msg.decryptFailed ? '🔒 Encrypted message' : (msg.decryptedText || '🔒 New message');
  else if (msg.type === 'file') body = msg.caption ? `📎 ${msg.caption}` : `📎 ${msg.name}`;
  else return;

  try {
    const n = new Notification(`${msg.from} — ${conversationLabel}`, { body: body.slice(0, 140) });
    n.onclick = () => window.focus();
  } catch {}
}

// ============================================================
// Backend URL (persisted, editable via settings popover)
// ============================================================
const backendInput = document.getElementById('backendUrl');
const defaultBackend = `http://${window.location.hostname}:3001`;
let backendBase = localStorage.getItem('lan-share-backend') || defaultBackend;
backendInput.value = backendBase;

const settingsBtn = document.getElementById('settingsBtn');
const settingsView = document.getElementById('settingsView');
const nameEditInput = document.getElementById('nameEditInput');
const settingsProfileAvatar = document.getElementById('settingsProfileAvatar');

function openSettings() {
  transfersPanel.classList.add('hidden');
  nameEditInput.value = username;
  settingsProfileAvatar.textContent = initials(username);
  settingsProfileAvatar.style.background = colorForName(username);
  renderDeviceMergeList();
  settingsView.classList.remove('hidden');
}
function closeSettings() {
  settingsView.classList.add('hidden');
}
settingsBtn.addEventListener('click', openSettings);
document.getElementById('settingsBackBtn').addEventListener('click', closeSettings);
// Esc closes it like any other full-page overlay in the app.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsView.classList.contains('hidden')) closeSettings();
});

document.getElementById('saveBackend').addEventListener('click', () => {
  const val = backendInput.value.trim().replace(/\/$/, '');
  localStorage.setItem('lan-share-backend', val);
  window.location.reload();
});

document.getElementById('saveName').addEventListener('click', () => {
  const val = nameEditInput.value.trim().slice(0, 40);
  if (!val || val === username) return;
  username = val;
  idStore.set('lan-share-username', username);
  myNameEl.textContent = username;
  if (socket) socket.emit('rename', username);
  showToast('Display name updated.', 'info');
});
nameEditInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('saveName').click();
});

// ============================================================
// Identity storage: cookie-backed, not just localStorage.
//
// Why: localStorage is scoped per full origin (protocol + hostname + PORT).
// During dev, Vite bumps its port every time 5173 is busy (5174, 5175, ...),
// so a plain localStorage.getItem('lan-share-device-id') looks empty on the
// new port and the app mints a brand-new device identity — even though it's
// the exact same browser on the exact same machine. That's how the roster
// ends up with "Saurabh", "Saurabh", "Sau mobile" as three separate rows for
// what's really one or two people.
//
// Cookies, by contrast, are scoped per hostname + path only — the port is
// NOT part of a cookie's scope. So a cookie set while on localhost:5173 is
// still readable from localhost:5174. We use cookies as the source of truth
// for identity (device id, keypair, username, trusted-peer-key cache) and
// mirror into localStorage as a same-port fallback for browsers/contexts
// where cookies are blocked. Non-identity prefs (theme, notification opt-in,
// backend URL) stay plain localStorage — losing those across a port bump is
// harmless, unlike silently forking your identity.
// ============================================================
function setCookie(name, value, days) {
  try {
    const maxAge = days * 24 * 60 * 60;
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
  } catch {}
}
function getCookie(name) {
  try {
    const prefix = name + '=';
    for (const part of document.cookie.split(';')) {
      const c = part.trim();
      if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length));
    }
  } catch {}
  return null;
}

const IDENTITY_COOKIE_DAYS = 3650; // effectively "forever"
const idStore = {
  get(key) {
    const fromCookie = getCookie(key);
    if (fromCookie !== null) {
      // Keep localStorage mirrored so an older port-specific value doesn't
      // shadow the cookie if cookies ever become unavailable later.
      try { localStorage.setItem(key, fromCookie); } catch {}
      return fromCookie;
    }
    // No cookie yet (first run on this browser, or cookies were only just
    // introduced by an app update) — fall back to whatever this exact origin
    // already has in localStorage, and promote it to a cookie so every other
    // port shares it from now on.
    let fromLocal = null;
    try { fromLocal = localStorage.getItem(key); } catch {}
    if (fromLocal !== null) setCookie(key, fromLocal, IDENTITY_COOKIE_DAYS);
    return fromLocal;
  },
  set(key, value) {
    setCookie(key, value, IDENTITY_COOKIE_DAYS);
    try { localStorage.setItem(key, value); } catch {}
  },
};

// ============================================================
// Device identity (persistent per browser/install) + display name
// ============================================================
function createDeviceId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let deviceId = idStore.get('lan-share-device-id');
if (!deviceId) {
  deviceId = createDeviceId();
  idStore.set('lan-share-device-id', deviceId);
}

// ============================================================
// End-to-end encryption: this device's persistent keypair.
//
// The private key never leaves this device (it's kept in localStorage, which is
// per-origin and never sent over the network — only the public key is ever
// transmitted, via the server's device list). See crypto.js for the primitives.
// ============================================================
let myPublicKeyBase64 = idStore.get('lan-share-public-key');
let myPrivateKeyPromise;
{
  const storedPrivateJwk = idStore.get('lan-share-private-key-jwk');
  if (storedPrivateJwk && myPublicKeyBase64) {
    myPrivateKeyPromise = importPrivateKey(JSON.parse(storedPrivateJwk));
  } else {
    myPrivateKeyPromise = (async () => {
      const kp = await generateDeviceKeypair();
      myPublicKeyBase64 = kp.publicKeyBase64;
      idStore.set('lan-share-public-key', kp.publicKeyBase64);
      idStore.set('lan-share-private-key-jwk', JSON.stringify(kp.privateKeyJwk));
      return importPrivateKey(kp.privateKeyJwk);
    })();
  }
}

// Trust-on-first-use pinning: remember each peer's public key the first time we see
// it, and flag (rather than silently accept) if it ever changes — that's how a
// substituted/spoofed identity gets caught instead of silently trusted.
const knownPeerKeys = JSON.parse(idStore.get('lan-share-known-peer-keys') || '{}');
function saveKnownPeerKeys() {
  idStore.set('lan-share-known-peer-keys', JSON.stringify(knownPeerKeys));
}
const peerKeyChanged = new Set(); // deviceIds whose public key changed since we last trusted it
const conversationKeyCache = new Map(); // deviceId -> { aesKey, fingerprint }

// Returns null if we don't have a public key for this peer yet, or if their key
// changed and hasn't been explicitly re-trusted (see trustPeerKey below).
async function ensureConversationKey(peerDeviceId) {
  const peerPublicKeyBase64 = deviceList.find((d) => d.deviceId === peerDeviceId)?.publicKey;
  if (!peerPublicKeyBase64) return null;
  if (peerKeyChanged.has(peerDeviceId)) return null;

  const cached = conversationKeyCache.get(peerDeviceId);
  if (cached && cached.forPublicKey === peerPublicKeyBase64) return cached;

  const myPrivateKey = await myPrivateKeyPromise;
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  const { aesKey, fingerprint } = await deriveConversationKey(myPrivateKey, peerPublicKey);
  const result = { aesKey, fingerprint, forPublicKey: peerPublicKeyBase64 };
  conversationKeyCache.set(peerDeviceId, result);
  return result;
}

function trustPeerKey(peerDeviceId) {
  const current = deviceList.find((d) => d.deviceId === peerDeviceId)?.publicKey;
  if (!current) return;
  knownPeerKeys[peerDeviceId] = current;
  saveKnownPeerKeys();
  peerKeyChanged.delete(peerDeviceId);
  conversationKeyCache.delete(peerDeviceId);
}

function peerOfDmMessage(msg) {
  return msg.fromDeviceId === deviceId ? msg.toDeviceId : msg.fromDeviceId;
}

// Decrypts a DM message in place (adds .decryptedText or .decryptFailed) so
// rendering code can stay simple. Group messages and file messages pass through
// untouched — file content encryption is a separate, not-yet-built increment
// (see PROGRESS.md).
async function decryptDmMessageInPlace(msg) {
  if (msg.type !== 'text-encrypted') return;
  const peerId = peerOfDmMessage(msg);
  const keyInfo = await ensureConversationKey(peerId);
  if (!keyInfo) {
    msg.decryptFailed = true;
    return;
  }
  try {
    msg.decryptedText = await decryptText(keyInfo.aesKey, msg.ciphertext, msg.iv);
  } catch {
    msg.decryptFailed = true;
  }
}

const nameModal = document.getElementById('nameModal');
const nameInput = document.getElementById('nameInput');
const myNameEl = document.getElementById('myName');

let username = idStore.get('lan-share-username') || '';

function showNameModal() {
  nameModal.style.display = 'flex';
  nameInput.focus();
  hideBootSplash();
}
function hideNameModal() {
  nameModal.style.display = 'none';
}

document.getElementById('nameSubmit').addEventListener('click', submitName);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitName();
});

function submitName() {
  const val = nameInput.value.trim();
  if (!val) return;
  username = val.slice(0, 40);
  idStore.set('lan-share-username', username);
  myNameEl.textContent = username;
  hideNameModal();
  connectSocket();
}

// ============================================================
// Top-level tabs (Chats / Files)
// ============================================================
const tabs = document.querySelectorAll('.tab');
const panels = { chat: document.getElementById('chatTab'), files: document.getElementById('filesTab') };
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    Object.entries(panels).forEach(([key, el]) => {
      el.classList.toggle('hidden', key !== tab.dataset.tab);
    });
    if (tab.dataset.tab === 'files') loadFiles();
  });
});

// ============================================================
// Connection status
// ============================================================
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');

function setConnStatus(state) {
  connDot.className = `conn-dot ${state}`;
  connText.textContent = { connected: 'Online', connecting: 'Connecting…', disconnected: 'Reconnecting…' }[state];
}

// ============================================================
// Conversations: 'group' (unchanged broadcast chat) + one per device (1:1 DM)
// ============================================================
const GROUP_ID = 'group';
function dmConversationId(a, b) {
  return 'dm:' + [a, b].sort().join('|');
}

// ---- Persist the currently open chat across page refreshes / reconnects,
// so reloading the tab (or the phone waking up) drops you back where you
// were instead of the chat list. ----
const LAST_CONVERSATION_KEY = 'lan-share-last-conversation';
function saveActiveConversation(conv) {
  try {
    if (!conv) {
      localStorage.removeItem(LAST_CONVERSATION_KEY);
      return;
    }
    const data = conv.type === 'group' ? { type: 'group' } : { type: 'dm', peerDeviceId: conv.peerDeviceId };
    localStorage.setItem(LAST_CONVERSATION_KEY, JSON.stringify(data));
  } catch {}
}
function loadSavedConversation() {
  try {
    return JSON.parse(localStorage.getItem(LAST_CONVERSATION_KEY));
  } catch {
    return null;
  }
}

let socket = null;
let hasOfferedNotifications = false;
let deviceList = []; // [{deviceId, name, online, lastSeen}]
const messagesByConversation = new Map(); // conversationId -> array of messages (live cache)
const unreadConversations = new Set();
let activeConversation = null; // { type: 'group' } | { type: 'dm', peerDeviceId, peerName }
const dmHistoryFetched = new Set(); // peerDeviceIds we've already backfilled history for

function ensureConversationCache(conversationId) {
  if (!messagesByConversation.has(conversationId)) messagesByConversation.set(conversationId, []);
  return messagesByConversation.get(conversationId);
}

function connectSocket() {
  if (socket) socket.disconnect();
  setConnStatus('connecting');
  setBootStatus('Connecting to backend…');
  socket = io(backendBase, { transports: ['websocket', 'polling'] });

  socket.on('connect', async () => {
    setConnStatus('connected');
    setBootStatus('Signing in…');
    await myPrivateKeyPromise; // make sure our keypair exists before announcing it
    socket.emit('join', { username, deviceId, publicKey: myPublicKeyBase64 });
    if (!hasOfferedNotifications) {
      hasOfferedNotifications = true;
      setTimeout(maybeOfferNotifications, 2500);
    }
  });

  socket.on('disconnect', () => setConnStatus('disconnected'));
  socket.on('connect_error', () => {
    setConnStatus('disconnected');
    setBootStatus("Can't reach the backend — check Settings.");
  });

  socket.on('history', (history) => {
    messagesByConversation.set(GROUP_ID, history);
    if (activeConversation?.type === 'group') {
      conversationLoadingEl.classList.add('hidden');
      renderActiveConversation(true);
    }
  });

  let didRestoreConversation = false;
  socket.on('devices', (list) => {
    deviceList = list.filter((d) => d.deviceId !== deviceId);

    // Trust-on-first-use: pin a peer's key the first time we see it; flag (don't
    // silently accept) if it ever changes afterwards.
    for (const d of deviceList) {
      if (!d.publicKey) continue;
      const known = knownPeerKeys[d.deviceId];
      if (!known) {
        knownPeerKeys[d.deviceId] = d.publicKey;
        saveKnownPeerKeys();
      } else if (known !== d.publicKey) {
        peerKeyChanged.add(d.deviceId);
      }
    }

    renderChatList();
    renderDeviceMergeList();
    if (activeConversation?.type === 'dm') {
      updateConversationSubtitle();
      updateEncryptionUI();
    }

    // Reopen whatever chat was on screen before a refresh, once we have a
    // roster to resolve a DM peer's name against. Only attempted once per
    // page load, and only if nothing else has opened a conversation yet.
    if (!didRestoreConversation) {
      didRestoreConversation = true;
      if (!activeConversation) {
        const saved = loadSavedConversation();
        if (saved?.type === 'group') {
          openConversation({ type: 'group' });
        } else if (saved?.type === 'dm') {
          const dev = deviceList.find((d) => d.deviceId === saved.peerDeviceId);
          if (dev) openConversation({ type: 'dm', peerDeviceId: dev.deviceId, peerName: dev.name });
        }
      }
    }

    hideBootSplash();
  });

  socket.on('message', async (msg) => {
    await decryptDmMessageInPlace(msg);
    const cid = msg.conversationId || GROUP_ID;

    // Client-side belt-and-suspenders: never render two identical system lines
    // back-to-back for the same conversation (covers legacy/older servers too).
    if (msg.type === 'system') {
      const cache = ensureConversationCache(cid);
      const prev = cache[cache.length - 1];
      if (prev && prev.type === 'system' && prev.text === msg.text && msg.ts - prev.ts < 4000) return;
    }

    ensureConversationCache(cid).push(msg);

    const isActive =
      (activeConversation?.type === 'group' && cid === GROUP_ID) ||
      (activeConversation?.type === 'dm' && cid === dmConversationId(deviceId, activeConversation.peerDeviceId));

    const mine = msg.from === username && (msg.fromDeviceId ? msg.fromDeviceId === deviceId : true);
    if (!mine) {
      const conversationLabel = cid === GROUP_ID ? 'Group' : (msg.from || 'New message');
      notifyIncomingMessage(msg, conversationLabel);
    }

    if (isActive) {
      const wasNearBottom = isNearBottom();
      renderMessage(msg);
      document.getElementById('chatEmptyState').classList.add('hidden');
      if (wasNearBottom || mine) {
        scrollToBottom(true);
      } else {
        jumpToBottomBtn.textContent = '↓ New messages';
        jumpToBottomBtn.classList.remove('hidden');
      }
    } else if (msg.type !== 'system') {
      unreadConversations.add(cid);
    }
    renderChatList();
  });

  socket.on('message-deleted', ({ conversationId, ids }) => {
    const cache = messagesByConversation.get(conversationId);
    if (!cache) return;
    const idSet = new Set(ids);
    let changed = false;
    for (const m of cache) {
      if (idSet.has(m.id) && !m.deleted) {
        m.deleted = true;
        changed = true;
      }
    }
    if (!changed) return;
    exitSelectionMode();
    if (
      (activeConversation?.type === 'group' && conversationId === GROUP_ID) ||
      (activeConversation?.type === 'dm' && conversationId === dmConversationId(deviceId, activeConversation.peerDeviceId))
    ) {
      renderActiveConversation();
    }
    renderChatList();
  });

  socket.on('dm-history', async ({ peerDeviceId, messages: history }) => {
    await Promise.all(history.map(decryptDmMessageInPlace));
    const cid = dmConversationId(deviceId, peerDeviceId);
    // Merge rather than replace: live messages may have arrived since we asked.
    const existing = ensureConversationCache(cid);
    const existingIds = new Set(existing.map((m) => m.id));
    const merged = [...history.filter((m) => !existingIds.has(m.id)), ...existing];
    merged.sort((a, b) => a.ts - b.ts);
    messagesByConversation.set(cid, merged);
    if (activeConversation?.type === 'dm' && activeConversation.peerDeviceId === peerDeviceId) {
      conversationLoadingEl.classList.add('hidden');
      renderActiveConversation(true);
    }
    renderChatList();
  });

  socket.on('file-deleted', ({ name }) => {
    let anyChanged = false;
    for (const [, msgs] of messagesByConversation) {
      for (const m of msgs) {
        if (m.type === 'file' && m.name === name && !m.deleted) {
          m.deleted = true;
          anyChanged = true;
        }
      }
    }
    if (anyChanged) renderActiveConversation();
  });

  let groupTypingTimeout;
  socket.on('typing', (who) => {
    if (activeConversation?.type !== 'group') return;
    typingIndicator.textContent = `${who} is typing…`;
    typingIndicator.classList.remove('hidden');
    clearTimeout(groupTypingTimeout);
    groupTypingTimeout = setTimeout(() => typingIndicator.classList.add('hidden'), 2000);
  });

  let dmTypingTimeout;
  socket.on('dm-typing', ({ fromDeviceId, from }) => {
    if (activeConversation?.type !== 'dm' || activeConversation.peerDeviceId !== fromDeviceId) return;
    typingIndicator.textContent = `${from} is typing…`;
    typingIndicator.classList.remove('hidden');
    clearTimeout(dmTypingTimeout);
    dmTypingTimeout = setTimeout(() => typingIndicator.classList.add('hidden'), 2000);
  });
}

// ============================================================
// Chat list (Group row + one row per device)
// ============================================================
const chatListEl = document.getElementById('chatList');
const chatListView = document.getElementById('chatListView');
const conversationView = document.getElementById('conversationView');
const conversationName = document.getElementById('conversationName');
const conversationSubtitle = document.getElementById('conversationSubtitle');
const encryptionBadge = document.getElementById('encryptionBadge');
const keyChangedBanner = document.getElementById('keyChangedBanner');
const fingerprintPanel = document.getElementById('fingerprintPanel');
const fingerprintCode = document.getElementById('fingerprintCode');

function lastMessagePreview(cid) {
  const msgs = messagesByConversation.get(cid) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === 'system') continue;
    if (m.type === 'text') return { text: m.text, ts: m.ts };
    if (m.type === 'text-encrypted') {
      return { text: m.decryptFailed ? '🔒 Encrypted message' : (m.decryptedText ?? '🔒 …'), ts: m.ts };
    }
    if (m.type === 'file') return { text: m.deleted ? 'File removed' : `📎 ${m.caption || m.name}`, ts: m.ts };
  }
  return null;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ============================================================
// Settings → Devices: merge duplicate device entries.
//
// Cookies fix this going forward, but anyone who already accumulated
// duplicate rows (from before that fix, or from genuinely reinstalling/
// clearing cookies) needs a way to clean the roster up. This lets them
// tick 2+ rows they know are the same physical device and fold them
// together — history moves onto whichever selected device was seen most
// recently, and the others disappear from the roster.
// ============================================================
const deviceMergeListEl = document.getElementById('deviceMergeList');
const mergeDevicesBtn = document.getElementById('mergeDevicesBtn');
const selectedForMerge = new Set();

function renderDeviceMergeList() {
  if (!deviceMergeListEl) return;
  // Drop selections for devices that no longer exist (merged elsewhere, etc.)
  for (const id of [...selectedForMerge]) {
    if (!deviceList.some((d) => d.deviceId === id)) selectedForMerge.delete(id);
  }

  deviceMergeListEl.innerHTML = '';
  if (deviceList.length < 2) {
    const empty = document.createElement('p');
    empty.className = 'device-merge-empty';
    empty.textContent = 'Need at least two other devices on the roster to merge.';
    deviceMergeListEl.appendChild(empty);
  } else {
    for (const d of [...deviceList].sort((a, b) => b.lastSeen - a.lastSeen)) {
      const li = document.createElement('li');
      li.className = 'device-merge-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedForMerge.has(d.deviceId);
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedForMerge.add(d.deviceId);
        else selectedForMerge.delete(d.deviceId);
        mergeDevicesBtn.disabled = selectedForMerge.size < 2;
      });

      const info = document.createElement('div');
      info.className = 'device-merge-row-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'device-merge-row-name';
      nameEl.textContent = d.name;
      const metaEl = document.createElement('span');
      metaEl.className = 'device-merge-row-meta';
      metaEl.textContent = d.online ? 'Online' : `last seen ${timeAgo(d.lastSeen)}`;
      info.append(nameEl, metaEl);

      li.append(checkbox, info);
      li.addEventListener('click', () => checkbox.click());
      deviceMergeListEl.appendChild(li);
    }
  }

  mergeDevicesBtn.disabled = selectedForMerge.size < 2;
}

mergeDevicesBtn?.addEventListener('click', async () => {
  const ids = [...selectedForMerge];
  if (ids.length < 2) return;

  const selectedDevices = ids
    .map((id) => deviceList.find((d) => d.deviceId === id))
    .filter(Boolean)
    .sort((a, b) => b.lastSeen - a.lastSeen);
  if (selectedDevices.length < 2) return;

  // Keep whichever selected device was seen most recently; fold the rest into it.
  const keep = selectedDevices[0];
  const mergeIds = selectedDevices.slice(1).map((d) => d.deviceId);
  const otherNames = selectedDevices.slice(1).map((d) => d.name).join(', ');

  if (!confirm(`Merge ${otherNames} into "${keep.name}"? Their chat history will move onto "${keep.name}" and the duplicate rows will be removed. This can't be undone.`)) {
    return;
  }

  mergeDevicesBtn.disabled = true;
  try {
    const res = await fetch(`${backendBase}/api/devices/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepId: keep.deviceId, mergeIds }),
    });
    if (!res.ok) throw new Error('merge failed');
    selectedForMerge.clear();
    showToast(`Merged into "${keep.name}".`, 'info');
    // The server broadcasts an updated device list to everyone (including us),
    // which re-renders both the chat list and this panel.
  } catch {
    showToast("Couldn't reach the backend to merge those devices.", 'error');
    mergeDevicesBtn.disabled = selectedForMerge.size < 2;
  }
});

// ============================================================
// Chat list search — filters by name and last-message preview, live as you type.
// ============================================================
const chatSearchInput = document.getElementById('chatSearchInput');
let chatSearchQuery = '';
chatSearchInput.addEventListener('input', () => {
  chatSearchQuery = chatSearchInput.value.trim().toLowerCase();
  renderChatList();
});

// ============================================================
// Pinned chats — kept at the top of the list, persisted per browser.
// ============================================================
const PINNED_CHATS_KEY = 'lan-share-pinned-chats';
let pinnedChats = new Set();
try { pinnedChats = new Set(JSON.parse(localStorage.getItem(PINNED_CHATS_KEY) || '[]')); } catch {}
function savePinnedChats() {
  try { localStorage.setItem(PINNED_CHATS_KEY, JSON.stringify([...pinnedChats])); } catch {}
}
function togglePinChat(cid) {
  if (pinnedChats.has(cid)) pinnedChats.delete(cid);
  else pinnedChats.add(cid);
  savePinnedChats();
  renderChatList();
}

function renderChatList() {
  chatListEl.innerHTML = '';
  updateTabBadge();

  const rows = [{ kind: 'group' }, ...deviceList.map((d) => ({ kind: 'dm', device: d }))]
    .map((row) => {
      const cid = row.kind === 'group' ? GROUP_ID : dmConversationId(deviceId, row.device.deviceId);
      return { ...row, cid, preview: lastMessagePreview(cid), pinned: pinnedChats.has(cid) };
    })
    .filter((row) => {
      if (!chatSearchQuery) return true;
      const title = row.kind === 'group' ? 'group' : row.device.name.toLowerCase();
      const previewText = row.preview ? row.preview.text.toLowerCase() : '';
      return title.includes(chatSearchQuery) || previewText.includes(chatSearchQuery);
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.preview?.ts || 0) - (a.preview?.ts || 0);
    });

  if (rows.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'chat-list-empty-search';
    empty.textContent = `No chats match "${chatSearchInput.value.trim()}"`;
    chatListEl.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const cid = row.cid;
    const preview = row.preview;
    const unread = unreadConversations.has(cid);

    const li = document.createElement('li');
    li.className = `chat-list-item ${unread ? 'unread' : ''} ${row.pinned ? 'pinned' : ''}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar chat-list-avatar';
    if (row.kind === 'group') {
      avatar.textContent = '👥';
      avatar.style.background = '#3a3f4b';
    } else {
      avatar.textContent = initials(row.device.name);
      avatar.style.background = colorForName(row.device.name);
    }

    const info = document.createElement('div');
    info.className = 'chat-list-info';
    const titleRow = document.createElement('div');
    titleRow.className = 'chat-list-title-row';
    if (row.pinned) {
      const pinIcon = document.createElement('span');
      pinIcon.className = 'chat-list-pin-icon';
      pinIcon.textContent = '📌';
      titleRow.appendChild(pinIcon);
    }

    const title = document.createElement('span');
    title.className = 'chat-list-title';
    title.textContent = row.kind === 'group' ? 'Group' : row.device.name;
    titleRow.appendChild(title);

    if (row.kind === 'dm') {
      const status = document.createElement('span');
      status.className = `chat-list-status ${row.device.online ? 'online' : ''}`;
      status.textContent = row.device.online ? 'Online' : timeAgo(row.device.lastSeen);
      titleRow.appendChild(status);
    }

    const previewRow = document.createElement('div');
    previewRow.className = 'chat-list-preview-row';
    const previewText = document.createElement('span');
    previewText.className = 'chat-list-preview';
    previewText.textContent = preview ? preview.text : row.kind === 'group' ? 'No messages yet' : 'Tap to start chatting';
    previewRow.appendChild(previewText);
    if (preview) {
      const time = document.createElement('span');
      time.className = 'chat-list-time';
      time.textContent = new Date(preview.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      previewRow.appendChild(time);
    }

    info.append(titleRow, previewRow);
    li.append(avatar, info);
    if (unread) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      li.appendChild(dot);
    }

    li.addEventListener('click', () => {
      if (row.kind === 'group') openConversation({ type: 'group' });
      else openConversation({ type: 'dm', peerDeviceId: row.device.deviceId, peerName: row.device.name });
    });

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openChatContextMenu(e.clientX, e.clientY, cid, row.pinned);
    });
    let chatLongPressTimer;
    li.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      chatLongPressTimer = setTimeout(() => openChatContextMenu(touch.clientX, touch.clientY, cid, row.pinned), 500);
    }, { passive: true });
    li.addEventListener('touchend', () => clearTimeout(chatLongPressTimer));
    li.addEventListener('touchmove', () => clearTimeout(chatLongPressTimer));

    chatListEl.appendChild(li);
  }
}

// ---- Chat list row context menu: currently just Pin/Unpin, but built the
// same way as the message context menu so more actions can slot in later. ----
const chatContextMenu = document.getElementById('chatContextMenu');
const chatCtxPin = document.getElementById('chatCtxPin');
const chatCtxPinLabel = document.getElementById('chatCtxPinLabel');
let chatContextMenuCid = null;

function openChatContextMenu(x, y, cid, isPinned) {
  chatContextMenuCid = cid;
  chatCtxPinLabel.textContent = isPinned ? 'Unpin chat' : 'Pin chat';
  chatContextMenu.classList.remove('hidden');
  const rect = chatContextMenu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  chatContextMenu.style.left = Math.min(x, maxX) + 'px';
  chatContextMenu.style.top = Math.min(y, maxY) + 'px';
}
function closeChatContextMenu() {
  chatContextMenu.classList.add('hidden');
  chatContextMenuCid = null;
}
chatCtxPin.addEventListener('click', () => {
  if (chatContextMenuCid) togglePinChat(chatContextMenuCid);
  closeChatContextMenu();
});
document.addEventListener('click', (e) => {
  if (!chatContextMenu.classList.contains('hidden') && !chatContextMenu.contains(e.target)) closeChatContextMenu();
});

function updateConversationSubtitle() {
  if (activeConversation?.type !== 'dm') return;
  const device = deviceList.find((d) => d.deviceId === activeConversation.peerDeviceId);
  conversationSubtitle.textContent = device ? (device.online ? 'Online' : `last seen ${timeAgo(device.lastSeen)}`) : '';
}

async function updateEncryptionUI() {
  if (activeConversation?.type !== 'dm') {
    encryptionBadge.classList.add('hidden');
    keyChangedBanner.classList.add('hidden');
    fingerprintPanel.classList.add('hidden');
    return;
  }
  const peerId = activeConversation.peerDeviceId;
  encryptionBadge.classList.remove('hidden');

  if (peerKeyChanged.has(peerId)) {
    keyChangedBanner.classList.remove('hidden');
    encryptionBadge.textContent = '⚠️';
    encryptionBadge.title = "This device's key changed — tap for details";
  } else {
    keyChangedBanner.classList.add('hidden');
    encryptionBadge.textContent = '🔒';
    encryptionBadge.title = 'Tap to verify encryption';
  }
}

encryptionBadge.addEventListener('click', async () => {
  if (activeConversation?.type !== 'dm') return;
  const peerId = activeConversation.peerDeviceId;
  if (peerKeyChanged.has(peerId)) return; // banner already explains this state
  const keyInfo = await ensureConversationKey(peerId);
  fingerprintCode.textContent = keyInfo ? keyInfo.fingerprint : 'Not available yet';
  fingerprintPanel.classList.remove('hidden');
});

document.getElementById('closeFingerprintBtn').addEventListener('click', () => {
  fingerprintPanel.classList.add('hidden');
});

document.getElementById('trustNewKeyBtn').addEventListener('click', () => {
  if (activeConversation?.type !== 'dm') return;
  trustPeerKey(activeConversation.peerDeviceId);
  updateEncryptionUI();
  showToast('New key trusted for this device.', 'info');
});

const conversationLoadingEl = document.getElementById('conversationLoading');

function openConversation(conv) {
  activeConversation = conv;
  const cid = conv.type === 'group' ? GROUP_ID : dmConversationId(deviceId, conv.peerDeviceId);
  unreadConversations.delete(cid);
  if (typeof cancelReply === 'function') cancelReply();
  if (typeof exitSelectionMode === 'function') exitSelectionMode();

  conversationName.textContent = conv.type === 'group' ? 'Group' : conv.peerName;
  updateConversationSubtitle();
  fingerprintPanel.classList.add('hidden');
  updateEncryptionUI();

  chatListView.classList.add('hidden');
  conversationView.classList.remove('hidden');
  typingIndicator.classList.add('hidden');
  saveActiveConversation(conv);

  // Show a brief spinner instead of an empty message list while this
  // conversation's history is still in flight (group's first load, or a
  // DM opened for the first time this session).
  const historyPending = conv.type === 'group'
    ? !messagesByConversation.has(GROUP_ID)
    : !dmHistoryFetched.has(conv.peerDeviceId);
  conversationLoadingEl.classList.toggle('hidden', !historyPending);

  if (conv.type === 'dm' && !dmHistoryFetched.has(conv.peerDeviceId)) {
    dmHistoryFetched.add(conv.peerDeviceId);
    socket.emit('get-dm-history', conv.peerDeviceId);
  }

  renderActiveConversation(true);
  renderChatList();
}

document.getElementById('backToListBtn').addEventListener('click', () => {
  activeConversation = null;
  cancelReply();
  exitSelectionMode();
  conversationView.classList.add('hidden');
  chatListView.classList.remove('hidden');
  saveActiveConversation(null);
  renderChatList();
});

// ============================================================
// Conversation rendering (shared by Group + any DM)
// ============================================================
const messageList = document.getElementById('messageList');
const chatEmptyState = document.getElementById('chatEmptyState');
const typingIndicator = document.getElementById('typingIndicator');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const jumpToBottomBtn = document.getElementById('jumpToBottom');

function isNearBottom() {
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 120;
}
function scrollToBottom(instant = false) {
  messageList.scrollTo({ top: messageList.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  jumpToBottomBtn.classList.add('hidden');
}
messageList.addEventListener('scroll', () => {
  if (isNearBottom()) {
    jumpToBottomBtn.classList.add('hidden');
  } else {
    jumpToBottomBtn.textContent = '↓';
    jumpToBottomBtn.classList.remove('hidden');
  }
});
jumpToBottomBtn.addEventListener('click', () => scrollToBottom());

const AVATAR_COLORS = ['#4f8cff', '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#84cc16'];
function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function initials(name) {
  return name.trim().slice(0, 2).toUpperCase();
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg)$/i;
let lastRenderedFrom = null;

function currentConversationId() {
  if (!activeConversation) return null;
  return activeConversation.type === 'group' ? GROUP_ID : dmConversationId(deviceId, activeConversation.peerDeviceId);
}

function getMessageById(cid, id) {
  const arr = messagesByConversation.get(cid) || [];
  return arr.find((m) => m.id === id);
}

function isMine(msg) {
  return msg.from === username && (msg.fromDeviceId ? msg.fromDeviceId === deviceId : true);
}

function messagePreviewText(m) {
  if (!m) return 'Original message';
  if (m.type === 'text') return m.text;
  if (m.type === 'text-encrypted') return m.decryptFailed ? '🔒 Encrypted message' : (m.decryptedText ?? '🔒 …');
  if (m.type === 'file') return m.deleted ? 'File removed' : `📎 ${m.caption || m.name}`;
  return '';
}

function renderActiveConversation(scrollInstant = false) {
  if (!activeConversation) return;
  exitSelectionMode();
  const cid = currentConversationId();
  const msgs = messagesByConversation.get(cid) || [];

  messageList.innerHTML = '';
  messageList.appendChild(chatEmptyState);
  lastRenderedFrom = null;
  msgs.forEach(renderMessage);
  chatEmptyState.classList.toggle('hidden', msgs.length > 0);
  reattachPendingUploadBubbles(cid);
  scrollToBottom(scrollInstant);
}

// ============================================================
// In-chat "sending…" bubbles for files still uploading in the background.
// These live outside messagesByConversation (they're not real messages yet)
// so a full re-render just needs to re-append whichever ones still belong
// to this conversation — see reattachPendingUploadBubbles below, called at
// the end of renderActiveConversation.
// ============================================================
function pendingBubbleDomId(t) {
  return `pending-upload-${t.id}`;
}
function appendPendingUploadBubble(t) {
  if (currentConversationId() !== t.conversationId) return;
  if (document.getElementById(pendingBubbleDomId(t))) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg-row mine pending-upload';
  wrap.id = pendingBubbleDomId(t);
  wrap.innerHTML = `
    <div class="bubble">
      <div class="msg-file">
        <span class="msg-file-icon">${fileIcon(t.name)}</span>
        <span class="msg-file-meta">
          <span class="msg-file-name">${escapeHtml(t.name)}</span>
          <span class="msg-file-size pending-upload-status">Sending… ${t.progress}%</span>
        </span>
      </div>
      <div class="transfer-progress-bar"><div class="transfer-progress-fill" data-role="fill" style="width:${t.progress}%"></div></div>
    </div>`;
  messageList.appendChild(wrap);
  chatEmptyState.classList.add('hidden');
  scrollToBottom(true);
}
function updatePendingUploadBubble(t) {
  const el = document.getElementById(pendingBubbleDomId(t));
  if (!el) return;
  const fill = el.querySelector('[data-role="fill"]');
  const status = el.querySelector('.pending-upload-status');
  if (fill) fill.style.width = t.progress + '%';
  if (status) status.textContent = `Sending… ${t.progress}%`;
}
function removePendingUploadBubble(t) {
  document.getElementById(pendingBubbleDomId(t))?.remove();
}
function markPendingUploadBubbleFailed(t) {
  const el = document.getElementById(pendingBubbleDomId(t));
  if (!el) return;
  el.classList.add('upload-failed');
  const status = el.querySelector('.pending-upload-status');
  if (status) status.textContent = 'Failed to send — tap to retry from Files tab';
}
function reattachPendingUploadBubbles(cid) {
  for (const t of transfers.values()) {
    if (t.kind === 'upload' && t.status === 'active' && t.conversationId === cid) {
      appendPendingUploadBubble(t);
    }
  }
}

function renderMessage(msg) {
  if (msg.type === 'system') {
    lastRenderedFrom = null;
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = msg.text;
    messageList.appendChild(div);
    return;
  }

  const mine = isMine(msg);
  const grouped = !mine && lastRenderedFrom === msg.from;
  lastRenderedFrom = msg.from;

  const wrap = document.createElement('div');
  wrap.className = `msg-row ${mine ? 'mine' : 'theirs'} ${grouped ? 'grouped' : ''}`;
  wrap.dataset.id = msg.id;
  if (msg.type === 'file') wrap.dataset.fileName = msg.name;

  const checkbox = document.createElement('div');
  checkbox.className = 'msg-row-checkbox';
  checkbox.textContent = '✓';
  wrap.appendChild(checkbox);

  if (!mine) {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (grouped) {
      avatar.classList.add('avatar-spacer');
    } else {
      avatar.textContent = initials(msg.from);
      avatar.style.background = colorForName(msg.from);
    }
    wrap.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (!mine && !grouped && activeConversation?.type === 'group') {
    const nameTag = document.createElement('div');
    nameTag.className = 'msg-from';
    nameTag.textContent = msg.from;
    nameTag.style.color = colorForName(msg.from);
    bubble.appendChild(nameTag);
  }

  if (msg.forwarded) {
    const fwdTag = document.createElement('div');
    fwdTag.className = 'msg-forwarded-tag';
    fwdTag.textContent = '↪️ Forwarded';
    bubble.appendChild(fwdTag);
  }

  if (msg.replyTo) {
    const parent = getMessageById(currentConversationId(), msg.replyTo);
    const quote = document.createElement('div');
    quote.className = 'msg-reply-quote';
    const body = document.createElement('div');
    body.className = 'msg-reply-quote-body';
    const fromEl = document.createElement('span');
    fromEl.className = 'msg-reply-quote-from';
    fromEl.textContent = parent ? (isMine(parent) ? 'You' : parent.from) : 'Original message';
    const textEl = document.createElement('span');
    textEl.className = 'msg-reply-quote-text';
    textEl.textContent = messagePreviewText(parent);
    body.append(fromEl, textEl);
    quote.appendChild(body);
    quote.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = messageList.querySelector(`[data-id="${msg.replyTo}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('highlight-flash');
        setTimeout(() => target.classList.remove('highlight-flash'), 900);
      }
    });
    bubble.appendChild(quote);
  }

  if (msg.type === 'text') {
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = msg.text;
    bubble.appendChild(textEl);
  } else if (msg.type === 'text-encrypted') {
    const textEl = document.createElement('div');
    if (msg.decryptFailed) {
      textEl.className = 'msg-text msg-undecryptable';
      textEl.textContent = '🔒 Could not decrypt this message';
    } else {
      textEl.className = 'msg-text';
      textEl.textContent = msg.decryptedText ?? '…';
    }
    bubble.appendChild(textEl);
  } else if (msg.type === 'file') {
    if (msg.deleted) {
      const removedEl = document.createElement('div');
      removedEl.className = 'msg-file msg-file-removed';
      removedEl.innerHTML = `<span class="msg-file-icon">🗑️</span>
        <span class="msg-file-meta">
          <span class="msg-file-name">${escapeHtml(msg.name)}</span>
          <span class="msg-file-size">File removed</span>
        </span>`;
      bubble.appendChild(removedEl);
    } else {
      const url = `${backendBase}/api/download/${encodeURIComponent(msg.name)}`;
      if (IMAGE_EXT.test(msg.name)) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = msg.name;
        img.className = 'msg-image';
        img.loading = 'lazy';
        img.addEventListener('load', () => img.classList.add('loaded'));
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectionMode) toggleSelect(msg.id);
          else openViewer(msg);
        });
        bubble.appendChild(img);

        const meta = document.createElement('div');
        meta.className = 'msg-file-size';
        meta.textContent = formatBytes(msg.size || 0);
        bubble.appendChild(meta);
      } else {
        const fileEl = document.createElement('div');
        fileEl.className = 'msg-file';
        fileEl.innerHTML = `<span class="msg-file-icon">${fileIcon(msg.name)}</span>
          <span class="msg-file-meta">
            <span class="msg-file-name">${escapeHtml(msg.name)}</span>
            <span class="msg-file-size">${formatBytes(msg.size || 0)} · tap to open</span>
          </span>`;
        fileEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectionMode) toggleSelect(msg.id);
          else openViewer(msg);
        });
        bubble.appendChild(fileEl);
      }

      const actions = document.createElement('div');
      actions.className = 'bubble-actions';
      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.className = 'bubble-action-btn';
      downloadBtn.textContent = 'Download';
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadMessage(msg);
      });
      actions.appendChild(downloadBtn);
      bubble.appendChild(actions);
    }
    if (msg.caption) {
      const captionEl = document.createElement('div');
      captionEl.className = 'msg-caption';
      captionEl.textContent = msg.caption;
      bubble.appendChild(captionEl);
    }
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(time);

  wrap.appendChild(bubble);

  // ---- Interactions: double-click to reply, right-click / long-press for the
  // context menu, tap-to-toggle while in multi-select mode ----
  wrap.addEventListener('dblclick', () => {
    if (selectionMode) return;
    startReply(msg);
  });
  wrap.addEventListener('click', () => {
    if (selectionMode) toggleSelect(msg.id);
  });
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, msg);
  });
  let longPressTimer;
  wrap.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    longPressTimer = setTimeout(() => openContextMenu(touch.clientX, touch.clientY, msg), 500);
  }, { passive: true });
  wrap.addEventListener('touchend', () => clearTimeout(longPressTimer));
  wrap.addEventListener('touchmove', () => clearTimeout(longPressTimer));

  if (selectionMode) wrap.classList.add('selecting');
  if (selectedIds.has(msg.id)) wrap.classList.add('selected');

  messageList.appendChild(wrap);
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(ext)) return '🎵';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  return '📄';
}

// ============================================================
// Reply-to-message: double-click a msg-row to start replying (see renderMessage).
// ============================================================
const replyBar = document.getElementById('replyBar');
const replyBarFrom = document.getElementById('replyBarFrom');
const replyBarText = document.getElementById('replyBarText');
let replyContext = null; // { id } of the message being replied to

function startReply(msg) {
  if (msg.type === 'system') return;
  replyContext = { id: msg.id };
  replyBarFrom.textContent = isMine(msg) ? 'You' : msg.from;
  replyBarText.textContent = messagePreviewText(msg);
  replyBar.classList.remove('hidden');
  chatInput.focus();
}
function cancelReply() {
  replyContext = null;
  replyBar.classList.add('hidden');
}
document.getElementById('replyBarCancel').addEventListener('click', cancelReply);

// ============================================================
// Multi-select mode: shared across text messages and file/media attachments.
// ============================================================
let selectionMode = false;
const selectedIds = new Set();
const selectionBar = document.getElementById('selectionBar');
const selectionCount = document.getElementById('selectionCount');

function enterSelectionMode(initialId) {
  selectionMode = true;
  selectedIds.clear();
  if (initialId) selectedIds.add(initialId);
  renderActiveConversationKeepingSelection();
}
function exitSelectionMode() {
  if (!selectionMode) return;
  selectionMode = false;
  selectedIds.clear();
  selectionBar.classList.add('hidden');
  messageList.querySelectorAll('.msg-row.selecting').forEach((el) => {
    el.classList.remove('selecting', 'selected');
  });
}
function renderActiveConversationKeepingSelection() {
  const cid = currentConversationId();
  const msgs = messagesByConversation.get(cid) || [];
  messageList.innerHTML = '';
  messageList.appendChild(chatEmptyState);
  lastRenderedFrom = null;
  msgs.forEach(renderMessage);
  chatEmptyState.classList.add('hidden');
  updateSelectionBar();
}
function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  if (selectedIds.size === 0) {
    exitSelectionMode();
    return;
  }
  const row = messageList.querySelector(`[data-id="${id}"]`);
  if (row) row.classList.toggle('selected', selectedIds.has(id));
  updateSelectionBar();
}
function updateSelectionBar() {
  if (!selectionMode) return;
  selectionBar.classList.remove('hidden');
  const downloadCandidates = getDownloadCandidates([...selectedIds]);
  const canDownload = downloadCandidates.length > 0 && downloadCandidates.length === [...selectedIds].filter((id) => {
    const msg = getMessageById(currentConversationId(), id);
    return msg && msg.type === 'file' && !msg.deleted;
  }).length;
  document.getElementById('selectionDownloadBtn').hidden = !canDownload;
  selectionCount.textContent = `${selectedIds.size} selected`;
}
document.getElementById('selectionCancelBtn').addEventListener('click', exitSelectionMode);
document.getElementById('selectionDownloadBtn').addEventListener('click', () => downloadMessages([...selectedIds]));
document.getElementById('selectionCopyBtn').addEventListener('click', () => copyMessages([...selectedIds]));
document.getElementById('selectionForwardBtn').addEventListener('click', () => openForwardModal([...selectedIds]));
document.getElementById('selectionDeleteBtn').addEventListener('click', () => deleteMessages([...selectedIds]));

// ============================================================
// Context menu (right-click / long-press) for a single message or attachment
// ============================================================
const contextMenu = document.getElementById('contextMenu');
let contextMenuMsg = null;

function openContextMenu(x, y, msg) {
  contextMenuMsg = msg;
  const mine = isMine(msg);
  const isDeletedFile = msg.type === 'file' && Boolean(msg.deleted);
  const canDownload = msg.type === 'file' && !isDeletedFile;
  contextMenu.querySelector('[data-action="delete"]').classList.toggle('hidden', Boolean(!mine || isDeletedFile));
  contextMenu.querySelector('[data-action="download"]').classList.toggle('hidden', !canDownload);
  contextMenu.querySelector('[data-action="copy"]').classList.toggle('hidden', isDeletedFile);
  contextMenu.querySelector('[data-action="forward"]').classList.toggle('hidden', isDeletedFile);
  contextMenu.querySelector('[data-action="reply"]').classList.toggle('hidden', isDeletedFile);
  contextMenu.classList.remove('hidden');
  const rect = contextMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  contextMenu.style.left = `${Math.max(8, left)}px`;
  contextMenu.style.top = `${Math.max(8, top)}px`;
}
function closeContextMenu() {
  contextMenu.classList.add('hidden');
  contextMenuMsg = null;
}
document.addEventListener('click', (e) => {
  if (!contextMenu.classList.contains('hidden') && !contextMenu.contains(e.target)) closeContextMenu();
});
contextMenu.addEventListener('click', (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (!action || !contextMenuMsg) return closeContextMenu();
  const msg = contextMenuMsg;
  closeContextMenu();
  if (action === 'reply') startReply(msg);
  else if (action === 'forward') openForwardModal([msg.id]);
  else if (action === 'download') downloadMessage(msg);
  else if (action === 'copy') copyMessages([msg.id]);
  else if (action === 'delete') deleteMessages([msg.id]);
  else if (action === 'select') enterSelectionMode(msg.id);
});

function getDownloadCandidates(ids) {
  const cid = currentConversationId();
  return ids
    .map((id) => getMessageById(cid, id))
    .filter((msg) => msg && msg.type === 'file' && !msg.deleted)
    .filter((msg, index, arr) => arr.findIndex((item) => item.id === msg.id) === index);
}

function shouldAllowDownloadSelection(ids) {
  const selected = [...ids];
  if (selected.length === 0) return false;
  return selected.every((id) => {
    const msg = getMessageById(currentConversationId(), id);
    return msg && msg.type === 'file' && !msg.deleted;
  });
}

function downloadMessage(msg) {
  if (!msg || msg.type !== 'file' || msg.deleted) return;
  const a = document.createElement('a');
  const url = `${backendBase}/api/download/${encodeURIComponent(msg.name)}?download=1`;
  a.href = url;
  a.download = msg.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  noteDownloadStarted(msg.name);
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadMessagesAsZip(candidates) {
  const zipName = `LAN Chat files (${new Date().toISOString().slice(0, 10)}).zip`;
  const transferId = createTransfer('download', zipName, 0);
  try {
    let done = 0;
    const entries = await Promise.all(candidates.map(async (msg) => {
      const response = await fetch(`${backendBase}/api/download/${encodeURIComponent(msg.name)}?download=1`);
      if (!response.ok) throw new Error(`Could not download ${msg.name}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      done++;
      updateTransfer(transferId, { progress: Math.round((done / candidates.length) * 100) });
      return [msg.name, bytes];
    }));
    const archive = zipSync(Object.fromEntries(entries), { level: 6 });
    const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
    triggerDownload(url, zipName);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    finishTransfer(transferId, 'done');
    showToast(`${candidates.length} files downloaded as a ZIP.`, 'info');
  } catch (error) {
    finishTransfer(transferId, 'error');
    showToast(error.message || 'Could not create the ZIP file.', 'error');
  }
}

function downloadMessagesOneByOne(candidates) {
  candidates.forEach((msg, index) => {
    setTimeout(() => downloadMessage(msg), index * 400);
  });
}

function chooseDownloadMode(count) {
  const modal = document.getElementById('downloadChoiceModal');
  const text = document.getElementById('downloadChoiceText');
  const zipBtn = document.getElementById('downloadZipBtn');
  const individualBtn = document.getElementById('downloadIndividualBtn');
  const cancelBtn = document.getElementById('downloadChoiceCancelBtn');
  text.textContent = `${count} files are selected. Choose how you want to download them.`;
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const close = (choice) => {
      modal.classList.add('hidden');
      zipBtn.removeEventListener('click', chooseZip);
      individualBtn.removeEventListener('click', chooseIndividual);
      cancelBtn.removeEventListener('click', chooseCancel);
      resolve(choice);
    };
    const chooseZip = () => close('zip');
    const chooseIndividual = () => close('individual');
    const chooseCancel = () => close(null);
    zipBtn.addEventListener('click', chooseZip);
    individualBtn.addEventListener('click', chooseIndividual);
    cancelBtn.addEventListener('click', chooseCancel);
  });
}

async function downloadMessages(ids) {
  const selected = [...ids];
  if (!shouldAllowDownloadSelection(selected)) return;
  const candidates = getDownloadCandidates(selected);
  if (candidates.length === 0) return;
  if (candidates.length === 1) {
    downloadMessage(candidates[0]);
    exitSelectionMode();
    return;
  }

  const mode = await chooseDownloadMode(candidates.length);
  if (mode === null) return;
  if (mode === 'zip') await downloadMessagesAsZip(candidates);
  else downloadMessagesOneByOne(candidates);
  exitSelectionMode();
}

// ============================================================
// Copy / delete / forward — all operate on 1+ message ids from the active conversation
// ============================================================
function copyMessages(ids) {
  const cid = currentConversationId();
  const texts = ids
    .map((id) => getMessageById(cid, id))
    .filter(Boolean)
    .map(messagePreviewText)
    .filter(Boolean);
  if (texts.length === 0) return;
  navigator.clipboard?.writeText(texts.join('\n')).then(
    () => showToast('Copied to clipboard.', 'info'),
    () => showToast('Could not copy to clipboard.', 'error')
  );
  exitSelectionMode();
}

function deleteMessages(ids) {
  if (!socket || ids.length === 0) return;
  const cid = currentConversationId();
  const deletable = ids.filter((id) => {
    const m = getMessageById(cid, id);
    return m && isMine(m) && !m.deleted;
  });
  if (deletable.length === 0) {
    showToast('You can only delete your own messages.', 'error');
    exitSelectionMode();
    return;
  }
  socket.emit('delete-message', { conversationId: cid, ids: deletable });
  exitSelectionMode();
}

// ---- Forward picker ----
const forwardModal = document.getElementById('forwardModal');
const forwardList = document.getElementById('forwardList');
const forwardConfirmBtn = document.getElementById('forwardConfirmBtn');
let forwardMsgIds = [];
const forwardTargets = new Set(); // 'group' or a peerDeviceId

function openForwardModal(ids) {
  forwardMsgIds = ids;
  forwardTargets.clear();
  forwardConfirmBtn.disabled = true;
  forwardList.innerHTML = '';

  const rows = [{ kind: 'group', key: 'group', name: 'Group' }, ...deviceList.map((d) => ({ kind: 'dm', key: d.deviceId, name: d.name }))];
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'forward-item';
    const check = document.createElement('span');
    check.className = 'forward-item-check';
    check.textContent = '✓';
    const name = document.createElement('span');
    name.className = 'forward-item-name';
    name.textContent = row.name;
    li.append(check, name);
    li.addEventListener('click', () => {
      if (forwardTargets.has(row.key)) forwardTargets.delete(row.key);
      else forwardTargets.add(row.key);
      li.classList.toggle('checked', forwardTargets.has(row.key));
      forwardConfirmBtn.disabled = forwardTargets.size === 0;
    });
    forwardList.appendChild(li);
  }
  forwardModal.classList.remove('hidden');
}
document.getElementById('forwardCancelBtn').addEventListener('click', () => forwardModal.classList.add('hidden'));

forwardConfirmBtn.addEventListener('click', async () => {
  const cid = currentConversationId();
  const msgs = forwardMsgIds.map((id) => getMessageById(cid, id)).filter(Boolean);
  for (const target of forwardTargets) {
    for (const msg of msgs) {
      await forwardOneMessage(msg, target);
    }
  }
  forwardModal.classList.add('hidden');
  exitSelectionMode();
  showToast('Forwarded.', 'info');
});

async function forwardOneMessage(msg, target) {
  if (!socket) return;
  const text = msg.type === 'text' ? msg.text : msg.type === 'text-encrypted' ? (msg.decryptedText ?? null) : null;

  if (target === 'group') {
    if (msg.type === 'file') {
      if (msg.deleted) return;
      socket.emit('file-message', { name: msg.name, size: msg.size, caption: msg.caption || null, forwarded: true });
    } else if (text != null) {
      socket.emit('chat-message', { text, forwarded: true });
    }
    return;
  }

  // Forwarding into a DM: files stay plaintext metadata (consistent with how DM files
  // already work); text gets freshly encrypted for that specific recipient.
  if (msg.type === 'file') {
    if (msg.deleted) return;
    socket.emit('dm-file-message', { toDeviceId: target, name: msg.name, size: msg.size, caption: msg.caption || null, forwarded: true });
  } else if (text != null) {
    const keyInfo = await ensureConversationKey(target);
    if (!keyInfo) {
      showToast('Could not forward — recipient has no encryption key yet.', 'error');
      return;
    }
    const { ciphertext, iv } = await encryptText(keyInfo.aesKey, text);
    socket.emit('dm-message', { toDeviceId: target, ciphertext, iv, forwarded: true });
  }
}

// ============================================================
// Media / file viewer modal
// ============================================================
const viewerModal = document.getElementById('viewerModal');
const viewerName = document.getElementById('viewerName');
const viewerBody = document.getElementById('viewerBody');
const viewerMeta = document.getElementById('viewerMeta');
const viewerDownloadBtn = document.getElementById('viewerDownloadBtn');
let viewerZoom = 1;
let viewerPanX = 0;
let viewerPanY = 0;
let viewerDragging = false;
let viewerDragStartX = 0;
let viewerDragStartY = 0;

function resetViewerImageTransform() {
  viewerZoom = 1;
  viewerPanX = 0;
  viewerPanY = 0;
  viewerDragging = false;
}

function applyViewerImageTransform(image) {
  image.style.transform = `translate(${viewerPanX}px, ${viewerPanY}px) scale(${viewerZoom})`;
  image.draggable = viewerZoom <= 1;
  image.style.webkitUserDrag = viewerZoom <= 1 ? 'auto' : 'none';
  image.style.cursor = viewerZoom > 1 ? (viewerDragging ? 'grabbing' : 'grab') : 'zoom-in';
}

function openViewer(msg) {
  if (msg.deleted) return;
  const url = `${backendBase}/api/download/${encodeURIComponent(msg.name)}`;
  viewerName.textContent = msg.name;
  viewerMeta.textContent = formatBytes(msg.size || 0);
  viewerDownloadBtn.href = `${url}?download=1`;
  viewerDownloadBtn.setAttribute('download', msg.name);
  viewerDownloadBtn.onclick = () => noteDownloadStarted(msg.name);
  viewerBody.innerHTML = '';
  resetViewerImageTransform();

  if (IMAGE_EXT.test(msg.name)) {
    const img = document.createElement('img');
    img.className = 'viewer-zoomable';
    img.draggable = false;
    img.src = url;
    img.alt = msg.name;
    img.addEventListener('dragstart', (e) => {
      if (viewerZoom > 1) e.preventDefault();
    });
    applyViewerImageTransform(img);
    viewerBody.appendChild(img);
  } else if (VIDEO_EXT.test(msg.name)) {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    viewerBody.appendChild(video);
  } else if (AUDIO_EXT.test(msg.name)) {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    audio.autoplay = true;
    viewerBody.appendChild(audio);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'viewer-generic';
    wrap.innerHTML = `<div class="viewer-generic-icon">${fileIcon(msg.name)}</div><div>${escapeHtml(msg.name)}</div><p style="color:var(--muted);font-size:12.5px;">Preview isn't available for this file type — use Download.</p>`;
    viewerBody.appendChild(wrap);
  }
  viewerModal.classList.remove('hidden');
}
function closeViewer() {
  viewerModal.classList.add('hidden');
  viewerBody.innerHTML = '';
}
document.getElementById('viewerCloseBtn').addEventListener('click', closeViewer);
// Click-outside-to-close: clicking the dark empty space around the media (not the
// media itself, and not the header/footer controls) closes the viewer.
viewerBody.addEventListener('click', (e) => {
  if (e.target === viewerBody) closeViewer();
});
viewerBody.addEventListener('wheel', (e) => {
  const image = e.target.closest('.viewer-zoomable');
  if (!image) return;
  e.preventDefault();
  const nextZoom = Math.min(5, Math.max(1, viewerZoom * (e.deltaY < 0 ? 1.15 : 0.87)));
  if (nextZoom === 1) {
    viewerPanX = 0;
    viewerPanY = 0;
  }
  viewerZoom = nextZoom;
  applyViewerImageTransform(image);
}, { passive: false });
viewerBody.addEventListener('pointerdown', (e) => {
  const image = e.target.closest('.viewer-zoomable');
  if (!image || viewerZoom <= 1) return;
  viewerDragging = true;
  viewerDragStartX = e.clientX - viewerPanX;
  viewerDragStartY = e.clientY - viewerPanY;
  image.setPointerCapture(e.pointerId);
  applyViewerImageTransform(image);
});
viewerBody.addEventListener('pointermove', (e) => {
  const image = e.target.closest('.viewer-zoomable');
  if (!image || !viewerDragging) return;
  viewerPanX = e.clientX - viewerDragStartX;
  viewerPanY = e.clientY - viewerDragStartY;
  applyViewerImageTransform(image);
});
viewerBody.addEventListener('pointerup', (e) => {
  const image = e.target.closest('.viewer-zoomable');
  if (!image) return;
  viewerDragging = false;
  image.releasePointerCapture?.(e.pointerId);
  applyViewerImageTransform(image);
});
viewerModal.addEventListener('click', (e) => {
  if (e.target === viewerModal) closeViewer();
});

// Escape closes whichever overlay is currently open, top-most first.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!viewerModal.classList.contains('hidden')) closeViewer();
  else if (!attachPreviewModal.classList.contains('hidden')) closeAttachPreview();
  else if (!forwardModal.classList.contains('hidden')) forwardModal.classList.add('hidden');
  else if (!contextMenu.classList.contains('hidden')) closeContextMenu();
  else if (selectionMode) exitSelectionMode();
});

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value;
  if (!text.trim() || !socket || !activeConversation) return;
  const replyTo = replyContext?.id || null;

  if (activeConversation.type === 'group') {
    socket.emit('chat-message', { text, replyTo });
    chatInput.value = '';
    cancelReply();
    return;
  }

  const peerId = activeConversation.peerDeviceId;
  if (peerKeyChanged.has(peerId)) {
    showToast("This device's security key changed — verify before sending.", 'error');
    return;
  }
  const keyInfo = await ensureConversationKey(peerId);
  if (!keyInfo) {
    const peerName = deviceList.find((device) => device.deviceId === peerId)?.name || 'The other device';
    showToast(`${peerName} has not published an encryption key yet. Ask them to refresh the page.`, 'error');
    return;
  }
  const { ciphertext, iv } = await encryptText(keyInfo.aesKey, text);
  socket.emit('dm-message', { toDeviceId: peerId, ciphertext, iv, replyTo });
  chatInput.value = '';
  cancelReply();
});

let lastTypingEmit = 0;
chatInput.addEventListener('input', () => {
  const now = Date.now();
  if (!socket || !activeConversation || now - lastTypingEmit <= 1500) return;
  lastTypingEmit = now;
  if (activeConversation.type === 'group') socket.emit('typing');
  else socket.emit('dm-typing', activeConversation.peerDeviceId);
});

// ============================================================
// Chunked parallel upload — splits large files into pieces and sends several
// at once, which is both faster over LAN and lets big (multi-GB) transfers
// recover from a single flaky chunk instead of failing the whole upload.
// ============================================================
// ============================================================
// Background transfers: every upload/download runs independently of
// whichever chat or tab is currently on screen, and a small tray in the
// header shows what's in flight so nothing has to block the rest of the
// app. Uploads report real byte-level progress (from the chunk XHRs
// below); downloads are handed off to the browser's native download
// mechanism, which is already non-blocking and disk-streamed — we just
// surface a "started" entry here for visibility/consistency rather than
// re-buffering large files into JS memory to fake a progress bar.
// ============================================================
const transfers = new Map(); // id -> { id, kind, name, size, progress, status, conversationId }
let transferSeq = 0;

const transfersBtn = document.getElementById('transfersBtn');
const transfersBadge = document.getElementById('transfersBadge');
const transfersPanel = document.getElementById('transfersPanel');
const transfersList = document.getElementById('transfersList');
const transfersEmpty = document.getElementById('transfersEmpty');
const transfersClearBtn = document.getElementById('transfersClearBtn');

function createTransfer(kind, name, size, conversationId = null) {
  const id = 't' + (++transferSeq);
  transfers.set(id, { id, kind, name, size, progress: 0, status: 'active', conversationId });
  renderTransfers();
  return id;
}
function updateTransfer(id, patch) {
  const t = transfers.get(id);
  if (!t) return;
  Object.assign(t, patch);
  renderTransfers();
  if (t.kind === 'upload') updatePendingUploadBubble(t);
}
function finishTransfer(id, status) {
  const t = transfers.get(id);
  if (!t) return;
  t.status = status;
  if (status === 'done') t.progress = 100;
  renderTransfers();
  if (t.kind === 'upload') {
    if (status === 'done') removePendingUploadBubble(t);
    else markPendingUploadBubbleFailed(t);
  }
  setTimeout(() => {
    transfers.delete(id);
    renderTransfers();
  }, status === 'error' ? 5000 : 1800);
}

function renderTransfers() {
  const activeCount = [...transfers.values()].filter((t) => t.status === 'active').length;
  transfersBtn.classList.toggle('hidden', transfers.size === 0);
  transfersBadge.classList.toggle('hidden', activeCount === 0);
  transfersBadge.textContent = activeCount > 99 ? '99+' : String(activeCount);

  transfersList.innerHTML = '';
  const items = [...transfers.values()].reverse();
  transfersEmpty.classList.toggle('hidden', items.length > 0);
  for (const t of items) {
    const li = document.createElement('li');
    li.className = `transfer-item transfer-${t.status}`;
    const icon = t.kind === 'upload' ? '⬆️' : '⬇️';
    const statusLabel = t.status === 'done' ? 'Done' : t.status === 'error' ? 'Failed' : `${t.progress}%`;
    const info = document.createElement('div');
    info.className = 'transfer-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'transfer-name';
    nameEl.textContent = t.name;
    const bar = document.createElement('div');
    bar.className = 'transfer-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'transfer-progress-fill';
    fill.style.width = t.progress + '%';
    bar.appendChild(fill);
    info.append(nameEl, bar);

    const iconEl = document.createElement('span');
    iconEl.className = 'transfer-icon';
    iconEl.textContent = icon;
    const statusEl = document.createElement('span');
    statusEl.className = 'transfer-status';
    statusEl.textContent = statusLabel;

    li.append(iconEl, info, statusEl);
    transfersList.appendChild(li);
  }
}

transfersBtn.addEventListener('click', () => {
  transfersPanel.classList.toggle('hidden');
  closeSettings();
});
transfersClearBtn.addEventListener('click', () => {
  for (const [id, t] of transfers) {
    if (t.status !== 'active') transfers.delete(id);
  }
  renderTransfers();
});

// A download's progress can't be tracked without buffering the whole file
// into JS memory (defeating the point of the backend's disk-streamed,
// range-friendly downloads — see README), so this just logs a "started"
// entry that auto-resolves. The actual transfer proceeds entirely in the
// browser's own download manager, in the background, same as any other
// site.
function noteDownloadStarted(filename) {
  const id = createTransfer('download', filename, 0);
  setTimeout(() => finishTransfer(id, 'done'), 900);
}

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB
const CHUNK_CONCURRENCY = 4;
const CHUNK_MAX_RETRIES = 3;

async function uploadFileChunked(file, { onProgress, onComplete, onError }) {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  try {
    const initRes = await fetch(`${backendBase}/api/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        fileSize: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks,
      }),
    });
    if (!initRes.ok) throw new Error('Could not start upload');
    const { uploadId } = await initRes.json();

    const progressPerChunk = new Array(totalChunks).fill(0);
    function reportProgress() {
      const uploaded = progressPerChunk.reduce((a, b) => a + b, 0);
      onProgress(Math.min(100, Math.round((uploaded / file.size) * 100)));
    }

    let finalResult = null;

    function uploadChunkOnce(index, start, end) {
      return new Promise((resolve, reject) => {
        const blob = file.slice(start, end);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${backendBase}/api/upload/chunk?uploadId=${uploadId}&index=${index}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            progressPerChunk[index] = e.loaded;
            reportProgress();
          }
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            progressPerChunk[index] = end - start;
            reportProgress();
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error('Chunk upload failed: ' + xhr.status));
          }
        });
        xhr.addEventListener('error', () => reject(new Error('Network error during chunk upload')));
        xhr.send(blob);
      });
    }

    async function uploadChunk(index) {
      const start = index * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      let lastErr;
      for (let attempt = 0; attempt < CHUNK_MAX_RETRIES; attempt++) {
        try {
          return await uploadChunkOnce(index, start, end);
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      throw lastErr;
    }

    const indices = Array.from({ length: totalChunks }, (_, i) => i);
    async function worker() {
      while (indices.length) {
        const index = indices.shift();
        const result = await uploadChunk(index);
        if (result.done) finalResult = result;
      }
    }

    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, totalChunks) }, worker));

    if (!finalResult) throw new Error('Upload did not complete');
    onComplete(finalResult);
  } catch (err) {
    onError(err);
  }
}

// ---- Attach files/media to the active conversation (button, drag-and-drop, or
// paste) — all funnel through a preview-and-send modal so a caption can be added
// before anything actually uploads. ----
const attachBtn = document.getElementById('attachBtn');
const chatFileInput = document.getElementById('chatFileInput');
const chatTab = document.getElementById('chatTab');
const chatDropOverlay = document.getElementById('chatDropOverlay');

const attachPreviewModal = document.getElementById('attachPreviewModal');
const attachModalTitle = document.getElementById('attachModalTitle');
const attachPreviewList = document.getElementById('attachPreviewList');
const attachCaptionInput = document.getElementById('attachCaptionInput');
const attachSendBtn = document.getElementById('attachSendBtn');
const attachSendProgressWrap = document.getElementById('attachSendProgressWrap');
const attachSendProgressFill = document.getElementById('attachSendProgressFill');

let attachQueue = []; // File[] queued for the preview modal

function queueFilesForChat(files) {
  if (!activeConversation || !files || files.length === 0) return;
  attachQueue = Array.from(files);
  renderAttachPreview();
  attachCaptionInput.value = '';
  attachPreviewModal.classList.remove('hidden');
  attachCaptionInput.focus();
}

function renderAttachPreview() {
  attachModalTitle.textContent = attachQueue.length > 1 ? `Send ${attachQueue.length} files` : 'Send file';
  attachPreviewList.innerHTML = '';
  attachQueue.forEach((file, index) => {
    const li = document.createElement('li');
    li.className = 'attach-preview-item';

    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'attach-preview-thumb';
      img.src = URL.createObjectURL(file);
      li.appendChild(img);
    } else {
      const icon = document.createElement('div');
      icon.className = 'attach-preview-icon';
      icon.textContent = fileIcon(file.name);
      li.appendChild(icon);
    }

    const info = document.createElement('div');
    info.className = 'attach-preview-info';
    info.innerHTML = `<span class="attach-preview-name">${escapeHtml(file.name)}</span>
      <span class="attach-preview-size">${formatBytes(file.size)}</span>`;
    li.appendChild(info);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'attach-preview-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      attachQueue.splice(index, 1);
      if (attachQueue.length === 0) closeAttachPreview();
      else renderAttachPreview();
    });
    li.appendChild(removeBtn);

    attachPreviewList.appendChild(li);
  });
}

function closeAttachPreview() {
  attachPreviewModal.classList.add('hidden');
  attachQueue = [];
  attachSendProgressWrap.classList.add('hidden');
}
document.getElementById('attachModalClose').addEventListener('click', closeAttachPreview);

attachCaptionInput.addEventListener('input', () => {
  if (!socket || !activeConversation) return;
  if (activeConversation.type === 'group') socket.emit('typing');
  else socket.emit('dm-typing', activeConversation.peerDeviceId);
});
attachCaptionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attachSendBtn.click();
});

// Sending is fire-and-forget from the UI's point of view: the modal closes
// immediately and the upload(s) continue in the background via the
// transfer manager, so you can keep chatting (in this conversation or any
// other) or switch to the Files tab while a big file is still going up.
attachSendBtn.addEventListener('click', () => {
  if (attachQueue.length === 0 || !activeConversation) return;
  const caption = attachCaptionInput.value.trim() || null;
  const replyTo = replyContext?.id || null;
  const files = [...attachQueue];
  const conv = activeConversation;
  const cid = conv.type === 'group' ? GROUP_ID : dmConversationId(deviceId, conv.peerDeviceId);

  cancelReply();
  closeAttachPreview();
  sendFilesInBackground(conv, cid, files, caption, replyTo);
});

async function sendFilesInBackground(conv, cid, files, caption, replyTo) {
  for (const file of files) {
    const transferId = createTransfer('upload', file.name, file.size, cid);
    appendPendingUploadBubble(transfers.get(transferId));

    await new Promise((resolve) => {
      uploadFileChunked(file, {
        onProgress: (pct) => updateTransfer(transferId, { progress: pct }),
        onComplete: (res) => {
          const payload = { name: res.filename, size: res.size, caption, replyTo };
          if (conv.type === 'group') socket.emit('file-message', payload);
          else socket.emit('dm-file-message', { toDeviceId: conv.peerDeviceId, ...payload });
          finishTransfer(transferId, 'done');
          resolve();
        },
        onError: (err) => {
          showToast(`Couldn't send ${file.name}: ${err.message}`, 'error');
          finishTransfer(transferId, 'error');
          resolve();
        },
      });
    });
  }
}

attachBtn.addEventListener('click', () => chatFileInput.click());
chatFileInput.addEventListener('change', (e) => {
  queueFilesForChat(e.target.files);
  chatFileInput.value = '';
});

let dragDepth = 0;
chatTab.addEventListener('dragenter', (e) => {
  if (conversationView.classList.contains('hidden')) return;
  e.preventDefault();
  dragDepth++;
  chatDropOverlay.classList.remove('hidden');
});
chatTab.addEventListener('dragover', (e) => e.preventDefault());
chatTab.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) chatDropOverlay.classList.add('hidden');
});
chatTab.addEventListener('drop', (e) => {
  if (conversationView.classList.contains('hidden')) return;
  e.preventDefault();
  dragDepth = 0;
  chatDropOverlay.classList.add('hidden');
  queueFilesForChat(e.dataTransfer.files);
});

// ---- Paste-to-share: pasting an image or file while a conversation is open
// queues it the same way as attaching or dropping one. ----
document.addEventListener('paste', (e) => {
  if (!activeConversation || conversationView.classList.contains('hidden')) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    queueFilesForChat(files);
  }
});

// ============================================================
// Files tab (browse / upload / download / delete all shared files)
// ============================================================
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const progressWrap = document.getElementById('progressWrap');
const progressName = document.getElementById('progressName');
const progressPct = document.getElementById('progressPct');
const progressFill = document.getElementById('progressFill');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) uploadFile(e.target.files[0]);
});

['dragover', 'dragenter'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

function uploadFile(file) {
  progressWrap.classList.remove('hidden');
  progressName.textContent = file.name;
  progressFill.style.width = '0%';
  progressPct.textContent = '0%';

  // Also tracked in the global Transfers tray — this upload keeps going
  // in the background even if you switch to the Chats tab mid-transfer.
  const transferId = createTransfer('upload', file.name, file.size);

  uploadFileChunked(file, {
    onProgress: (pct) => {
      progressFill.style.width = pct + '%';
      progressPct.textContent = pct + '%';
      updateTransfer(transferId, { progress: pct });
    },
    onComplete: (res) => {
      progressPct.textContent = 'Done ✓';
      setTimeout(() => progressWrap.classList.add('hidden'), 1200);
      finishTransfer(transferId, 'done');
      loadFiles();
      // Uploading from the Files tab (not tied to a specific conversation) still announces
      // the file in the Group chat, same as before — DMs only get files sent from within them.
      if (socket) socket.emit('file-message', { name: res.filename, size: res.size });
    },
    onError: (err) => {
      progressWrap.classList.add('hidden');
      finishTransfer(transferId, 'error');
      showToast(`Upload failed: ${err.message}`, 'error');
    },
  });
}

const fileListEl = document.getElementById('fileList');
const fileListSkeletonEl = document.getElementById('fileListSkeleton');
const emptyState = document.getElementById('emptyState');
document.getElementById('refreshBtn').addEventListener('click', loadFiles);

let filesLoadedOnce = false;
let lastLoadedFiles = [];
let filesFilter = 'all'; // 'all' | 'group' | 'private'

async function loadFiles() {
  if (!filesLoadedOnce) {
    fileListEl.classList.add('hidden');
    emptyState.classList.add('hidden');
    fileListSkeletonEl.classList.remove('hidden');
  }
  try {
    // deviceId scopes the result server-side: a private (DM) file is only ever
    // returned to that DM's two participants, never to anyone else — group
    // files (and older orphaned uploads) still show for everyone.
    const res = await fetch(`${backendBase}/api/files?deviceId=${encodeURIComponent(deviceId)}`);
    const files = await res.json();
    filesLoadedOnce = true;
    lastLoadedFiles = files;
    fileListSkeletonEl.classList.add('hidden');
    fileListEl.classList.remove('hidden');
    renderFiles(files);
  } catch (err) {
    fileListSkeletonEl.classList.add('hidden');
    fileListEl.classList.remove('hidden');
    fileListEl.innerHTML = '';
    emptyState.textContent = `Can't reach backend at ${backendBase}`;
    emptyState.classList.remove('hidden');
  }
}

// Resolve a private file's other participant(s) to display names, e.g.
// "Private · with Priya" instead of a bare device id.
function namesForSharedWith(sharedWith) {
  return sharedWith
    .map((id) => deviceList.find((d) => d.deviceId === id)?.name)
    .filter(Boolean);
}

const filesFilterRow = document.getElementById('filesFilterRow');
if (filesFilterRow) {
  filesFilterRow.addEventListener('click', (e) => {
    const chip = e.target.closest('.files-filter-chip');
    if (!chip) return;
    filesFilter = chip.dataset.filter;
    filesFilterRow.querySelectorAll('.files-filter-chip').forEach((c) =>
      c.classList.toggle('active', c === chip)
    );
    renderFiles(lastLoadedFiles);
  });
}

function renderFiles(files) {
  fileListEl.innerHTML = '';
  const visible = filesFilter === 'all' ? files : files.filter((f) => f.scope === filesFilter);

  emptyState.classList.toggle('hidden', visible.length > 0);
  if (visible.length === 0) {
    emptyState.textContent = files.length === 0
      ? 'No files yet — upload something above.'
      : `No ${filesFilter} files.`;
  }

  for (const f of visible) {
    const li = document.createElement('li');
    li.className = 'file-item';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'file-icon';
    iconSpan.textContent = fileIcon(f.name);

    const info = document.createElement('div');
    info.className = 'file-info';

    const scopeBadge = document.createElement('span');
    if (f.scope === 'private') {
      const names = namesForSharedWith(f.sharedWith || []);
      scopeBadge.className = 'file-scope-badge private';
      scopeBadge.title = 'Only visible to you and the person(s) you shared it with';
      scopeBadge.innerHTML = `🔒 Private${names.length ? ` · ${escapeHtml(names.join(', '))}` : ''}`;
    } else {
      scopeBadge.className = 'file-scope-badge group';
      scopeBadge.title = 'Visible to everyone in Group chat';
      scopeBadge.textContent = '👥 Group';
    }

    info.innerHTML = `<span class="file-name">${escapeHtml(f.name)}</span>
      <span class="file-meta">${formatBytes(f.size)}</span>`;
    info.appendChild(scopeBadge);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const downloadBtn = document.createElement('a');
    downloadBtn.href = `${backendBase}/api/download/${encodeURIComponent(f.name)}?download=1`;
    downloadBtn.setAttribute('download', f.name);
    downloadBtn.textContent = 'Download';
    downloadBtn.className = 'btn download';
    downloadBtn.addEventListener('click', () => noteDownloadStarted(f.name));

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'btn delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete ${f.name}?`)) return;
      await fetch(`${backendBase}/api/files/${encodeURIComponent(f.name)}?deviceId=${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
      });
      loadFiles();
    });

    actions.append(downloadBtn, deleteBtn);
    li.append(iconSpan, info, actions);
    fileListEl.appendChild(li);
  }
}

// ============================================================
// Helpers
// ============================================================
function formatBytes(bytes) {
  if (bytes < 1024) return bytes.toFixed(0) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    bytes /= 1024;
    i++;
  } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[i];
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Boot
// ============================================================
if (username) {
  myNameEl.textContent = username;
  hideNameModal();
  connectSocket();
} else {
  showNameModal();
}
