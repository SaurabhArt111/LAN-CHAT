import { io } from 'socket.io-client';

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
  window.location.reload(); // simplest way to cleanly reconnect the socket to the new backend
});

// ============================================================
// Username (asked once, persisted per browser)
// ============================================================
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
// Tabs
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
// Socket.IO chat
// ============================================================
let socket = null;
const messageList = document.getElementById('messageList');
const chatEmptyState = document.getElementById('chatEmptyState');
const presenceList = document.getElementById('presenceList');
const typingIndicator = document.getElementById('typingIndicator');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const jumpToBottomBtn = document.getElementById('jumpToBottom');

// Local copy of chat history so we can patch it (e.g. mark a file deleted) and re-render.
let messagesCache = [];

function connectSocket() {
  if (socket) socket.disconnect();
  setConnStatus('connecting');
  socket = io(backendBase, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    setConnStatus('connected');
    socket.emit('join', username);
  });

  socket.on('disconnect', () => setConnStatus('disconnected'));
  socket.on('connect_error', () => setConnStatus('disconnected'));

  socket.on('history', (history) => {
    messagesCache = history;
    renderAll();
    scrollToBottom(true);
  });

  socket.on('message', (msg) => {
    messagesCache.push(msg);
    const wasNearBottom = isNearBottom();
    renderMessage(msg);
    chatEmptyState.classList.add('hidden');
    if (wasNearBottom || msg.from === username) {
      scrollToBottom(true);
    } else {
      jumpToBottomBtn.classList.remove('hidden');
    }
  });

  // A file was removed via the Files tab (or by anyone) — patch any matching chat
  // bubbles so they stop looking like a live download link.
  socket.on('file-deleted', ({ name }) => {
    let changed = false;
    for (const msg of messagesCache) {
      if (msg.type === 'file' && msg.name === name && !msg.deleted) {
        msg.deleted = true;
        changed = true;
      }
    }
    if (changed) renderAll();
  });

  socket.on('presence', (users) => {
    const others = users.filter((u) => u !== username);
    presenceList.textContent = others.length === 0 ? 'No one else online' : `Online: ${users.join(', ')}`;
  });

  let typingTimeout;
  socket.on('typing', (who) => {
    typingIndicator.textContent = `${who} is typing…`;
    typingIndicator.classList.remove('hidden');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => typingIndicator.classList.add('hidden'), 2000);
  });
}

// ---- Smart auto-scroll ----
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

// ---- Avatar colors (consistent per username) ----
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

function renderAll() {
  messageList.innerHTML = '';
  messageList.appendChild(chatEmptyState);
  lastRenderedFrom = null;
  messagesCache.forEach(renderMessage);
  chatEmptyState.classList.toggle('hidden', messagesCache.length > 0);
}

let lastRenderedFrom = null; // tracks consecutive-sender grouping

function renderMessage(msg) {
  if (msg.type === 'system') {
    lastRenderedFrom = null;
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = msg.text;
    messageList.appendChild(div);
    return;
  }

  const mine = msg.from === username;
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

  if (!mine && !grouped) {
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

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value;
  if (!text.trim() || !socket) return;
  socket.emit('chat-message', text);
  chatInput.value = '';
});

let lastTypingEmit = 0;
chatInput.addEventListener('input', () => {
  const now = Date.now();
  if (socket && now - lastTypingEmit > 1500) {
    socket.emit('typing');
    lastTypingEmit = now;
  }
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

// ---- Attach a file from the chat tab (button, or drag-and-drop onto the chat panel) ----
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
  e.preventDefault();
  dragDepth = 0;
  chatDropOverlay.classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (file) uploadForChat(file);
});

function uploadForChat(file) {
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
      socket.emit('file-message', { name: res.filename, size: res.size });
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
