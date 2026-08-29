import express from 'express';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const MAX_HISTORY_PER_CONVERSATION = 500;
const PRESENCE_GRACE_MS = 5000; // don't announce "left" until this long after last connection drops
const STALE_UPLOAD_MS = 30 * 60 * 1000; // abandoned in-progress uploads get swept after this long
const GROUP_CONVERSATION_ID = 'group';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());

// ================= Startup cleanup: remove any leftover partial uploads =================
for (const name of fs.readdirSync(UPLOAD_DIR)) {
  if (name.startsWith('.tmp-')) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch {}
  }
}

// ================= Chat message persistence =================
// Every message now carries a conversationId: 'group' for the broadcast chat (unchanged
// behavior), or a deterministic 'dm:<idA>|<idB>' id for a 1:1 conversation between two devices.
let messages = [];
try {
  if (fs.existsSync(MESSAGES_FILE)) {
    messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
  }
} catch {
  messages = [];
}

function saveMessages() {
  fs.writeFile(MESSAGES_FILE, JSON.stringify(messages), () => {});
}

function pushMessage(msg) {
  messages.push(msg);
  // Cap history per-conversation rather than globally, so an active DM can't push group
  // history out, and vice versa.
  const counts = new Map();
  for (let i = messages.length - 1; i >= 0; i--) {
    const cid = messages[i].conversationId || GROUP_CONVERSATION_ID;
    counts.set(cid, (counts.get(cid) || 0) + 1);
    if (counts.get(cid) > MAX_HISTORY_PER_CONVERSATION) messages[i] = null;
  }
  messages = messages.filter(Boolean);
  saveMessages();
  return msg;
}

function dmConversationId(deviceIdA, deviceIdB) {
  return 'dm:' + [deviceIdA, deviceIdB].sort().join('|');
}

// Mark every chat message that references this filename as deleted (keeps history in sync
// with the Files tab, so people can't click a download link for something that's gone).
// This intentionally covers both group and DM messages.
function markFileDeletedInMessages(name) {
  let changed = false;
  for (const msg of messages) {
    if (msg.type === 'file' && msg.name === name && !msg.deleted) {
      msg.deleted = true;
      changed = true;
    }
  }
  if (changed) saveMessages();
  return changed;
}

// ================= Helpers shared by upload + files listing =================
function dedupedName(original) {
  const ext = path.extname(original);
  const base = path.basename(original, ext);
  let name = original;
  let target = path.join(UPLOAD_DIR, name);
  let counter = 1;
  while (fs.existsSync(target)) {
    name = `${base} (${counter})${ext}`;
    target = path.join(UPLOAD_DIR, name);
    counter++;
  }
  return name;
}

