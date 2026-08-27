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
const MAX_HISTORY = 500;
const PRESENCE_GRACE_MS = 5000; // don't announce "left" until this long after last connection drops
const STALE_UPLOAD_MS = 30 * 60 * 1000; // abandoned in-progress uploads get swept after this long

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
let messages = [];
try {
  if (fs.existsSync(MESSAGES_FILE)) {
    messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
  }
} catch {
  messages = [];
}

function saveMessages() {
  fs.writeFile(MESSAGES_FILE, JSON.stringify(messages.slice(-MAX_HISTORY)), () => {});
}

function pushMessage(msg) {
  messages.push(msg);
  if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);
  saveMessages();
  return msg;
}

// Mark every chat message that references this filename as deleted (keeps history in sync
// with the Files tab, so people can't click a download link for something that's gone).
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

// username -> { sockets: Set<socketId>, leaveTimer: Timeout|null }
const userSessions = new Map();

function broadcastPresence() {
  io.emit('presence', Array.from(userSessions.keys()));
}

io.on('connection', (socket) => {
  socket.on('join', (rawName) => {
    const username = (rawName || 'Anonymous').toString().slice(0, 40).trim() || 'Anonymous';
    socket.data.username = username;

    let entry = userSessions.get(username);
    const isFreshJoin = !entry || (entry.sockets.size === 0 && !entry.leaveTimer);

    if (!entry) {
      entry = { sockets: new Set(), leaveTimer: null };
      userSessions.set(username, entry);
    }
    if (entry.leaveTimer) {
      clearTimeout(entry.leaveTimer);
      entry.leaveTimer = null;
    }
    entry.sockets.add(socket.id);

    socket.emit('history', messages);
    broadcastPresence();

    // Only announce a join if this is genuinely a new person (not a quick reconnect/extra tab)
    if (isFreshJoin) {
      const sysMsg = pushMessage({
        id: randomUUID(),
        type: 'system',
        text: `${username} joined`,
        ts: Date.now(),
      });
      socket.broadcast.emit('message', sysMsg);
    }
  });

  socket.on('chat-message', (payload) => {
    const username = socket.data.username || 'Anonymous';
    const text = typeof payload === 'string' ? payload : payload?.text;
    if (typeof text !== 'string' || !text.trim()) return;
    const msg = pushMessage({
      id: randomUUID(),
      type: 'text',
      from: username,
      text: text.slice(0, 4000),
      replyTo: normalizeReply(payload?.replyTo),
      ts: Date.now(),
    });
    io.emit('message', msg);
  });

  socket.on('file-message', ({ name, size, caption, replyTo } = {}) => {
    const username = socket.data.username || 'Anonymous';
    if (!name) return;
    const msg = pushMessage({
      id: randomUUID(),
      type: 'file',
      from: username,
      name,
      size,
      caption: typeof caption === 'string' ? caption.slice(0, 4000) : '',
      replyTo: normalizeReply(replyTo),
      ts: Date.now(),
    });
    io.emit('message', msg);
  });

  socket.on('typing', () => {
    const username = socket.data.username || 'Anonymous';
    socket.broadcast.emit('typing', username);
  });

  socket.on('disconnect', () => {
    const username = socket.data.username;
    if (!username) return;
    const entry = userSessions.get(username);
    if (!entry) return;

    entry.sockets.delete(socket.id);
    if (entry.sockets.size > 0) return; // still connected elsewhere (another tab/device)

    // Grace period: only announce "left" if they don't reconnect quickly
    entry.leaveTimer = setTimeout(() => {
      userSessions.delete(username);
      broadcastPresence();
      const sysMsg = pushMessage({
        id: randomUUID(),
        type: 'system',
        text: `${username} left`,
        ts: Date.now(),
      });
      io.emit('message', sysMsg);
    }, PRESENCE_GRACE_MS);
  });
});

function normalizeReply(reply) {
  if (!reply || typeof reply !== 'object' || !reply.id || !reply.from) return null;
  return {
    id: String(reply.id),
    from: String(reply.from).slice(0, 40),
    type: reply.type === 'file' ? 'file' : 'text',
    text: typeof reply.text === 'string' ? reply.text.slice(0, 180) : '',
    name: typeof reply.name === 'string' ? reply.name.slice(0, 180) : '',
  };
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Backend (chat + files) listening on http://0.0.0.0:${PORT}`);
  console.log(`   Files are stored in: ${UPLOAD_DIR}\n`);
});

// Big files over slow wifi can take a while — disable the default timeouts
httpServer.timeout = 0;
httpServer.headersTimeout = 0;
httpServer.keepAliveTimeout = 0;
