# LAN-CHAT Upgrade — Progress

The full production spec (E2EE, device discovery, PWA/offline, encrypted backups, settings
system, etc.) is a multi-week build. Rather than claim it's all done, here's the real status,
phase by phase, updated as work lands.

## ✅ Phase 1 — 1:1 chats + device list (DONE)

**What changed:**
- Every device now generates a persistent `deviceId` (stored in `localStorage`, survives
  reloads) alongside the existing display name.
- The old single group chat is preserved **exactly as it worked before** — it's now just the
  "Group" row at the top of a new chat list.
- New: one-to-one conversations. Every other online/known device shows up as its own row
  (avatar, online/last-seen status, last-message preview). Tapping a row opens a private
  conversation with its own message history, typing indicator, and file attachments —
  isolated from the group chat and from every other 1:1 conversation.
- The "joined"/"left" grace-period fix and file-delete-sync from before both still work,
  now keyed by device rather than by display name (more correct: two tabs with the same
  name no longer confuse each other).
- Legacy clients that only send a plain username (pre-Phase-1 protocol) still work —
  the server detects and handles both shapes.

**How it was tested (not just claimed):**
- Backend: a Node script drove 3 separate socket connections (Alice, Bob, Carol) directly
  against the real server — confirmed group chat behavior is byte-for-byte unchanged, device
  list reports all three, a DM from Alice→Bob is delivered to Bob and Alice (echo) but
  **never** reaches Carol in any form, and DM history requests are correctly scoped per pair
  (Carol asking for "her" history with Alice gets an empty result, not Alice & Bob's chat).
- Legacy compatibility + presence grace period re-verified against the new device-keyed
  model (two rapid reconnects of the *same* device produce zero spam; a real disconnect
  still produces exactly one "left" message).
- Frontend: the actual built production bundle (not a hand-written stand-in) was loaded
  into a real DOM (jsdom) for two simulated devices, driven with genuine click events —
  confirmed the chat list renders both rows, opening "Group" and sending a message renders
  it and updates the list preview live on the other device, opening the DM with Bob shows
  the right title, a DM sent from Alice shows up as an **unread** row for "Alice" on Bob's
  side without touching the Group preview.
- **Not tested:** real visual rendering/layout in an actual browser (Chrome/Safari/Firefox).
  A full headless-browser run isn't available in this environment — the sandbox can't reach
  the CDN Puppeteer needs to download a Chrome binary. You should sanity-check the visual
  layout once you run this on your own machine; the interaction logic itself has been
  verified as above.

## ✅ Phase 2 — End-to-end encryption for 1:1 chats (DONE)

**What changed:**
- Every device generates a persistent ECDH (P-256) keypair on first launch. The private key
  never leaves the device (kept in `localStorage`, never transmitted) — only the public key
  is shared, via the existing device list.
- For any 1:1 conversation, both devices independently derive the *same* AES-256-GCM key
  from their own private key + the other's public key (standard ECDH property) — the key
  itself is never sent over the network.
- DM text messages are now encrypted client-side before they reach the server. The server's
  `dm-message` handler only ever sees and stores `{ciphertext, iv}` — no plaintext field
  exists in that code path anymore.
- A tappable 🔒 badge in any DM header shows a short fingerprint (derived from the shared
  key) that two people can read aloud to each other to confirm no one is intercepting the
  conversation — the same idea as Signal's "safety numbers."
- Trust-on-first-use (TOFU): the first time you see a device's public key, it's pinned
  locally. If that device's key ever changes afterwards (identity substituted/spoofed), the
  badge turns into ⚠️, a warning banner appears, and **sending is blocked** until you
  explicitly tap "I understand, continue" — it is never silently accepted.
- **Explicitly out of scope this phase:** the Group chat remains plaintext (broadcast E2EE
  needs group-key mechanics — a different, harder problem than pairwise DMs — and rushing it
  here risked getting it wrong). File contents in DMs are also not yet encrypted, only the
  filename/size metadata that was already there — only DM *text* messages are encrypted so
  far. Both are natural next increments, not forgotten.

**How it was tested (not just claimed):**
- Crypto primitives tested in complete isolation first, before touching the app: confirmed
  both sides of a pair independently derive the identical key/fingerprint, encryption
  produces genuine ciphertext, round-trip decryption works, tampering is detected
  (authenticated encryption — AES-GCM, not something custom-built), a wrong key fails to
  decrypt, and different peer-pairs get cryptographically distinct keys. 6/6 checks passed.
- Backend integration test against the real running server: sent a real encrypted DM, then
  **read the server's actual `messages.json` file off disk** and confirmed the plaintext
  never appears in it anywhere — only ciphertext. Also confirmed a non-participant device,
  even if handed the exact wire payload, cannot decrypt it. 8/8 checks passed.
- Full UI test: the actual built production bundle, loaded into a real DOM, driving two
  simulated devices with genuine clicks — opened a DM, sent a message, confirmed the
  recipient's UI decrypted and rendered the correct plaintext, confirmed both sides' tapped
  fingerprint codes match exactly, and re-confirmed the server's on-disk file has no
  plaintext. 6/6 checks passed.
- Key-change/TOFU warning tested end-to-end: had an "impersonator" claim a real device's
  exact `deviceId` with a different keypair mid-session, and confirmed the other party's UI
  correctly flags it (⚠️ badge + banner), **blocks sending** while flagged, and only clears
  after an explicit "I understand, continue" tap. 7/7 checks passed.
- Group chat regression check: confirmed the group tab shows no encryption badge (correct —
  it's intentionally plaintext) and that messages still send/receive live exactly as before.
  3/3 checks passed.
- **Not tested:** real visual rendering in an actual browser, for the same reason as
  Phase 1 (no Chrome binary available in this sandbox). Interaction logic is verified as
  above; give the fingerprint panel and warning banner a visual check once you run this
  locally.

## ⏳ Phase 3 — PWA + offline app shell (NOT STARTED)

Installable manifest, service worker, offline caching of the app shell, update-available UI.

## ⏳ Phase 4 — Device discovery + settings (NOT STARTED)

Auto-detecting devices on the LAN without manually typing an IP, PIN-gated connections, a
proper settings screen (theme, storage, backup/export).

## Known simplifications vs. the full spec

- `deviceName` and the chat display name are still the same thing (the name you enter at
  first launch) — a minor simplification, not a security issue, since the actual identity
  guarantee comes from the keypair, not the display name.
- Only DM *text* is end-to-end encrypted so far. Group chat and DM file transfers are
  explicitly still plaintext-metadata — see Phase 2 notes above.
- The private key is stored as an extractable JWK in `localStorage` rather than as a
  non-extractable `CryptoKey` in IndexedDB. This keeps the key on-device and off the network
  (the core E2EE property), but a more mature build would make it non-extractable to also
  resist an XSS-style attack reading it out of storage — a reasonable follow-up, not a gap
  in the "server can't read your messages" guarantee this phase focused on.
