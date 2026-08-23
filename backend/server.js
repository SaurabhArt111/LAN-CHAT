import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
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

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());

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

// ================= File upload/download (used for both the Files tab and chat attachments) =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
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
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 * 1024 }, // 50GB safety cap, not a real limit
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  res.json({ ok: true, filename: req.file.filename, size: req.file.size });
});

app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).map((name) => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, name));
    return { name, size: stat.size, mtime: stat.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
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
  res.json({ ok: true });
});

// ================= HTTP + Socket.IO =================
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// socket.id -> username
const onlineUsers = new Map();

function broadcastPresence() {
  io.emit('presence', Array.from(new Set(onlineUsers.values())));
}

io.on('connection', (socket) => {
  socket.on('join', (rawName) => {
    const username = (rawName || 'Anonymous').toString().slice(0, 40).trim() || 'Anonymous';
    onlineUsers.set(socket.id, username);
    socket.data.username = username;

    // Send chat history only to the joining client
    socket.emit('history', messages);
    broadcastPresence();

    const sysMsg = pushMessage({
      id: randomUUID(),
      type: 'system',
      text: `${username} joined`,
      ts: Date.now(),
    });
    socket.broadcast.emit('message', sysMsg);
  });

  socket.on('chat-message', (text) => {
    const username = socket.data.username || 'Anonymous';
    if (typeof text !== 'string' || !text.trim()) return;
    const msg = pushMessage({
      id: randomUUID(),
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

  socket.on('disconnect', () => {
    const username = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    broadcastPresence();
    if (username) {
      const sysMsg = pushMessage({
        id: randomUUID(),
        type: 'system',
        text: `${username} left`,
        ts: Date.now(),
      });
      io.emit('message', sysMsg);
    }
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