app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter((name) => !name.startsWith('.tmp-'))
    .map((name) => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, name));
      return { name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.get('/api/download/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const filePath = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'application/octet-stream',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.delete('/api/files/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const filePath = path.join(UPLOAD_DIR, name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const changed = markFileDeletedInMessages(name);
  if (changed) io.emit('file-deleted', { name });
  res.json({ ok: true });
});

// ================= Chunked upload (parallel chunks for faster large-file transfer) =================
// uploadId -> { fileHandle, tmpPath, finalName, fileSize, chunkSize, totalChunks, received: Set<number>, lastActivity }
const uploadSessions = new Map();

app.post('/api/upload/init', express.json(), async (req, res) => {
  const { filename, fileSize, chunkSize, totalChunks } = req.body || {};
  if (!filename || !fileSize || !chunkSize || !totalChunks) {
    return res.status(400).json({ error: 'filename, fileSize, chunkSize, totalChunks are required' });
  }

  const uploadId = randomUUID();
  const finalName = dedupedName(Buffer.from(filename, 'utf-8').toString('utf-8'));
  const tmpPath = path.join(UPLOAD_DIR, `.tmp-${uploadId}`);

  try {
    const fileHandle = await fsp.open(tmpPath, 'w');
    uploadSessions.set(uploadId, {
      fileHandle,
      tmpPath,
      finalName,
      fileSize,
      chunkSize,
      totalChunks,
      received: new Set(),
      lastActivity: Date.now(),
    });
    res.json({ uploadId, filename: finalName });
  } catch (err) {
    res.status(500).json({ error: 'Could not start upload' });
  }
});

app.post('/api/upload/chunk', express.raw({ type: '*/*', limit: '32mb' }), async (req, res) => {
  const uploadId = req.query.uploadId;
  const index = parseInt(req.query.index, 10);
  const session = uploadSessions.get(uploadId);

  if (!session) return res.status(404).json({ error: 'Unknown or expired upload session' });
  if (Number.isNaN(index) || index < 0 || index >= session.totalChunks) {
    return res.status(400).json({ error: 'Bad chunk index' });
  }

  const buffer = req.body;
  const position = index * session.chunkSize;

  try {
    await session.fileHandle.write(buffer, 0, buffer.length, position);
    session.received.add(index);
    session.lastActivity = Date.now();

    if (session.received.size === session.totalChunks) {
      await session.fileHandle.close();
      const finalPath = path.join(UPLOAD_DIR, session.finalName);
      await fsp.rename(session.tmpPath, finalPath);
      uploadSessions.delete(uploadId);
      return res.json({ done: true, filename: session.finalName, size: session.fileSize });
    }

    res.json({ done: false, received: session.received.size, totalChunks: session.totalChunks });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write chunk' });
  }
});

// Sweep abandoned upload sessions (browser closed mid-upload, etc.) so we don't leak file handles.
setInterval(async () => {
  const now = Date.now();
  for (const [uploadId, session] of uploadSessions.entries()) {
    if (now - session.lastActivity > STALE_UPLOAD_MS) {
      try {
        await session.fileHandle.close();
      } catch {}
      try {
        await fsp.unlink(session.tmpPath);
      } catch {}
      uploadSessions.delete(uploadId);
    }
  }
}, 5 * 60 * 1000);

// ================= HTTP + Socket.IO =================
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// deviceId -> { name, sockets: Set<socketId>, leaveTimer: Timeout|null, lastSeen }
// This is the single source of truth for "who's online" — it replaces the old
// username-keyed presence map, but keeps the same grace-period behavior.
const devices = new Map();

function broadcastPresence() {
  // Legacy-shaped event (array of display names) — kept so nothing else has to change.
  io.emit('presence', Array.from(devices.values()).map((d) => d.name));
}

function broadcastDeviceList() {
  const list = Array.from(devices.entries()).map(([deviceId, d]) => ({
    deviceId,
    name: d.name,
    online: d.sockets.size > 0,
    lastSeen: d.lastSeen,
    publicKey: d.publicKey || null,
  }));
  io.emit('devices', list);
}

function socketsForDevice(deviceId) {
  const d = devices.get(deviceId);
  return d ? Array.from(d.sockets) : [];
}

io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    // Back-compat: older clients sent just a username string.
    const isLegacy = typeof payload === 'string';
    const username = (isLegacy ? payload : payload?.username) || 'Anonymous';
    const deviceId = (!isLegacy && payload?.deviceId) || `legacy:${socket.id}`;
    const publicKey = (!isLegacy && payload?.publicKey) || null;

    const name = username.toString().slice(0, 40).trim() || 'Anonymous';
    socket.data.username = name;
    socket.data.deviceId = deviceId;

    let entry = devices.get(deviceId);
    const isFreshJoin = !entry || (entry.sockets.size === 0 && !entry.leaveTimer);

    if (!entry) {
      entry = { name, sockets: new Set(), leaveTimer: null, lastSeen: Date.now(), publicKey: null };
      devices.set(deviceId, entry);
    }
    entry.name = name; // keep display name current in case the user renamed themselves
    entry.lastSeen = Date.now();
    // The server only ever stores/relays the PUBLIC key — never a private key, and it never
    // sees message plaintext for DMs (see dm-message below). This is a public key, safe to
    // hand to anyone who asks, same as the rest of the "devices" list.
    if (publicKey) entry.publicKey = publicKey;
    if (entry.leaveTimer) {
      clearTimeout(entry.leaveTimer);
      entry.leaveTimer = null;
    }
    entry.sockets.add(socket.id);

    const groupHistory = messages.filter(
      (m) => !m.conversationId || m.conversationId === GROUP_CONVERSATION_ID
    );
    socket.emit('history', groupHistory);
    socket.emit('devices', Array.from(devices.entries()).map(([id, d]) => ({
      deviceId: id,
      name: d.name,
      online: d.sockets.size > 0,
      lastSeen: d.lastSeen,
      publicKey: d.publicKey || null,
    })));
    broadcastPresence();
    broadcastDeviceList();

    if (isFreshJoin) {
      const sysMsg = pushMessage({
        id: randomUUID(),
        conversationId: GROUP_CONVERSATION_ID,
        type: 'system',
        text: `${name} joined`,
        ts: Date.now(),
      });
      socket.broadcast.emit('message', sysMsg);
    }
  });

  // ---- Group chat (unchanged behavior; intentionally NOT end-to-end encrypted —
  //      broadcast/group E2EE needs group-key mechanics, a separate problem from the
  //      pairwise DM encryption below. See PROGRESS.md.) ----
  socket.on('chat-message', (text) => {
    const username = socket.data.username || 'Anonymous';
    if (typeof text !== 'string' || !text.trim()) return;
    const msg = pushMessage({
      id: randomUUID(),
      conversationId: GROUP_CONVERSATION_ID,
      type: 'text',
      from: username,
      text: text.slice(0, 4000),
      ts: Date.now(),
    });
    io.emit('message', msg);
  });

  socket.on('file-message', ({ name, size }) => {
    const username = socket.data.username || 'Anonymous';
    if (!name) return;
    const msg = pushMessage({
      id: randomUUID(),
      conversationId: GROUP_CONVERSATION_ID,
      type: 'file',
      from: username,
      name,
      size,
      ts: Date.now(),
    });
    io.emit('message', msg);
  });

  socket.on('typing', () => {
    const username = socket.data.username || 'Anonymous';
    socket.broadcast.emit('typing', username);
  });

  // ---- 1:1 direct messages ----
  socket.on('get-dm-history', (peerDeviceId) => {
    const myDeviceId = socket.data.deviceId;
    if (!myDeviceId || !peerDeviceId) return;
    const conversationId = dmConversationId(myDeviceId, peerDeviceId);
    const history = messages.filter((m) => m.conversationId === conversationId);
    socket.emit('dm-history', { peerDeviceId, messages: history });
  });

  socket.on('dm-message', ({ toDeviceId, ciphertext, iv }) => {
    const myDeviceId = socket.data.deviceId;
    const username = socket.data.username || 'Anonymous';
    if (!myDeviceId || !toDeviceId || typeof ciphertext !== 'string' || typeof iv !== 'string') return;

    // NOTE: this server never sees plaintext for DMs. `ciphertext`/`iv` arrived already
    // encrypted client-side (AES-GCM, key derived via ECDH — see frontend/src/crypto.js)
    // and are relayed/persisted exactly as received.
    const msg = pushMessage({
      id: randomUUID(),
      conversationId: dmConversationId(myDeviceId, toDeviceId),
      type: 'text-encrypted',
      from: username,
      fromDeviceId: myDeviceId,
      toDeviceId,
      ciphertext,
      iv,
      ts: Date.now(),
    });

    const recipientSockets = socketsForDevice(toDeviceId);
    const senderSockets = socketsForDevice(myDeviceId);
    io.to([...recipientSockets, ...senderSockets]).emit('message', msg);
  });

  socket.on('dm-file-message', ({ toDeviceId, name, size }) => {
    const myDeviceId = socket.data.deviceId;
    const username = socket.data.username || 'Anonymous';
    if (!myDeviceId || !toDeviceId || !name) return;

    const msg = pushMessage({
      id: randomUUID(),
      conversationId: dmConversationId(myDeviceId, toDeviceId),
      type: 'file',
      from: username,
      fromDeviceId: myDeviceId,
      toDeviceId,
      name,
      size,
      ts: Date.now(),
    });

    const recipientSockets = socketsForDevice(toDeviceId);
    const senderSockets = socketsForDevice(myDeviceId);
    io.to([...recipientSockets, ...senderSockets]).emit('message', msg);
  });

  socket.on('dm-typing', (toDeviceId) => {
    const myDeviceId = socket.data.deviceId;
    const username = socket.data.username || 'Anonymous';
    if (!myDeviceId || !toDeviceId) return;
    const recipientSockets = socketsForDevice(toDeviceId);
    io.to(recipientSockets).emit('dm-typing', { fromDeviceId: myDeviceId, from: username });
  });

  socket.on('disconnect', () => {
    const deviceId = socket.data.deviceId;
    if (!deviceId) return;
    const entry = devices.get(deviceId);
    if (!entry) return;

    entry.sockets.delete(socket.id);
    entry.lastSeen = Date.now();
    if (entry.sockets.size > 0) return; // still connected elsewhere (another tab)

    broadcastDeviceList(); // reflect "offline" immediately, even during the leave-message grace period

    // Grace period: only announce "left" in the group chat if they don't reconnect quickly
    entry.leaveTimer = setTimeout(() => {
      devices.delete(deviceId);
      broadcastPresence();
      broadcastDeviceList();
      const sysMsg = pushMessage({
        id: randomUUID(),
        conversationId: GROUP_CONVERSATION_ID,
        type: 'system',
        text: `${entry.name} left`,
        ts: Date.now(),
      });
      io.emit('message', sysMsg);
    }, PRESENCE_GRACE_MS);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Backend (chat + files) listening on http://0.0.0.0:${PORT}`);
  console.log(`   Files are stored in: ${UPLOAD_DIR}\n`);
});

// Big files over slow wifi can take a while — disable the default timeouts
httpServer.timeout = 0;
httpServer.headersTimeout = 0;
httpServer.keepAliveTimeout = 0;
