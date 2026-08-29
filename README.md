# LAN Chat

A WhatsApp-style chat + large file sharing app for devices on the same local network. One
device runs the backend + frontend, everyone else just opens a browser.

- **Chat tab** — real-time group chat (Socket.IO) plus 1:1 encrypted DMs, online presence,
  "is typing…" indicator, and message history that's saved to disk so late joiners see
  everything that happened before they connected. Quick reconnects (page refresh, phone
  lock/wake) stay quiet — you only see a "joined"/"left" message when someone's actually
  gone for more than a few seconds, and duplicate join/leave lines are suppressed both on
  the server and the client.
- **Chat list always shows everyone** — once a device has said hello, its row (and its
  message/file history) stays in the chat list even while it's offline, marked with a
  "last seen" time. Nothing about your chat history depends on the other person being
  online right now.
- **Reply, forward, copy, delete, multi-select** — double-click any message to reply to it
  (adds a quoted preview others can tap to jump to); right-click (or long-press on touch) any
  message or attachment for a context menu with Reply / Forward / Copy / Delete / Select.
  "Select" turns on multi-select mode for batch-forwarding, copying, or deleting several
  messages or attachments at once.
- **Attach files or media right in chat** — tap 📎, drag-and-drop, or paste (Ctrl/Cmd+V) an
  image or file straight into the conversation. Any of those opens a preview-and-send modal
  first, so you can add a caption before it actually uploads. Shared images/files open in a
  dedicated viewer (full-size image, video/audio player, or a generic file card) with a
  Download button, instead of just linking out.
- **Files tab** — a plain file-manager view of everything ever shared, for browsing/downloading
  outside the chat feed. Delete something here and any chat message pointing to it updates
  live for everyone, instead of turning into a dead "Not found" link.
- **Fast large-file transfer** — files are split into 8MB chunks and uploaded several at once
  in parallel, which both speeds up transfer over LAN and makes multi-gigabyte files (tested
  well past 2-3GB) more resilient to a single flaky chunk.
- **Notifications** — enable/disable in Settings. Uses the browser's Notification API (no
  external push service required, since this app is meant to run over plain HTTP on a LAN
  address rather than a publicly reachable HTTPS host) to nudge you about new messages when
  the tab isn't focused.
- **Settings** — edit your display name (updates live for everyone), and pick a theme: Light,
  Dark, or System (default — follows your OS setting automatically, live).

How it works: the backend writes each chunk straight to disk at its correct byte offset (never
buffers the whole file in memory) and streams downloads back out with HTTP range support. Chat
and live updates (typing, presence, replies, deletes, file-deleted) run over the same backend
using Socket.IO.

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

The first time anyone opens the page, they're asked for a display name (remembered per browser,
editable later from Settings ⚙️). After that they land in the Chat tab, see who else is online
(and who's offline but still reachable in history), and can type messages, tap 📎/drag-and-drop/paste
to share a file or media inline, double-click a message to reply, or right-click/long-press a
message for more actions. Chat history is kept in `backend/data/messages.json` (last 500 messages
per conversation) so it's there for anyone who joins later or reloads the page.

## Notes

- **Firewall**: if the other device can't connect, your host's firewall may be blocking ports
  3001/5173. On macOS: System Settings → Network → Firewall. On Windows: Windows Defender
  Firewall → allow Node.js on private networks. On Linux: `sudo ufw allow 3001` and
  `sudo ufw allow 5173`.
- **Data folder**: everything the backend persists — chat history (`messages.json`), the
  device roster (`devices.json`), and every shared file (`uploads/`) — lives under
  `backend/data/`. Back up, move, or wipe that one folder to back up, move, or reset the
  whole app. Upgrading from an older copy of this repo migrates `backend/uploads/` and
  `backend/messages.json` into `backend/data/` automatically the first time you start it.
- **Notifications**: click Enable in Settings once, and grant the browser's permission
  prompt. Nothing is sent through an external push service — the backend and frontend talk
  directly over your LAN, same as the rest of the app, so there's no dependency on internet
  access for notifications to work.
- **Large files**: uploads are split into 8MB chunks sent 4-at-a-time in parallel (each chunk
  retries up to 3 times on failure), then reassembled on the host. Downloads stream directly
  from disk with HTTP range support, so pausing/resuming a download also works. This has been
  tested well past 2-3GB.
- **Deleting a file**: removing it from the Files tab immediately marks any chat message that
  shared it as "File removed" for everyone currently connected — no more dead links.
- **Deleting a message**: right-click (or long-press) a message you sent and choose Delete, or
  select several with "Select" and use the multi-select action bar. You can only delete your
  own messages — the server checks this too, not just the UI.
- **No auth**: anyone who can reach the backend's IP:port can join the chat and see/download
  shared files — fine for a trusted home/office LAN, not meant for an open or public network.
- **Production-style run**: for everyday use you can instead build the frontend
  (`npm run build` in `frontend/`) and serve `frontend/dist` with any static file server, or
  add `express.static` to the backend if you'd rather run just one process. Ask if you'd like
  that wired up.
