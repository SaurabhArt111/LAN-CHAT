import { io } from 'socket.io-client';
import {
  generateDeviceKeypair,
  importPrivateKey,
  importPublicKey,
  deriveConversationKey,
  encryptText,
  decryptText,
} from './crypto.js';

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
let notificationsEnabled = localStorage.getItem(NOTIF_PREF_KEY) === 'on'
  && notificationsSupported
  && Notification.permission === 'granted';

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
const settingsPanel = document.getElementById('settingsPanel');
const nameEditInput = document.getElementById('nameEditInput');
settingsBtn.addEventListener('click', () => {
  const opening = settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden');
  if (opening) {
    nameEditInput.value = username;
    renderDeviceMergeList();
  }
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
  socket = io(backendBase, { transports: ['websocket', 'polling'] });

  socket.on('connect', async () => {
    setConnStatus('connected');
    await myPrivateKeyPromise; // make sure our keypair exists before announcing it
    socket.emit('join', { username, deviceId, publicKey: myPublicKeyBase64 });
    if (!hasOfferedNotifications) {
      hasOfferedNotifications = true;
      setTimeout(maybeOfferNotifications, 2500);
    }
  });

  socket.on('disconnect', () => setConnStatus('disconnected'));
  socket.on('connect_error', () => setConnStatus('disconnected'));

  socket.on('history', (history) => {
    messagesByConversation.set(GROUP_ID, history);
    if (activeConversation?.type === 'group') renderActiveConversation(true);
  });

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

function renderChatList() {
  chatListEl.innerHTML = '';

  const rows = [{ kind: 'group' }, ...deviceList.map((d) => ({ kind: 'dm', device: d }))];

  for (const row of rows) {
    const cid = row.kind === 'group' ? GROUP_ID : dmConversationId(deviceId, row.device.deviceId);
    const preview = lastMessagePreview(cid);
    const unread = unreadConversations.has(cid);

    const li = document.createElement('li');
    li.className = `chat-list-item ${unread ? 'unread' : ''}`;

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

    chatListEl.appendChild(li);
  }
}

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
  if (isNearBottom()) jumpToBottomBtn.classList.add('hidden');
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
  scrollToBottom(scrollInstant);
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
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectionMode) toggleSelect(msg.id);
          else openViewer(msg);
        });
        bubble.appendChild(img);

        const caption = document.createElement('div');
        caption.className = 'msg-file-size';
        caption.textContent = formatBytes(msg.size || 0);
        bubble.appendChild(caption);
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
  selectionCount.textContent = `${selectedIds.size} selected`;
}
document.getElementById('selectionCancelBtn').addEventListener('click', exitSelectionMode);
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
  contextMenu.querySelector('[data-action="delete"]').classList.toggle('hidden', Boolean(!mine || isDeletedFile));
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
  else if (action === 'copy') copyMessages([msg.id]);
  else if (action === 'delete') deleteMessages([msg.id]);
  else if (action === 'select') enterSelectionMode(msg.id);
});

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

function openViewer(msg) {
  if (msg.deleted) return;
  const url = `${backendBase}/api/download/${encodeURIComponent(msg.name)}`;
  viewerName.textContent = msg.name;
  viewerMeta.textContent = formatBytes(msg.size || 0);
  viewerDownloadBtn.href = `${url}?download=1`;
  viewerDownloadBtn.setAttribute('download', msg.name);
  viewerBody.innerHTML = '';

  if (IMAGE_EXT.test(msg.name)) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = msg.name;
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

attachSendBtn.addEventListener('click', async () => {
  if (attachQueue.length === 0 || !activeConversation) return;
  const caption = attachCaptionInput.value.trim() || null;
  const replyTo = replyContext?.id || null;
  const files = [...attachQueue];
  attachSendBtn.disabled = true;
  attachSendProgressWrap.classList.remove('hidden');

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    await new Promise((resolve) => {
      uploadFileChunked(file, {
        onProgress: (pct) => {
          const overall = Math.round(((i + pct / 100) / files.length) * 100);
          attachSendProgressFill.style.width = overall + '%';
        },
        onComplete: (res) => {
          const payload = { name: res.filename, size: res.size, caption, replyTo };
          if (activeConversation.type === 'group') socket.emit('file-message', payload);
          else socket.emit('dm-file-message', { toDeviceId: activeConversation.peerDeviceId, ...payload });
          resolve();
        },
        onError: (err) => {
          showToast(`Upload failed: ${err.message}`, 'error');
          resolve();
        },
      });
    });
  }

  attachSendBtn.disabled = false;
  cancelReply();
  closeAttachPreview();
});

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

  uploadFileChunked(file, {
    onProgress: (pct) => {
      progressFill.style.width = pct + '%';
      progressPct.textContent = pct + '%';
    },
    onComplete: (res) => {
      progressPct.textContent = 'Done ✓';
      setTimeout(() => progressWrap.classList.add('hidden'), 1200);
      loadFiles();
      // Uploading from the Files tab (not tied to a specific conversation) still announces
      // the file in the Group chat, same as before — DMs only get files sent from within them.
      if (socket) socket.emit('file-message', { name: res.filename, size: res.size });
    },
    onError: (err) => {
      progressWrap.classList.add('hidden');
      showToast(`Upload failed: ${err.message}`, 'error');
    },
  });
}

const fileListEl = document.getElementById('fileList');
const emptyState = document.getElementById('emptyState');
document.getElementById('refreshBtn').addEventListener('click', loadFiles);

async function loadFiles() {
  try {
    const res = await fetch(`${backendBase}/api/files`);
    const files = await res.json();
    renderFiles(files);
  } catch (err) {
    fileListEl.innerHTML = '';
    emptyState.textContent = `Can't reach backend at ${backendBase}`;
    emptyState.classList.remove('hidden');
  }
}

function renderFiles(files) {
  fileListEl.innerHTML = '';
  emptyState.classList.toggle('hidden', files.length > 0);
  if (files.length === 0) emptyState.textContent = 'No files yet — upload something above.';

  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'file-item';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'file-icon';
    iconSpan.textContent = fileIcon(f.name);

    const info = document.createElement('div');
    info.className = 'file-info';
    info.innerHTML = `<span class="file-name">${escapeHtml(f.name)}</span>
      <span class="file-meta">${formatBytes(f.size)}</span>`;

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const downloadBtn = document.createElement('a');
    downloadBtn.href = `${backendBase}/api/download/${encodeURIComponent(f.name)}?download=1`;
    downloadBtn.setAttribute('download', f.name);
    downloadBtn.textContent = 'Download';
    downloadBtn.className = 'btn download';

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'btn delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete ${f.name}?`)) return;
      await fetch(`${backendBase}/api/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
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
