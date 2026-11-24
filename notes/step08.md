# Step 8: Socket.IO signaling server

Theory: `Webrtc.md` §5 (signaling).

Signaling layer only: rooms + a relay. No RTCPeerConnection changes yet (that's step 9).

## What I built

| File | Role |
| ---- | ---- |
| `backend/socket/index.js` | Attaches Socket.IO to the Express `http.Server` (same port 4000), CORS from config, logs connect/upgrade/disconnect with the real client IP |
| `backend/services/roomService.js` | In-memory rooms, max 2 users: `join`, `leave`, `getPeer`, `getRoomOf`, room-name validation |
| `backend/socket/roomHandlers.js` | `join-room` / `leave-room` / `signal` in; `room-full` / `peer-joined` / `peer-left` / `signal` out |
| `backend/controllers/networkController.js` | `GET /api/network`: the laptop's LAN IPs, so the Room page can show a phone-usable link |
| `frontend/src/services/socket.js` | The single Socket.IO client (`io()` → same origin → Vite proxy) |
| `frontend/src/hooks/useSignaling.js` | `join`, `leave`, `send`, `onSignal`/`onPeerJoined`/`onPeerLeft`, status, auto-rejoin after reconnect |
| `frontend/src/pages/Room.jsx` | Room name + your name, members, socket status/transport, ping → pong |

Config: `CLIENT_ORIGIN` can now be a comma-separated list. The Vite proxy adds `X-Forwarded-For`
(`xfwd: true`), so the backend logs `192.168.0.x Android` instead of `127.0.0.1`.

## Events

| Direction | Event | Data | Notes |
| --------- | ----- | ---- | ----- |
| C → S | `join-room` | `{ roomId, name }` | ack `{ ok, roomId, you, peers }` or `{ ok:false, error }` |
| S → C | `room-full` | `{ roomId }` | the 3rd person |
| S → other | `peer-joined` | `{ id, name }` | to the user already in the room |
| C → S | `leave-room` | | also sent automatically when the Room page unmounts |
| S → other | `peer-left` | `{ id, name, reason }` | `left` / `disconnected` / `switched-room` |
| C → S | `signal` | `{ type, payload }` | ack `{ ok }` or `{ ok:false, error:'no-peer' }` |
| S → other | `signal` | `{ from, type, payload }` | **payload relayed unchanged** |

Acks (`socket.timeout(5000).emitWithAck(...)`) make request/response feel like `await fetch()`, with a timeout.

## Message sequence: two users joining

```
 Laptop (A)                        Server (Socket.IO, :4000)                    Phone (B)
    │                                       │                                       │
    │── HTTP long-poll handshake ─────────► │                                       │
    │◄──────────── sid, upgrades:[websocket]│                                       │
    │── upgrade to WebSocket ─────────────► │   ("Socket transport upgraded")       │
    │                                       │                                       │
    │── join-room {demo-1, "Laptop"} ─────► │ rooms[demo-1] = {A}                   │
    │◄────── ack {ok, you:A, peers:[]} ─────│                                       │
    │   "waiting for a peer"                │                                       │
    │                                       │ ◄──── handshake + WebSocket upgrade ──│
    │                                       │ ◄──── join-room {demo-1, "Phone"} ────│
    │                                       │ rooms[demo-1] = {A, B}                │
    │                                       │────── ack {ok, you:B, peers:[A]} ───► │
    │◄──────── peer-joined {B, "Phone"} ────│                    "peer already here"│
    │                                       │                                       │
    │── signal {ping, {sentAt,…}} ────────► │ getPeer(A) = B                        │
    │◄─────────────── ack {ok} ─────────────│── signal {from:A, ping, {…}} ───────► │
    │                                       │ ◄──── signal {pong, {sentAt}} ────────│
    │◄──── signal {from:B, pong, {…}} ──────│                                       │
    │   round trip ≈ 10 ms                  │                                       │
    │                                       │                                       │
    │                                       │ ◄──── (tab closed: socket drops) ─────│
    │◄──── peer-left {B, "disconnected"} ───│ leave(B)                              │
```

**Step 9 will use exactly this**, with `type` = `offer` / `answer` / `candidate`. Someone has to be
the offerer, to avoid glare (step 7). A natural rule: **whoever receives `peer-joined`** (the one
already in the room) creates the offer, because it knows a peer has just arrived.

## Why the server never needs to understand SDP

- The server's whole job is **"deliver this text to the other person in my room"** (step 7 proved
  a clipboard can do it). Routing needs only the **room**, not the content.
- All the WebRTC logic (codecs, ICE, DTLS fingerprints) is negotiated **end to end, between the two
  browsers**. The server isn't a party to that negotiation. The media never touches it.
- So the handler just does `io.to(peer.id).emit('signal', { from, type, payload })`. A future
  `type: 'mute'` or `type: 'renegotiate'` needs **no server change**.
