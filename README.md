# LAN Share

A WhatsApp-style chat + large file sharing app for devices on the same local network. One
device runs the backend + frontend, everyone else just opens a browser.

- **Chat tab** — real-time group chat (Socket.IO), online presence, "is typing…" indicator,
  and message history that's saved to disk so late joiners see everything that happened
  before they connected.
- **Attach files right in chat** — tap 📎, pick a file, it uploads and shows up as a
  downloadable bubble for everyone, just like WhatsApp.
- **Files tab** — a plain file-manager view of everything ever shared, for browsing/downloading
  outside the chat feed.

How it works: the backend streams uploads straight to disk (never buffers the whole file in
memory) and streams downloads back out with HTTP range support, so it comfortably handles
multi-gigabyte files (tested with 300MB+, works fine well past 1-2GB). Chat runs over the same
backend using Socket.IO.

## 1. Start the backend (on your "host" device)

```bash
cd backend
npm install
npm start
```

You'll see:
```
✅ Backend listening on http://0.0.0.0:3001
```

## 2. Start the frontend (same device)

```bash
cd frontend
npm install
npm run dev
```

This runs Vite with `--host`, so it listens on `0.0.0.0:5173` — reachable from other devices.

## 3. Find your host device's LAN IP

- macOS/Linux: `ifconfig | grep "inet "` (or `ip a`)
- Windows: `ipconfig` → look for "IPv4 Address"

Example: `192.168.1.42`

## 4. Open it from any other device on the same Wi-Fi/network

```
http://192.168.1.42:5173
```

The page talks to the backend at `http://192.168.1.42:3001` automatically (it defaults to
whatever hostname you loaded the page from). If your backend runs on a different machine or
port, edit the "Backend" field at the top of the page and hit Save — it's remembered per browser.

## Using chat

The first time anyone opens the page, they're asked for a display name (remembered per browser).
After that they land in the Chat tab, see who else is online, and can type messages or tap 📎
to share a file inline. Chat history is kept in `backend/messages.json` (last 500 messages) so
it's there for anyone who joins later or reloads the page.

## Notes

- **Firewall**: if the other device can't connect, your host's firewall may be blocking ports
  3001/5173. On macOS: System Settings → Network → Firewall. On Windows: Windows Defender
  Firewall → allow Node.js on private networks. On Linux: `sudo ufw allow 3001` and
  `sudo ufw allow 5173`.
- **Files** are stored in `backend/uploads/` on the host device.
- **Large files**: uploads/downloads stream directly to/from disk and support HTTP range
  requests, so multi-GB files and paused/resumed downloads work correctly.
- **No auth**: anyone who can reach the backend's IP:port can join the chat and see/download
  shared files — fine for a trusted home/office LAN, not meant for an open or public network.
- **Production-style run**: for everyday use you can instead build the frontend
  (`npm run build` in `frontend/`) and serve `frontend/dist` with any static file server, or
  add `express.static` to the backend if you'd rather run just one process. Ask if you'd like
  that wired up.
