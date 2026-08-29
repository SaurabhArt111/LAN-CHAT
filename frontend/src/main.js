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

// ============================================================
// Backend URL (persisted, editable via settings popover)
// ============================================================
const backendInput = document.getElementById('backendUrl');
const defaultBackend = `http://${window.location.hostname}:3001`;
let backendBase = localStorage.getItem('lan-share-backend') || defaultBackend;
backendInput.value = backendBase;

const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

document.getElementById('saveBackend').addEventListener('click', () => {
  const val = backendInput.value.trim().replace(/\/$/, '');
  localStorage.setItem('lan-share-backend', val);
  window.location.reload();
});

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

let deviceId = localStorage.getItem('lan-share-device-id');
if (!deviceId) {
  deviceId = createDeviceId();
  localStorage.setItem('lan-share-device-id', deviceId);
}

// ============================================================
// End-to-end encryption: this device's persistent keypair.
//
// The private key never leaves this device (it's kept in localStorage, which is
// per-origin and never sent over the network — only the public key is ever
// transmitted, via the server's device list). See crypto.js for the primitives.
// ============================================================
let myPublicKeyBase64 = localStorage.getItem('lan-share-public-key');
let myPrivateKeyPromise;
{
  const storedPrivateJwk = localStorage.getItem('lan-share-private-key-jwk');
  if (storedPrivateJwk && myPublicKeyBase64) {
    myPrivateKeyPromise = importPrivateKey(JSON.parse(storedPrivateJwk));
  } else {
    myPrivateKeyPromise = (async () => {
      const kp = await generateDeviceKeypair();
      myPublicKeyBase64 = kp.publicKeyBase64;
      localStorage.setItem('lan-share-public-key', kp.publicKeyBase64);
      localStorage.setItem('lan-share-private-key-jwk', JSON.stringify(kp.privateKeyJwk));
      return importPrivateKey(kp.privateKeyJwk);
    })();
  }
}

// Trust-on-first-use pinning: remember each peer's public key the first time we see
// it, and flag (rather than silently accept) if it ever changes — that's how a
// substituted/spoofed identity gets caught instead of silently trusted.
const knownPeerKeys = JSON.parse(localStorage.getItem('lan-share-known-peer-keys') || '{}');
function saveKnownPeerKeys() {
  localStorage.setItem('lan-share-known-peer-keys', JSON.stringify(knownPeerKeys));
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

let username = localStorage.getItem('lan-share-username') || '';

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
  localStorage.setItem('lan-share-username', username);
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
    if (activeConversation?.type === 'dm') {
      updateConversationSubtitle();
      updateEncryptionUI();
    }
  });

  socket.on('message', async (msg) => {
    await decryptDmMessageInPlace(msg);
    const cid = msg.conversationId || GROUP_ID;
    ensureConversationCache(cid).push(msg);

    const isActive =
      (activeConversation?.type === 'group' && cid === GROUP_ID) ||
      (activeConversation?.type === 'dm' && cid === dmConversationId(deviceId, activeConversation.peerDeviceId));

    if (isActive) {
      const wasNearBottom = isNearBottom();
      renderMessage(msg);
      document.getElementById('chatEmptyState').classList.add('hidden');
      if (wasNearBottom || msg.from === username) {
        scrollToBottom(true);
      } else {
        jumpToBottomBtn.classList.remove('hidden');
      }
    } else if (msg.type !== 'system') {
      unreadConversations.add(cid);
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
    if (m.type === 'file') return { text: m.deleted ? 'File removed' : `📎 ${m.name}`, ts: m.ts };
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
let lastRenderedFrom = null;

function renderActiveConversation(scrollInstant = false) {
  if (!activeConversation) return;
  const cid = activeConversation.type === 'group' ? GROUP_ID : dmConversationId(deviceId, activeConversation.peerDeviceId);
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

  const mine = msg.from === username && (msg.fromDeviceId ? msg.fromDeviceId === deviceId : true);
  const grouped = !mine && lastRenderedFrom === msg.from;
  lastRenderedFrom = msg.from;

  const wrap = document.createElement('div');
  wrap.className = `msg-row ${mine ? 'mine' : 'theirs'} ${grouped ? 'grouped' : ''}`;
  if (msg.type === 'file') wrap.dataset.fileName = msg.name;

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
        const imgLink = document.createElement('a');
        imgLink.href = url;
        imgLink.target = '_blank';
        imgLink.rel = 'noopener';
        const img = document.createElement('img');
        img.src = url;
        img.alt = msg.name;
        img.className = 'msg-image';
        img.loading = 'lazy';
        imgLink.appendChild(img);
        bubble.appendChild(imgLink);

        const caption = document.createElement('div');
        caption.className = 'msg-file-size';
        caption.textContent = formatBytes(msg.size || 0);
        bubble.appendChild(caption);
      } else {
        const fileEl = document.createElement('a');
        fileEl.className = 'msg-file';
        fileEl.href = url;
        fileEl.innerHTML = `<span class="msg-file-icon">${fileIcon(msg.name)}</span>
          <span class="msg-file-meta">
            <span class="msg-file-name">${escapeHtml(msg.name)}</span>
            <span class="msg-file-size">${formatBytes(msg.size || 0)} · tap to download</span>
          </span>`;
        bubble.appendChild(fileEl);
      }
    }
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(time);

  wrap.appendChild(bubble);
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

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value;
  if (!text.trim() || !socket || !activeConversation) return;

  if (activeConversation.type === 'group') {
    socket.emit('chat-message', text);
    chatInput.value = '';
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
  socket.emit('dm-message', { toDeviceId: peerId, ciphertext, iv });
  chatInput.value = '';
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

// ---- Attach a file to the active conversation (button, or drag-and-drop) ----
const attachBtn = document.getElementById('attachBtn');
const chatFileInput = document.getElementById('chatFileInput');
const chatProgressWrap = document.getElementById('chatProgressWrap');
const chatProgressName = document.getElementById('chatProgressName');
const chatProgressPct = document.getElementById('chatProgressPct');
const chatProgressFill = document.getElementById('chatProgressFill');
const chatTab = document.getElementById('chatTab');
const chatDropOverlay = document.getElementById('chatDropOverlay');

attachBtn.addEventListener('click', () => chatFileInput.click());
chatFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) uploadForChat(file);
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
  const file = e.dataTransfer.files[0];
  if (file) uploadForChat(file);
});

function uploadForChat(file) {
  if (!activeConversation) return;
  chatProgressWrap.classList.remove('hidden');
  chatProgressName.textContent = file.name;
  chatProgressFill.style.width = '0%';
  chatProgressPct.textContent = '0%';

  uploadFileChunked(file, {
    onProgress: (pct) => {
      chatProgressFill.style.width = pct + '%';
      chatProgressPct.textContent = pct + '%';
    },
    onComplete: (res) => {
      chatProgressWrap.classList.add('hidden');
      if (activeConversation.type === 'group') {
        socket.emit('file-message', { name: res.filename, size: res.size });
      } else {
        socket.emit('dm-file-message', { toDeviceId: activeConversation.peerDeviceId, name: res.filename, size: res.size });
      }
    },
    onError: (err) => {
      chatProgressWrap.classList.add('hidden');
      showToast(`Upload failed: ${err.message}`, 'error');
    },
  });
}

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
    downloadBtn.href = `${backendBase}/api/download/${encodeURIComponent(f.name)}`;
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