- Not parsing is also safer and keeps the server simple: it can't break the SDP, has no SDP
  library to keep up to date, and swapping to another transport (WebSocket, Firebase, MQTT) changes nothing in the browsers.
- **Logs show type + size only** (`signal "offer" … [3582 B]`), never the payload. SDP contains IP
  addresses and the ICE password (`a=ice-pwd`). Verified: a test offer with `a=ice-pwd:SECRET` left no trace in the log.

The **one** security caveat: the server *could* tamper with the SDP (e.g. swap the fingerprint for an
attacker's), and DTLS would then happily connect to the attacker. End-to-end crypto trusts the signaling
channel to deliver the fingerprint honestly. That's why signaling must be authenticated and over TLS
(`wss://`), and why high-security apps add identity verification on top (comparing safety numbers, WebRTC identity providers).

## Security I'd add before this goes anywhere public

Right now anyone who can reach the server can join any room by guessing its name.

1. **Authentication**: verify who is connecting in Socket.IO middleware (`io.use((socket, next) => …)`)
   with a session cookie or a short-lived JWT passed in `io({ auth: { token } })`. Reject before any event is handled.
2. **Room authorization / validation**: unguessable room ids (UUIDs, or signed invite links), and check
   that *this user* is allowed in *this room* (e.g. the two participants of a scheduled call). Basic format
   validation (`[a-zA-Z0-9_-]{1,40}`) is already in place, mainly because room names end up in logs and URLs.
3. **Rate limits**: per socket and per IP. Max N `join-room`/s (stops room-name brute force), max M
   `signal`/s (candidates are bursty: allow ~50 in a few seconds, then throttle), max connections per IP.
   Also message size: `maxHttpBufferSize` is already lowered to 100 KB (default 1 MB).
4. **Validate message shape**: `type` from an allowlist (`offer`, `answer`, `candidate`, `ping`…), payload
   size and type per message. Already: `type` must be a non-empty string ≤ 32 chars.
5. **Origin check**: CORS is **not** access control for WebSockets (upgrades ignore it). Check
   `socket.handshake.headers.origin` against the allowlist in middleware or `allowRequest`.
6. **TLS end to end** in production (`wss://`), and don't expose dev helpers like `/api/network`.
7. **TURN credentials** (later): hand out short-lived, per-user TURN credentials from this server, never a
   static password in the frontend.
8. **Scaling note** (not security): in-memory rooms only work with ONE server process. With several,
   use the Socket.IO Redis adapter + a shared room store.

## StrictMode and cleanup in useSignaling

- The **socket is a module-level singleton**. Created once, it survives StrictMode's mount → unmount →
  mount and page navigation. The hook calls `socket.connect()` if needed, but **never disconnects on
  cleanup**: otherwise every fake unmount would show up on the server as disconnect + connect.
- Every `socket.on(event, fn)` in the effect has a matching `socket.off(event, fn)` with the **same function**
  in cleanup. Without that, StrictMode would register every listener twice, and each `ping` would be answered with two `pong`s.
- Callbacks (`onSignal`…) live in a **ref** updated on every render, so the page can pass inline functions
  without re-subscribing.
- **Unmount = `leave-room`**: navigating away from the Room page tells the peer immediately (`peer-left: left`).
- **Reconnect = re-join**: the server forgets all rooms on restart. On `connect`, the hook re-joins the room
  it was in. Tested by touching `server.js` (nodemon restart): both sides came back with new socket ids,
  re-joined, saw each other, and ping worked again.
- The transport `upgrade` listener is attached per connection, because a reconnect creates a new engine.

## Testing laptop + phone

What I verified (headless Chrome: one context on `https://localhost:5173`, one with iPhone/Pixel
emulation on `https://192.168.0.115:5173`, so through the LAN interface):

- both connect via **polling, then upgrade to WebSocket** through the Vite proxy (`wss://…/socket.io`)
- join, `peer-joined`, member lists on both sides, ping/pong both ways (**~10 ms round trip** via the server)
- 3rd user → `room-full`; invalid name → validation message
- navigate away → `peer-left (left)`; close the tab → `peer-left (disconnected)` (instant, no timeout)
- backend restart → auto re-join

To do on the real phone: open `https://192.168.0.115:5173/room`. The laptop's Room page shows this link once you're
in a room, and the phone opens it with the room name prefilled. The backend terminal should show
`connected via polling from 192.168.0.x Android` (or `iOS`).

## Exercises

1. **Three-way room?** Raise `MAX_USERS_PER_ROOM` to 3. What breaks in `getPeer` and in the `signal`
   relay? Change `signal` to need a `to` field. (That's the start of a mesh call.)
2. **Rate limit.** Add a per-socket token bucket: max 20 `signal` events per second. Spam ping from the
   console (`for (let i=0;i<100;i++) …`) and watch it get throttled.
3. **Auth.** Require `io({ auth: { token: 'letmein' } })` and reject other connections in `io.use(...)`.
   What does the client see (`connect_error`)? Show it on the Room page.
