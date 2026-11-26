# Step 11 Q&A: full-mesh group room (chat only)

A self-test for everything in step 11. Read the question, answer it in your head (or out loud), then open **Answer**.
Questions go from easy to hard inside each section.

> **Which code is this about?** Step 11 as committed in **`2615e64`** ("Step 11: group room as a full mesh (chat only)").
> Steps 12–15 later changed `useMeshRoom.js`, `groupHandlers.js` and `groupRoomService.js` (clientId keys, perfect
> negotiation…), so the line numbers below are from that commit. View a file exactly as it was with:
>
> ```bash
> git show 2615e64:frontend/src/hooks/useMeshRoom.js | cat -n
> ```
>
> Where a later step changed the behaviour, the answer says so ("**Later:** …").

Theory: `~/Desktop/Code/functionality/Webrtc.md` §5 (signaling), §7 (glare), §19 (perfect negotiation), §20.1 (mesh).

---

## Table of contents

1. [Mesh basics](#1-mesh-basics) (Q1–Q5)
2. [Backend](#2-backend) (Q6–Q14)
3. [Socket.IO](#3-socketio) (Q15–Q21)
4. [Frontend](#4-frontend) (Q22–Q30)
5. [Signaling & glare](#5-signaling--glare) (Q31–Q35)
6. [React](#6-react) (Q36–Q39)
7. [Failure scenarios: "what happens if…"](#7-failure-scenarios-what-happens-if) (Q40–Q46)
8. [Interview-style questions](#8-interview-style-questions) (Q47–Q56)
9. [Rapid-fire](#9-rapid-fire) (15 one-liners)

---

## 1. Mesh basics

### Q1. What is a "full mesh" group call?

<details><summary>Answer</summary>

**Simply:** everybody connects directly to everybody else. There is no media server in the middle. If four people are
in the room, each browser has three separate connections, one to each of the others.

**Technically:** each pair of participants has its own `RTCPeerConnection`, with its own ICE agent (candidates,
connectivity checks, selected path), its own DTLS handshake and keys, and (in step 11) its own `"chat"` data channel
(SCTP). The signaling server only helps the pairs find each other. Once a pair is connected, their data goes browser ↔ browser.

```
      A ─────── B          4 people → 6 connections
      │ ╲     ╱ │          each browser holds 3
      │   ╲ ╱   │          the server only relays signaling,
      │   ╱ ╲   │          never the chat messages
      │ ╱     ╲ │
      D ─────── C
```

In the code, "one connection per other person" is literally a `Map` of peers, each with its own `pc`:

```js
// frontend/src/hooks/useMeshRoom.js:13-15 (2615e64)
// The data structure: peersRef.current = Map(peerId → entry)
//   peerId = the other participant's socket id (what the server uses for `to`/`from`)
//   entry  = { id, name, joinedAt, role, pc, dataChannel, state, pending, counts }
```

**Remember:** mesh = one `RTCPeerConnection` per pair of people, no media server.
</details>

### Q2. How many connections does a mesh of N people have, and why N×(N−1)/2?

<details><summary>Answer</summary>

**Simply:** every person connects to the N−1 others. Count from each person's point of view and you get N×(N−1),
but then each connection is counted twice (A→B and B→A are the same connection), so divide by 2.

| N | Connections in the room | Per browser |
|---|---|---|
| 2 | 1 | 1 |
| 3 | 3 | 2 |
| 4 | 6 | 3 |
| 5 | 10 | 4 |
| 6 | 15 | 5 |
| 10 | 45 | 9 |

**Technically:** the room total grows **quadratically**, while each browser's load grows **linearly** (N−1). The
server computes the room total in its stats, and the page shows it in `MeshDiagram`:

```js
// backend/services/groupRoomService.js:63-66 (2615e64)
export function stats() {
  let connections = 0;
  for (const room of rooms.values()) connections += (room.size * (room.size - 1)) / 2;
  return { groups: rooms.size, users: socketToRoom.size, meshConnections: connections };
}
```

**Remember:** room total N×(N−1)/2 (quadratic), per person N−1 (linear).
</details>

### Q3. Why is the room limited to 6 people?

<details><summary>Answer</summary>

**Simply:** for chat alone a mesh could hold more, but this mesh is the base for video (step 12). With video, every
person uploads and **encodes** their camera once per other person. At 6 people that's 5 uploads and 5 encodes per
device, which is about the practical ceiling for a laptop, and beyond what a phone can do.

**Technically:** the limit lives in the service, and `join()` refuses the 7th socket:

```js
// backend/services/groupRoomService.js:14, 28-29 (2615e64)
export const MAX_USERS_PER_GROUP = 6;
…
  if (!room.has(socketId)) {
    if (room.size >= MAX_USERS_PER_GROUP) return { ok: false, reason: 'full' };
```

6 people = 15 connections in the room. **Later:** step 13 measured it: on one laptop the mesh saturated the CPU at 4 tabs.

**Remember:** 6 is a video-era budget: N−1 uploads + N−1 encodes per person.
</details>

### Q4. What's the difference between the 1:1 room (steps 8–10) and the mesh room?

<details><summary>Answer</summary>

**Simply:** in 1:1 there's exactly one "other person", so the server can relay "to the other one". In a mesh there
are up to five others, so every message must say **who it's for**.

| | 1:1 (`roomHandlers.js`) | Mesh (`groupHandlers.js`) |
|---|---|---|
| Max users | 2 | 6 |
| Connections per browser | 1 | N−1 |
| Relay | "the other user" (`getPeer`) | **unicast to `to`** |
| Events | `join-room`, `signal`, `peer-joined` | `group:join`, `group:signal`, `group:participant-joined` |
| Who offers | the user already in the room | the **new** joiner |
| Socket.IO room name | `roomId` | `group:${roomId}` |

**Technically:** both run on the **same socket**. `socket/index.js` registers both handler sets on every connection.
They don't interfere because the event names and room names differ:

```js
// backend/socket/index.js:39-40 (2615e64)
    registerRoomHandlers(io, socket); // 1:1 rooms (steps 8–10)
    registerGroupHandlers(io, socket); // group mesh rooms (step 11)
```

**Remember:** 1:1 relays to "the other one". The mesh must address every message.
</details>

### Q5. Does the server see the chat messages in step 11?

<details><summary>Answer</summary>

**Simply:** no. Chat goes over the WebRTC data channels, browser to browser. The server only sees signaling: join,
leave, offers, answers and candidates.

**Technically:** `sendChat` writes straight into each peer's `RTCDataChannel` (SCTP over DTLS over the ICE path). No
`socket.emit` is involved:

```js
// frontend/src/hooks/useMeshRoom.js:466-470 (2615e64)
      for (const e of all) {
        if (e.dataChannel?.readyState === 'open') {
          e.dataChannel.send(data);
          sent++;
        }
```

The `MeshDiagram` makes this visible: lines between two *other* people are dashed, because those connections exist,
but you (and the server) can't see them.

**Remember:** signaling goes through the server, chat goes peer-to-peer.
</details>

---

## 2. Backend

### Q6. What are `rooms` and `socketToRoom`, and why have both?

<details><summary>Answer</summary>

**Simply:** `rooms` answers "who is in room X?". `socketToRoom` answers "which room is this socket in?". Both questions
come up all the time, so each gets a map that answers it instantly.

```js
// backend/services/groupRoomService.js:6-7, 16-17 (2615e64)
//   rooms:         roomId   → Map(socketId → { socketId, name, joinedAt })
//   socketToRoom:  socketId → roomId   (lets disconnect find the room quickly)
const rooms = new Map();
const socketToRoom = new Map();
```

```
rooms                                         socketToRoom
"standup" → Map { "s1A" → {A}, "s2B" → {B} }  "s1A" → "standup"
"lunch"   → Map { "s3C" → {C} }               "s2B" → "standup"
                                              "s3C" → "lunch"
```

**Technically:**
- `group:signal` and `disconnect` only know `socket.id`. `socketToRoom` gives the room in O(1), with no scanning every room.
- The inner value is a `Map` (not an array): O(1) membership checks, and **insertion order** = join order, so
  `listParticipants` returns the oldest first for free.
- The module has **no Socket.IO code**: it's pure data logic, easy to unit-test, and replaceable with Redis later.

**Remember:** two indexes, one per question: room → members, member → room.
</details>

### Q7. Walk through `group:join` on the server.

<details><summary>Answer</summary>

**Simply:** validate the room name → leave any other group room → clean the name → add to the room (or refuse if full)
→ join the Socket.IO room → tell the others → reply to the newcomer with who is already there.

```js
// backend/socket/groupHandlers.js:50-74 (2615e64)
  socket.on('group:join', ({ roomId, name } = {}, ack) => {
    const error = groups.validateRoomId(roomId);                 // 1. /^[a-zA-Z0-9_-]{1,40}$/
    if (error) return reply(ack, { ok: false, error });

    const current = groups.getRoomOf(socket.id);                 // 2. switching rooms?
    if (current && current !== roomId) leaveCurrentGroup('switched-room');

    socket.data.groupName = groups.cleanName(name);              // 3. trim, max 30, default "Anonymous"
    const result = groups.join(roomId, { socketId: socket.id, name: socket.data.groupName });
    if (!result.ok) { … return reply(ack, { ok: false, error: 'room-full' }); }   // 4.

    socket.join(ioRoom(roomId));                                 // 5. Socket.IO room "group:<id>"
    socket.to(ioRoom(roomId)).emit('group:participant-joined', result.you);   // 6. others first
    …
    return reply(ack, { ok: true, roomId, you: result.you, participants: result.participants });  // 7. then the ack
  });
```

**Technically:** `join()` is **idempotent**. If the socket is already in the room (`room.has(socketId)`), it just
returns the current list. `({ roomId, name } = {})` protects against a client sending no payload (destructuring
`undefined` would throw). `participants` excludes the caller and is oldest-first.

**Remember:** validate → join the data → join the Socket.IO room → notify others → ack the newcomer.
</details>

### Q8. Walk through leaving: `group:leave`, switching rooms, and `disconnect`.

<details><summary>Answer</summary>

**Simply:** all three paths call the same function, so cleanup is identical whether you click Leave, join another
room, or close the tab.

```js
// backend/socket/groupHandlers.js:42-48, 76-79, 101 (2615e64)
  function leaveCurrentGroup(reason) {
    const left = groups.leave(socket.id);      // data: remove from both maps
    if (!left) return;                         // wasn't in a group room: nothing to do
    socket.leave(ioRoom(left.roomId));         // Socket.IO room
    socket.to(ioRoom(left.roomId)).emit('group:participant-left', { socketId: socket.id, name: left.user?.name, reason });
    …
  }
  socket.on('group:leave', (ack) => { leaveCurrentGroup('left'); reply(ack, { ok: true }); });
  socket.on('disconnect', () => leaveCurrentGroup('disconnected'));
```

**Technically:**
- `groups.leave()` deletes from `socketToRoom` **and** from the room's Map, then deletes the room itself when it's empty
  (`if (room && room.size === 0) rooms.delete(roomId)`, line 44), so empty rooms never leak memory.
- `reason` (`left` / `switched-room` / `disconnected`) reaches the other clients for logging and UI. **Later:** step 13 uses
  it to tell a socket blip from a real leave.
- Calling `socket.leave()` *before* `socket.to(...).emit` is fine: `socket.to()` excludes the sender anyway.

**Remember:** one cleanup function for every way of leaving, and empty rooms are deleted.
</details>

### Q9. Why does `group:signal` need `to` and `from`? Why wasn't the 1:1 relay enough?

<details><summary>Answer</summary>

**Simply:** C is negotiating with A and with B **at the same time**: two offers, two answers, two sets of candidates.
Each message belongs to exactly one of those connections. `to` tells the server where to deliver it. `from` tells the
receiver which of its connections it's for.

**Technically:** every pair's SDP is different (ICE ufrag/password, DTLS fingerprint), and candidates only make sense
for the connection that gathered them. If B received C's offer meant for A, B would answer a negotiation that isn't
its own, C would apply B's answer to the C↔A connection, and nothing would match.

```
C's browser                     Server                         A's browser
pc(C↔A) offer ──▶ group:signal {to:"sA", type:"offer"}
                       │ getParticipant(room, "sA") ✓
                       └─▶ io.to("sA").emit('group:signal', {from:"sC", type:"offer"}) ──▶ peersRef.get("sC") → pc(A↔C)
pc(C↔B) offer ──▶ group:signal {to:"sB", …} ──▶ io.to("sB") … {from:"sC"} ─────────────▶ B: peersRef.get("sC") → pc(B↔C)
```

```js
// backend/socket/groupHandlers.js:94-95 (2615e64)
    // Unicast: io.to(<socket id>) reaches exactly that one socket.
    io.to(target.socketId).emit('group:signal', { from: socket.id, type, payload });
```

Note that the server sets `from` itself, from `socket.id`. The client can't fake who a message came from.

**Remember:** `to` routes the message, `from` picks the connection, and the server stamps `from` (never trusted from the client).
</details>

### Q10. Unicast vs broadcast: which events use which, and why?

<details><summary>Answer</summary>

**Simply:** news that concerns everyone (someone joined or left) is **broadcast** to the room. Negotiation messages
concern exactly one pair, so they're **unicast** to one socket.

| Event | Delivery | Code |
|---|---|---|
| `group:participant-joined` | broadcast to the room, except the newcomer | `socket.to(ioRoom(roomId)).emit(…)` (line 69) |
| `group:participant-left` | broadcast to the room, except the leaver | `socket.to(ioRoom(left.roomId)).emit(…)` (line 46) |
| `group:signal` | unicast to one socket | `io.to(target.socketId).emit(…)` (line 95) |
| ack replies | back to the sender only | `reply(ack, …)` |

**Technically:** broadcasting signaling would also leak every SDP (IP addresses, ICE credentials) to people it
wasn't meant for, and multiply server traffic by N−1.

**Remember:** membership news is broadcast, negotiation is unicast.
</details>

### Q11. Why does the server validate `to`? What exactly does it check?

<details><summary>Answer</summary>

**Simply:** without the check, any client could use the server to send messages to **any** connected socket: someone
in another room, someone in a 1:1 call, or itself. The server only delivers to people in **your** group room.

```js
// backend/socket/groupHandlers.js:82-92 (2615e64)
    if (typeof type !== 'string' || !type || type.length > MAX_TYPE_LENGTH) {
      return reply(ack, { ok: false, error: 'invalid-type' });          // type: a short string
    }
    const roomId = groups.getRoomOf(socket.id);
    if (!roomId) return reply(ack, { ok: false, error: 'not-in-room' }); // sender must be in a group
    const target = typeof to === 'string' && to !== socket.id ? groups.getParticipant(roomId, to) : null;
    if (!target) {                                                       // `to` must be a string, not me,
      …                                                                  // and in MY room
      return reply(ack, { ok: false, error: 'no-such-participant' });
    }
```

**Technically:** the most common real-world failure is not an attack but a **race**: the target left while the
message was in flight. The sender then gets `no-such-participant` in its ack and logs it (`useMeshRoom.js:92`).
The payload itself is **never parsed**, only its size is logged. Total message size is capped by
`maxHttpBufferSize: 100_000` in `socket/index.js:27`.

**Remember:** the server checks sender in a room, `to` in the same room, `to` ≠ me, and `type` sane. It never parses the payload.
</details>

### Q12. Why are the Socket.IO rooms named `group:<roomId>` instead of just `<roomId>`?

<details><summary>Answer</summary>

**Simply:** Socket.IO has **one flat namespace of room names** per server. The 1:1 handlers already use the plain room
name. Without a prefix, a 1:1 room "test" and a group room "test" would be the same Socket.IO room, and each would
receive the other's broadcasts.

```js
// backend/socket/groupHandlers.js:30-32 (2615e64)
// Socket.IO room names are shared with the 1:1 rooms: prefix them so
// "test" (1:1) and "test" (group) never receive each other's broadcasts.
const ioRoom = (roomId) => `group:${roomId}`;
```

**Technically, and more importantly:** every socket is automatically in a room named after **its own socket id**
(that's how `io.to(socketId)` works, see Q19). A room name chosen by a user could therefore collide with someone's
socket id. With the prefix, a group room can never be a socket's private room, because socket ids never start
with `group:`. (The 1:1 handlers from step 8 don't prefix. See Q51.) **Later:** step 14 used `sfu:` the same way.

**Remember:** prefix user-chosen room names: one namespace is shared by features *and* by private socket-id rooms.
</details>

### Q13. How do the ack callbacks work, on both ends?

<details><summary>Answer</summary>

**Simply:** an ack is a reply to one specific message. The client sends `group:join` and waits for **that** answer,
like an HTTP request, but over the existing socket.

**Server:** the last argument of the handler is a function. Calling it sends the reply. `reply()` guards against
clients that didn't ask for one:

```js
// backend/socket/groupHandlers.js:34-36 (2615e64)
const reply = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};
```

**Client:** `emitWithAck` returns a promise of the reply. `timeout()` makes it reject if no answer comes:

```js
// frontend/src/hooks/useMeshRoom.js:91 (2615e64)
        const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('group:signal', { to, type, payload });
```

**Technically:** acks give request/response semantics and an **error channel** (`{ ok: false, error }`) without
inventing `*-result` events. Errors are part of the protocol: `room-full`, `no-such-participant`, `invalid-type`,
`not-in-room`, or a client-side `timeout` (5 s).

**Remember:** event = "something happened", ack = "here's the answer to your request".
</details>

### Q14. Why must `participant-joined` reach the others *before* the newcomer's ack? Is that guaranteed?

<details><summary>Answer</summary>

**Simply:** existing users should know "C is here" (and C's name) **before** C's offer arrives. The server emits
`participant-joined` first and replies to C afterwards. C only sends offers after it receives the reply. So by the time
C's offer reaches A, A has already been told about C.

```
 A's connection to server                Server                 C's connection to server
                                           │◀── group:join ─────── C
   ◀── participant-joined(C) ──────────────│ ① emitted first
                                           │── ack {participants:[A,B]} ──▶ C  ②
                                           │◀── group:signal {to:A, offer} ── C ③ (only after the ack)
   ◀── group:signal {from:C, offer} ───────│ ④
   A's connection delivers ① before ④: same connection, FIFO order
```

**Technically:** Socket.IO doesn't order messages *across* different connections. What makes this work is that ① and
④ travel on the **same** connection (server → A), which is FIFO, and ① was queued earlier in time (③ can't happen
before ②, and ② happens after ①). The comment says it in the code:

```js
// backend/socket/groupHandlers.js:65-69 (2615e64)
    // ORDER MATTERS: the others hear "participant-joined" BEFORE the newcomer gets
    // its ack. The newcomer only sends offers after the ack, and Socket.IO keeps
    // per-connection order, so every existing user knows the newcomer's name
    // before its offer arrives.
    socket.to(ioRoom(roomId)).emit('group:participant-joined', result.you);
```

The client still handles the unexpected case: an offer from an unknown peer creates an entry with a placeholder name
(`entry ??= ensureEntry({ socketId: from }, 'answerer')`, `useMeshRoom.js:268`).

**Remember:** emit to the others first, ack second, and rely on per-connection FIFO.
</details>

---

## 3. Socket.IO

### Q15. `socket.on` vs `socket.emit`: what does each do, on the server and on the client?

<details><summary>Answer</summary>

**Simply:** `on` = "when this event arrives, run this function". `emit` = "send this event to the other end".

| Call | On the server (`socket` = one client's connection) | In the browser (`socket` = my connection) |
|---|---|---|
| `socket.on('x', fn)` | handle `x` sent by **this client** | handle `x` sent by the **server** |
| `socket.emit('x', data)` | send `x` to **this one client** | send `x` to the **server** |

```js
// server: handle a client's request          backend/socket/groupHandlers.js:81
  socket.on('group:signal', ({ to, type, payload } = {}, ack) => { … });
// client: send to the server                 frontend/src/hooks/useMeshRoom.js:438
        socket.emit('group:leave');
// client: listen for server events           frontend/src/hooks/useMeshRoom.js:422
    socket.on('group:signal', onSignal);
```

**Remember:** `on` listens and `emit` sends, always between *this* client and the server.
</details>

### Q16. `socket.to(room).emit` vs `io.to(room).emit` vs `io.emit`?

<details><summary>Answer</summary>

**Simply:**
- `socket.to(room).emit`: everyone in the room **except me** (the sender).
- `io.to(room).emit`: everyone in the room, **including** me if I'm in it.
- `io.emit`: **every connected client** on the server. Almost never what you want.

```
room "group:standup" = { A, B, C }, sender = C
socket.to("group:standup").emit(…)  → A, B
io.to("group:standup").emit(…)      → A, B, C
io.emit(…)                          → A, B, C + everyone in every other room + the lobby
```

**Technically:** step 11 uses `socket.to(...)` for joined/left (no point telling C that C joined) and
`io.to(target.socketId)` for unicast. Because the server is acting as a relay, the "from" socket isn't the target. `io.to`
works with a socket id because that's a room too (Q19). It uses `io` rather than `socket` simply to make it explicit
that the target is some *other* socket.

**Remember:** `socket.to` = the room minus me, `io.to` = the whole room, `io.emit` = the whole server.
</details>

### Q17. What does `socket.connect()` do, and why is it called in an effect?

<details><summary>Answer</summary>

**Simply:** the app's single Socket.IO client is created with `autoConnect: false`, so it doesn't connect until a page
needs signaling. The mesh page's effect connects it if it isn't connected yet.

```js
// frontend/src/services/socket.js:16-20 (2615e64)
export const socket = io({ autoConnect: false, … });
// frontend/src/hooks/useMeshRoom.js:423-426 (2615e64)
    if (!socket.connected) {
      setStatus('connecting');
      socket.connect();
    }
```

**Technically:** the socket is a **module-level singleton**, created once per page load. Even if StrictMode runs the
effect twice, or you navigate between pages, there's one connection. `connect()` is a no-op if it's already
connecting. The cleanup does **not** disconnect, so other pages (or the re-mounted effect) reuse it. `io()` with no URL connects to the page's own origin,
and Vite proxies `/socket.io` to the backend (`ws: true` for the WebSocket upgrade).

**Remember:** one module-level socket, connected on demand, never disconnected by a page's cleanup.
</details>

### Q18. What is `socket.join(room)` on the server? Can the browser join a room itself?

<details><summary>Answer</summary>

**Simply:** `socket.join('group:standup')` adds this connection to a named group on the **server**, so later
`socket.to('group:standup')` / `io.to('group:standup')` reach it. The browser can't join a room. Rooms are a
server-side concept, so the client asks with an event (`group:join`) and the server decides.

**Technically:** Socket.IO rooms live in the server's **adapter** (in memory by default). They are separate from the
app's own room data in `groupRoomService`. The code keeps both in sync: `groups.join` + `socket.join`, and
`groups.leave` + `socket.leave`. The data maps answer "who's in it, with what name". The Socket.IO room only answers
"who receives this broadcast".

**Remember:** Socket.IO rooms are server-only broadcast lists, separate from your own room bookkeeping.
</details>

### Q19. What is the "private socket-id room", and how does unicast use it?

<details><summary>Answer</summary>

**Simply:** when a socket connects, Socket.IO automatically puts it in a room whose name is its own id. So "send to
socket `sA`" is just "send to room `sA`", a room with exactly one member.

```js
// backend/socket/groupHandlers.js:95 (2615e64)
    io.to(target.socketId).emit('group:signal', { from: socket.id, type, payload });
```

**Technically:** that's why `io.to(<socketId>)` is the standard unicast. It also means socket ids and room names share
one namespace, which is the reason for the `group:` prefix (Q12) and the security note in Q51.

**Remember:** every socket is alone in a room named after its id, and that room is the unicast address.
</details>

### Q20. What happens to the socket id when the connection drops and reconnects?

<details><summary>Answer</summary>

**Simply:** you get a **new** socket id. To the server, the reconnected client is a brand-new socket: not in any room,
with no name. The old id disappears when the server notices it died: immediately after a clean close, or up to about
45 s later after a silent network drop (Q21). Then its `disconnect` handler runs and the others get `participant-left` for it.

**Technically:** the client reconnects automatically with exponential backoff, then fires `connect` again.
Step 11 reacts by throwing away every peer connection and re-joining as a **new joiner**:

```js
// frontend/src/hooks/useMeshRoom.js:377-386 (2615e64)
    const onConnect = () => {
      setStatus('connected');
      if (joinedRef.current) {
        // New socket id → to everyone else we are a brand-new participant …
        closeAll('signaling reconnected');
        doJoin(joinedRef.current.roomId, joinedRef.current.name);
      }
    };
```

`joinedRef` is what makes the re-join possible: it remembers `{ roomId, name }` across the reconnect. (The tab also has
a `clientId` that survives reconnects, `services/socket.js:14`, but the group code doesn't use it in step 11.)

**Later:** step 13 keys peers by `clientId` and **keeps** working P2P connections instead of rebuilding.

**Remember:** a reconnect means a new socket id, so you must re-join, and the old id is gone for everyone.
</details>

### Q21. How fast does the server notice that a client is gone?

<details><summary>Answer</summary>

**Simply:** it depends how the client disappears. If the tab closes or the page reloads, the WebSocket closes
properly and `disconnect` fires **immediately**. If the network just dies (Wi-Fi off, laptop lid closed), the server
only notices when its heartbeat gets no reply: up to about **45 seconds** later with the defaults.

**Technically:** Socket.IO pings every `pingInterval` (25 s) and waits `pingTimeout` (20 s) for the pong. Until then
the dead socket is still "in the room": the others see a participant whose connection is `disconnected`/`failed`,
and offers sent to it go nowhere. After the timeout: `disconnect` → `leaveCurrentGroup('disconnected')` →
`participant-left` → everyone removes it.

**Remember:** clean closes are instant, silent network deaths take up to about 45 s (ping interval + timeout).
</details>

---

## 4. Frontend

### Q22. Why are the peers kept in a `useRef(new Map())` and not in `useState`?

<details><summary>Answer</summary>

**Simply:** the code that touches the peers (socket events, `pc.onicecandidate`, `dc.onmessage`…) runs long after the
render that created it. With state, each of those callbacks would see the value **from when it was created**, a stale
copy. A ref is one mutable box that every callback reads **now**.

```js
// frontend/src/hooks/useMeshRoom.js:17-20, 64 (2615e64)
// It's a REF, not state: socket callbacks and pc event handlers fire long after
// the render that created them, and they must all see the CURRENT Map. React
// state would give each closure a stale copy. After every change we call
// publish(), which copies the Map into `peers` state for rendering.
  const peersRef = useRef(new Map());
```

**Technically:** an `RTCPeerConnection` is a mutable browser object that React can't observe anyway. Putting it in
state would add nothing but stale-closure bugs and extra renders. The pattern is: **mutable source of truth in a ref,
immutable snapshot in state for the UI** (Q23).

**Remember:** a ref for what callbacks need now, state for what the screen shows.
</details>

### Q23. What does `publish()` do, and when is it called?

<details><summary>Answer</summary>

**Simply:** it copies the Map into a plain array in React state, so the participant list and chat badge re-render.
It's called after every change that the UI should show.

```js
// frontend/src/hooks/useMeshRoom.js:70-82 (2615e64)
  const publish = useCallback(() => {
    setPeers(
      [...peersRef.current.values()].map((e) => ({
        id: e.id, name: e.name, joinedAt: e.joinedAt, role: e.role,
        ...e.state,                                    // connection, ice, signaling
        channel: e.dataChannel?.readyState ?? 'none',  // read NOW from the live object
        counts: { ...e.counts },                       // copy, so React sees a new object
      })),
    );
  }, []);
```

**Technically:** it reads live values (`readyState`) at copy time and copies nested objects, so React's shallow
comparisons see the change. It's cheap: at most 5 entries. It's called from state-change handlers, `onicecandidate`,
channel open/close, `ensureEntry` callers, and `removePeer`. The `useCallback(…, [])` keeps it stable, which matters
for the effect's dependencies (Q37).

**Remember:** `publish()` = snapshot the ref into state, called after every visible change.
</details>

### Q24. What's in a peer entry, and what does `ensureEntry` do?

<details><summary>Answer</summary>

**Simply:** an entry is everything I know about one other person: name, my connection to them, my data channel to
them, the connection states, a queue of early candidates, and counters. `ensureEntry` creates it if missing (with
**no connection yet**) or returns the existing one.

```js
// frontend/src/hooks/useMeshRoom.js:104-121 (2615e64)
  const ensureEntry = useCallback((p, role) => {
    let entry = peersRef.current.get(p.socketId);
    if (!entry) {
      entry = {
        id: p.socketId, name: p.name ?? short(p.socketId), joinedAt: p.joinedAt ?? Date.now(), role,
        pc: null, dataChannel: null,
        state: { connection: 'none', ice: 'none', signaling: 'none' },
        pending: [], counts: { sent: 0, received: 0, queued: 0 },
      };
      peersRef.current.set(p.socketId, entry);
    }
    return entry;
  }, []);
```

**Technically:** existing users call it on `participant-joined`, and the UI shows "waiting for offer" (`connection:
'none'`). The `pc` only appears when the offer arrives. It's also the fallback when an offer or candidate arrives from
an unknown id (placeholder name = short id).

**Remember:** entry first (who), connection later (how): `ensureEntry` never creates a pc.
</details>

### Q25. What does `createPc` set up, and what is the `alive()` check?

<details><summary>Answer</summary>

**Simply:** `createPc` makes a new `RTCPeerConnection` for one entry and attaches all its event handlers. Every handler
first asks `alive()`: "am I still the current connection for a peer that's still in the room?" If not, the event is
from a connection we've already thrown away, and it's ignored.

```js
// frontend/src/hooks/useMeshRoom.js:187-190, 209-212 (2615e64)
      const pc = new RTCPeerConnection(ICE_CONFIG);
      entry.pc = pc;
      // The handlers below close over THIS pc; if it's replaced or removed, they go quiet.
      const alive = () => peersRef.current.get(entry.id) === entry && entry.pc === pc;
…
      pc.onicecandidate = (e) => {
        if (!alive() || !e.candidate?.candidate) return; // null / "" = gathering finished
        entry.counts.sent++;
        sendSignal(entry.id, 'candidate', e.candidate.toJSON());
```

**Technically:** `alive()` checks **two** things. (1) The entry object is still the one in the Map, which is false
after `removePeer`. (2) The entry's pc is still *this* pc, which is false after `createPc` replaced it. Events and
`await` continuations can arrive after a pc is closed or replaced. Without the check, they'd send candidates for a dead
connection or overwrite the state of the new one. Handlers: `onsignalingstatechange`, `oniceconnectionstatechange`,
`onconnectionstatechange` (logs + a system message on `failed`), `onicecandidate` (trickle to **this** peer),
`ondatachannel` (answerer side).

**Remember:** `alive()` = "is this still the current pc of a current peer?" Check it in every callback and after every `await`.
</details>

### Q26. What does `callPeer` do, and why is the data channel created before `createOffer`?

<details><summary>Answer</summary>

**Simply:** `callPeer` is the new joiner's "call this person": make an entry, make a pc, create the `"chat"` channel,
create and set the offer, send it to that one person.

```js
// frontend/src/hooks/useMeshRoom.js:243-260 (2615e64)
  const callPeer = useCallback(async (p) => {
      const entry = ensureEntry(p, 'offerer');
      entry.role = 'offerer';
      const { pc, alive } = createPc(entry);
      // Before createOffer, so the offer contains m=application (SCTP).
      attachChannel(entry, pc.createDataChannel('chat'));
      try {
        await pc.setLocalDescription(await pc.createOffer());
        if (!alive()) return;
        sendSignal(entry.id, 'offer', pc.localDescription.toJSON());
        …
```

**Technically:** an offer only describes what exists when it's created. With no data channel (and no tracks), the SDP
would have **no m-section at all**: nothing to connect, so no candidates and no data channel. Creating the channel
first adds `m=application … webrtc-datachannel`. Adding it later would require renegotiation. `doJoin` calls `callPeer`
for every participant **without awaiting**, so all N−1 negotiations run in parallel (`useMeshRoom.js:344-345`).

**Remember:** create the data channel before the offer, or the offer has nothing to negotiate.
</details>

### Q27. Walk through `handleSignal` for an offer, an answer and a candidate.

<details><summary>Answer</summary>

**Simply:** look up the entry by `from`, then:
- **offer** → I'm the answerer: new pc, apply the offer, flush queued candidates, create and send the answer;
- **answer** → apply it if I'm waiting for one;
- **candidate** → add it now, or queue it if the pc isn't ready.

```js
// frontend/src/hooks/useMeshRoom.js:266-280 (2615e64)  — offer
          entry ??= ensureEntry({ socketId: from }, 'answerer');
          if (entry.role === 'offerer' && entry.pc?.signalingState === 'have-local-offer') { … GLARE, ignoring it; return; }
          entry.role = 'answerer';
          const { pc, alive } = createPc(entry);
          if (!(await applyRemoteDescription(entry, pc, alive, payload))) return;
          await pc.setLocalDescription(await pc.createAnswer());
          if (!alive()) return;
          sendSignal(entry.id, 'answer', pc.localDescription.toJSON());
// :282-290 — answer
          if (!pc || pc.signalingState !== 'have-local-offer') { … ignored; return; }
          await applyRemoteDescription(e, pc, () => …alive…, payload);
// :291-305 — candidate
          if (!pc || !pc.remoteDescription) { entry.pending.push(payload); … QUEUED }
          else await pc.addIceCandidate(payload);
```

**Technically:** the answer branch's `signalingState` guard drops duplicate or late answers (applying an answer in
`stable` throws). Everything is inside one `try/catch` that logs `err.name: err.message` per peer, so one peer's error
never affects the others.

**Remember:** offer → answer, answer → apply, candidate → add or queue, always looked up by `from`.
</details>

### Q28. Why does every peer have its *own* candidate queue (`entry.pending`)?

<details><summary>Answer</summary>

**Simply:** a candidate arriving early is "for the connection with B", not "for my connections in general". If all
early candidates went into one shared queue, B's could end up added to the connection with C.

**Technically:** `addIceCandidate` before `setRemoteDescription` throws (`InvalidStateError`), so early candidates
must wait. `applyRemoteDescription` drains **only that entry's** queue, right after the remote description is set:

```js
// frontend/src/hooks/useMeshRoom.js:229-238 (2615e64)
  const applyRemoteDescription = useCallback(async (entry, pc, alive, description) => {
      await pc.setRemoteDescription(description);
      if (!alive()) return false;
      const queued = entry.pending;
      entry.pending = [];
      for (const c of queued) await pc.addIceCandidate(c);
```

Seen in the test: the queue wasn't only used by answerers. C (the offerer) queued candidates too, because the
answerer's candidates arrived while `await setRemoteDescription(answer)` was still running.

**Remember:** early candidates belong to one connection, so one queue per peer, drained right after `setRemoteDescription`.
</details>

### Q29. Why is there one data channel per peer, and who creates it?

<details><summary>Answer</summary>

**Simply:** a data channel lives inside one `RTCPeerConnection`, so with N−1 connections you get N−1 channels. The
**offerer** (new joiner) creates `"chat"` with `createDataChannel`. The **answerer** receives it via `ondatachannel`.

```js
// frontend/src/hooks/useMeshRoom.js:217-222 (2615e64)
      // Answerer side: the offerer's "chat" channel arrives through the connection.
      pc.ondatachannel = (e) => {
        if (!alive()) return;
        attachChannel(entry, e.channel);
      };
```

**Technically:** `attachChannel` wires `onopen` / `onclose` / `onmessage` and stores the channel in `entry.dataChannel`
for both roles, so after that, the code doesn't care who created it. The author of a received message is "whoever
is at the other end of **this** channel" (`useMeshRoom.js:169-171`). Nobody forwards messages in a mesh, so that's
exact. Alternative: `negotiated: true, id: 0` on **both** sides creates the channel symmetrically with no
`ondatachannel`. Step 11 uses the default (in-band) way.

**Remember:** a channel per connection, created by the offerer and received by the answerer via `ondatachannel`.
</details>

### Q30. How does `sendChat` reach everyone, and what are the consequences?

<details><summary>Answer</summary>

**Simply:** it sends the same JSON once on **every open** data channel: N−1 sends. Peers whose channel isn't open
simply don't get it, and the UI says so ("sent over 2/3 channels").

```js
// frontend/src/hooks/useMeshRoom.js:459-477 (2615e64)
  const sendChat = useCallback((text) => {
      const t = text.trim();
      if (!t) return 0;
      const data = JSON.stringify({ type: 'chat', text: t, ts: Date.now() });
      const all = [...peersRef.current.values()];
      let sent = 0;
      for (const e of all) {
        if (e.dataChannel?.readyState === 'open') { e.dataChannel.send(data); sent++; }
      }
      if (sent) addMessage('me', t, { sentTo: sent, of: all.length });
      return sent;
```

**Technically, three consequences:**
1. **No relay.** If my link to B failed while A↔B works, B never sees my messages.
2. **No global order.** Each channel is ordered by itself, but two people typing at once may see the messages in
   different orders.
3. **Upload grows with N−1.** Irrelevant for text, decisive for video (step 12).

`GroupChat` only clears the input if at least one channel took the message (`if (onSend(text) > 0) setText('')`, `GroupChat.jsx:20`).

**Remember:** group chat in a mesh = N−1 separate sends: no relay, no global order.
</details>

---

## 5. Signaling & glare

### Q31. What is the "newcomer offers" rule?

<details><summary>Answer</summary>

**Simply:** when you join, you call everyone already in the room. People already in the room never call. They wait for
the newcomer's offer and answer it.

**Technically:** the ack of `group:join` lists the existing participants, and `doJoin` calls `callPeer` for each.
`participant-joined` only creates an entry:

```js
// frontend/src/hooks/useMeshRoom.js:344-345 (2615e64)
      // One offer per existing participant, all in parallel: separate connections.
      for (const p of res.participants) callPeer(p);
// :398-404 — the existing side only records the newcomer
    const onParticipantJoined = (p) => {
      if (!joinedRef.current || p.socketId === socket.id) return;
      ensureEntry(p, 'answerer');
```

```
C joins a room with A and B:

 A              B              Server               C
 │◀─ participant-joined(C) ────│◀── group:join ─────│
 │              │◀─ p-joined(C)│── ack [A, B] ──────▶│  C = newcomer
 │              │              │◀─ signal{to:A, offer}
 │◀─ {from:C, offer} ──────────│◀─ signal{to:B, offer}
 │              │◀─ {from:C, offer}                 │
 │── signal{to:C, answer} ────▶│── {from:A, answer} ─▶│
 │              │── {to:C, answer} ─▶│── {from:B, answer} ─▶│
 │◀══════ C↔A direct (ICE + DTLS + SCTP) ═══════════▶│
 │              │◀═══════ C↔B direct ══════════════▶│
 │◀═══ A↔B (since B joined): untouched ═══▶│          │
```

**Remember:** newcomer → offers to all, existing users → only answer.
</details>

### Q32. What is glare, and why does this rule prevent it?

<details><summary>Answer</summary>

**Simply:** glare is two people calling each other at the same moment. Each has sent an offer and is waiting for an
answer, then receives an offer instead. Two negotiations are now running for one connection, and whatever each side
does with the incoming offer, the other side's answer no longer fits (see Q35).

```
GLARE (what the rule prevents):
  A: createOffer → have-local-offer ──offer──▶ ╳ ◀──offer── have-local-offer ← createOffer :B
     A receives an offer while in have-local-offer: conflict. Same for B.
```

**Why the rule prevents it:** for every **pair**, exactly one of the two joined later, and only that one offers. The
server handles `group:join` events **one at a time** (one Node process, one event loop), so "who joined later" is
never ambiguous. Even if C and D click Join in the same millisecond, one of them is processed first. The second sees
the first in its participant list, and the first only gets `participant-joined`. So two offers for the same pair
can't exist, and they can't cross.

The code still detects it, just in case, and acts as the "impolite" side:

```js
// frontend/src/hooks/useMeshRoom.js:269-273 (2615e64)
          if (entry.role === 'offerer' && entry.pc?.signalingState === 'have-local-offer') {
            // Can't happen with the join rule. If it does, that's GLARE: be the "impolite" peer.
            log(`[${entry.name}] ← offer while my own offer is pending: GLARE, ignoring it`, 'error');
            return;
          }
```

**Remember:** one offerer per pair, decided by a join order the single server makes unambiguous.
</details>

### Q33. When does the newcomer rule stop working?

<details><summary>Answer</summary>

**Simply:** whenever someone who **isn't** the newcomer needs to send an offer, or when "who joined later" stops being clear.

1. **Renegotiation:** adding video or screen share later fires `negotiationneeded` on whoever added the track, maybe the
   *older* user. Now either side can offer, and offers can cross.
2. **ICE restart:** after a network change, who restarts? Both sides may try at once.
3. **Reconnects:** a reconnected user gets a new socket id and looks like a newcomer, while the others may still hold
   old state for it (Q20).
4. **Several signaling servers:** two Node processes behind a load balancer each process joins in their own order. Two
   users could both be told "you are the newcomer" → both offer.
5. **Asymmetric needs:** the answerer needs an m-line the offer didn't include (e.g. it wants to send a track the offerer didn't offer to receive).

**Remember:** the rule only covers the *first* negotiation, and only with one server.
</details>

### Q34. What will perfect negotiation change? (Preview of step 13)

<details><summary>Answer</summary>

**Simply:** instead of "only the newcomer may offer", **anyone may offer any time**, and collisions are resolved by a
fixed politeness rule. One side is **polite** (on a collision it backs off: it rolls back its own offer and accepts
theirs). The other is **impolite** (it ignores the incoming offer and keeps its own).

**Technically (`Webrtc.md` §19):**
- all offers go through `pc.onnegotiationneeded` → `setLocalDescription()`;
- `collision = offer arrives && (makingOffer || signalingState !== 'stable')`;
- impolite + collision → ignore the offer (and errors from its candidates);
- polite + collision → `setRemoteDescription(offer)` rolls back its own offer implicitly, then it answers;
- politeness must be decided the **same way on both sides** without talking, e.g. by comparing two stable ids.

**Later:** step 13 compares `clientId`s (stable per tab) rather than socket ids (which change on reconnect), and still
uses the newcomer rule to *start* each connection.

**Remember:** perfect negotiation = anyone may offer, and the polite side rolls back on a collision.
</details>

### Q35. Why can't "both sides just offer and see what happens"?

<details><summary>Answer</summary>

**Simply:** an `RTCPeerConnection` can only be in one negotiation at a time. If both offer, each receives an offer
while waiting for an answer, and applying it fails or leaves both sides stuck.

**Technically:** modern browsers handle `setRemoteDescription(offer)` in `have-local-offer` with an **implicit
rollback**: they throw away *their own* pending offer and accept the incoming one. (Older browsers threw
`InvalidStateError` instead.) Rollback alone doesn't save you when **both** sides do it at the same time:
- each discards its own offer and answers the other's;
- both answers arrive at a pc that's already back in `stable`, so they're useless, and the changes each side wanted are lost;
- if both then re-offer, they can collide again, and again: a loop.

So exactly one side must yield (roll back) and the other must insist (ignore the incoming offer). The newcomer rule
(step 11) avoids the collision entirely. Politeness (step 13) resolves it when it happens.

**Remember:** one negotiation at a time per pc. Rollback exists, but only ONE side may use it.
</details>

---

## 6. React

### Q36. What does StrictMode do to effects in dev, and how does the hook survive it?

<details><summary>Answer</summary>

**Simply:** in development, StrictMode (enabled in `main.jsx:13`) mounts each component, immediately unmounts it,
and mounts it again, so every effect runs **setup → cleanup → setup**. That flushes out effects that don't clean up.

**Technically:** the socket effect adds listeners in setup and removes **the same function objects** in cleanup, so
after the double run exactly one copy of each listener remains:

```js
// frontend/src/hooks/useMeshRoom.js:420-422 / 433-435 (2615e64)
    socket.on('group:participant-joined', onParticipantJoined);   // setup
    socket.on('group:participant-left', onParticipantLeft);
    socket.on('group:signal', onSignal);
…
      socket.off('group:participant-joined', onParticipantJoined); // cleanup: same references
      socket.off('group:participant-left', onParticipantLeft);
      socket.off('group:signal', onSignal);
```

The cleanup's other work is harmless on the fake unmount: `joinedRef.current` is still `null` (nobody has joined yet),
so no `group:leave` is sent, and `closeAll` iterates an empty Map.

**Remember:** every `on` in setup needs an `off` with the same function in cleanup. That's what makes the double mount harmless.
</details>

### Q37. Why must the effect's dependencies be stable, and how is that achieved?

<details><summary>Answer</summary>

**Simply:** if any dependency changed, React would run the cleanup and the setup again, and this cleanup **leaves the
room and closes every connection** (`useMeshRoom.js:436-441`). An unstable dependency would mean hanging up on everyone
for no reason.

**Technically:** every dependency (`log`, `doJoin`, `closeAll`, `ensureEntry`, `removePeer`, `handleSignal`,
`addMessage`, `publish`) is a `useCallback` whose own dependencies are, in turn, stable (`log` comes from a context
and is created with `useCallback(…, [])`). So the effect runs once per mount. **Later:** step 15 hit exactly this bug: a
callback depended on a `paused` state, muting changed it, the effect re-ran, and its cleanup left the room. The fix was
to read the value from a ref.

**Remember:** an effect whose cleanup hangs up must only depend on stable callbacks.
</details>

### Q38. Why are peer connections never created inside the effect?

<details><summary>Answer</summary>

**Simply:** effects run twice in dev (Q36), re-run when dependencies change, and run on mount, before the user has done
anything. Creating connections there would make **two** connections per peer in dev, or connections nobody asked for.
Connections are created only in response to **events**: the join ack (`callPeer`), an incoming offer
(`handleSignal`).

```js
// frontend/src/hooks/useMeshRoom.js:373-375 (2615e64)
  // Registered in an effect with a cleanup that removes the SAME functions, so
  // StrictMode's mount → unmount → mount never leaves duplicate listeners.
  // Peer connections are only created from event handlers, never in the effect.
```

**Technically:** an event happens once, whatever React does with rendering. And `createPc` also closes any previous pc
of the same entry, as a second line of defence against duplicates.

**Remember:** effects subscribe. Event handlers create connections.
</details>

### Q39. Why listen to `pagehide`, and what does it do?

<details><summary>Answer</summary>

**Simply:** when the tab closes or reloads, React doesn't get to run its cleanups. `pagehide` is the last reliable
moment. Closing the peer connections there makes the other side see the connection end right away.

```js
// frontend/src/hooks/useMeshRoom.js:447-453 (2615e64)
  useEffect(() => {
    const onPageHide = () => {
      for (const e of peersRef.current.values()) e.pc?.close();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);
```

**Technically:** `pagehide` fires on close, reload, navigation, and when a page enters the back/forward cache. It's
more reliable than `unload`/`beforeunload`, especially on mobile. Two signals reach the others: the closed pc (DTLS/SCTP
shutdown on their connection), and, independently, the server sees the socket close and sends `participant-left`.
**Later:** step 13 also sends `{type:'bye'}` over every data channel first, which is even faster.

**Remember:** `pagehide` = last chance to close connections cleanly. Don't count on React cleanups at tab close.
</details>

---

## 7. Failure scenarios: "what happens if…"

### Q40. What happens if someone leaves in the middle of a negotiation?

<details><summary>Answer</summary>

**Simply:** nothing breaks for the others. Messages to the person who left are refused by the server, their entry is
removed when `participant-left` arrives, and any half-finished work for that connection stops quietly.

```
 C (newcomer)                Server                     B leaves mid-negotiation
 │── signal{to:B, offer} ───▶│──▶ B                        │
 │                            │◀────────── disconnect ──────│
 │                            │ groups.leave(B) → participant-left(B) to A, C
 │── signal{to:B, candidate}▶│ getParticipant(room, B) = null
 │◀─ ack {ok:false, error:'no-such-participant'}          (logged as a warning)
 │ onParticipantLeft → removePeer(B): delete from Map, dc.close(), pc.close()
 │ an in-flight `await` for B resumes → alive() === false → stops (no answer sent)
```

**Technically:** `removePeer` deletes the entry **before** closing (`useMeshRoom.js:130`), so every late callback sees
`alive() === false`. An `await pc.setRemoteDescription(...)` already running on a now-closed pc may reject with
`InvalidStateError`, which is caught and logged once for that peer. A and C's connection is a different pc, so it's untouched.

**Remember:** server refuses messages to a gone peer, the client removes it first, and `alive()` silences the leftovers.
</details>

### Q41. What happens if the backend restarts during a call?

<details><summary>Answer</summary>

**Simply:** the chat keeps working for a moment (it's peer-to-peer), but when the sockets reconnect, step 11 **tears
down every connection and rebuilds the mesh** from scratch, using the newcomer rule in the order people re-join.

```
 t0  server dies       → every socket: disconnect (status "disconnected"); data channels still work
 t1  server is back     → Socket.IO reconnects each client with a NEW socket id
 t2  each client:       onConnect → closeAll('signaling reconnected') → doJoin(room, name)
 t3  first re-joiner:   empty room (server forgot everything) → waits
     second re-joiner:  participants [first] → offers to it
     third re-joiner:   participants [first, second] → offers to both
```

**Technically:** the server's memory is empty after a restart, so nobody gets `participant-left` for the old ids. But
every client closes all its own entries on reconnect, so no stale entries survive. The rebuild is glare-free because
the restarted server again serializes the joins.

**The cost:** working P2P connections are destroyed for a problem that only affected signaling. **Later:** step 13
keys peers by `clientId`, keeps live connections across the restart, and only resyncs (0 pcs rebuilt in that test).

**Remember:** step 11 recovers from a backend restart by rebuilding everything, correct but wasteful.
</details>

### Q42. What happens if a candidate arrives before the offer it belongs to?

<details><summary>Answer</summary>

**Simply:** it's queued for that peer and added as soon as the offer has been applied.

**Technically:** with one server, the order **offer → candidates** is normally kept, because they travel on the same
connections in the same order. But "arrived" isn't the same as "applied": the receiver's `handleSignal` for the offer
is `async`, so a candidate can arrive while `await setRemoteDescription(offer)` is still running. Two cases, both handled:

```js
// frontend/src/hooks/useMeshRoom.js:292-300 (2615e64)
          entry ??= ensureEntry({ socketId: from }, 'answerer');   // no entry at all? create one
          …
          if (!pc || !pc.remoteDescription) {                      // no pc yet, or SRD not finished
            entry.pending.push(payload);
            entry.counts.queued++;
```

When the offer is applied, `applyRemoteDescription` drains `entry.pending` (Q28). `createPc` doesn't reset `pending`,
so candidates queued before the pc existed survive into it. The participant list shows the count: "(2 queued)".

**Remember:** early candidates wait in that peer's queue until `setRemoteDescription` is done.
</details>

### Q43. What happens if the room is full?

<details><summary>Answer</summary>

**Simply:** the 7th person gets a clear error and stays in the lobby. Nobody in the room is disturbed.

```js
// backend/socket/groupHandlers.js:58-62 (2615e64)
    const result = groups.join(roomId, { socketId: socket.id, name: socket.data.groupName });
    if (!result.ok) {
      logger.warn(`group "${roomId}": ${who()} rejected, room full (${groups.MAX_USERS_PER_GROUP})`);
      return reply(ack, { ok: false, error: 'room-full' });
    }
// frontend/src/hooks/useMeshRoom.js:327-333
      if (!res.ok) {
        const msg = res.error === 'room-full' ? `Room "${roomId}" is full (max 6 people in a mesh).` : res.error;
        joinedRef.current = null; setRoom(null); setError(msg); …
```

**Technically:** the rejected socket never reaches `socket.join(...)`, so it receives no room broadcasts, and it isn't
in `rooms`/`socketToRoom`, so it can't send `group:signal` (`not-in-room`). Tested in step 11: 6 joins ok, the 7th
`room-full`. Re-joining while already in the room doesn't count twice (`room.has(socketId)` short-circuit).

**Remember:** full → error in the ack, the user stays out completely, and the room isn't touched.
</details>

### Q44. What happens if one connection fails while the others work?

<details><summary>Answer</summary>

**Simply:** only that pair is affected. Its row turns red ("failed"), a system message appears in the chat, your
messages show "sent over 2/3 channels", and everything else keeps working. Step 11 doesn't try to repair it.

```js
// frontend/src/hooks/useMeshRoom.js:200-206 (2615e64)
      pc.onconnectionstatechange = () => {
        if (!alive()) return;
        const s = pc.connectionState;
        …
        if (s === 'failed') addMessage('system', `Connection to ${entry.name} failed (the others are not affected)`);
        update();
      };
```

**Technically:** each pc has its own ICE agent and DTLS session, so a failure (e.g. a symmetric NAT between a phone on
mobile data and the laptop) is local to that pair. In a mesh nobody relays, so the two people in that pair can't chat,
even if they both still talk to everyone else. **Later:** step 13 adds per-peer recovery (`disconnected` → wait 5 s;
`failed` → `restartIce()` for that pc only). TURN would make such pairs connect at all.

**Remember:** failures are per pair. In step 11 a failed pair stays failed, and nobody relays for it.
</details>

### Q45. What happens if *my* socket disconnects but my peer connections are still up?

<details><summary>Answer</summary>

**Simply:** for a little while, nothing visible: chat keeps flowing peer-to-peer, and the badge says "signaling
disconnected (open peer connections keep working)". But step 11 doesn't keep it that way.
- If the **server** is still running, it will (immediately, or after the ping timeout) send `participant-left` for my
  old socket id → **the others close their connections to me**.
- When my socket **reconnects**, `onConnect` calls `closeAll` and re-joins → **I close mine too** and rebuild.

```js
// frontend/src/hooks/useMeshRoom.js:388-391 (2615e64)
    const onDisconnect = (reason) => {
      setStatus('disconnected');
      log(`Socket disconnected: ${reason} (open peer connections keep working)`, 'warn');
    };
```

**Technically:** this shows that the media/data plane (P2P) and the signaling plane (Socket.IO) are independent, but
step 11 deliberately ties the call's lifetime to signaling membership, for simplicity. **Later:** step 13 waits
15 s for a "disconnected" peer whose P2P link still works, and keeps the connection when it re-joins.

**Remember:** P2P survives a signaling outage, but step 11's membership rules then tear it down anyway.
</details>

### Q46. What happens if two people join at exactly the same moment?

<details><summary>Answer</summary>

**Simply:** still no glare. The server handles one `group:join` completely before the next, so one of them is "first".

```
A, B already in the room. C and D click Join at the same instant.
Server event loop:   handle join(C) → participants [A, B] → C offers to A, B
                     handle join(D) → participants [A, B, C] → D offers to A, B, C
C receives participant-joined(D) → C only answers D.   Pair C–D: exactly one offerer (D).
```

**Technically:** each `group:join` handler runs synchronously from start to finish, so there's no `await` in the
middle where another join could interleave. Node's single-threaded event loop guarantees that within **one process**.
That's exactly the guarantee that disappears with several server processes (Q33, Q48).

**Remember:** one event loop = joins are serialized = "who joined later" is always well defined.
</details>

---

## 8. Interview-style questions

### Q47. "Why not broadcast all signaling and let each client ignore what isn't addressed to it?"

<details><summary>Answer</summary>

**Simply:** because then everyone would receive everyone's offers and candidates, and those contain private network
details. It also wastes bandwidth and puts security in the hands of every client.

**Strong answer:**
- **Privacy:** SDP and candidates contain local/public IP addresses and ICE credentials. Broadcasting leaks them to people who aren't part of that pair.
- **Trust:** a client "ignoring" messages is not access control. A modified client would just read them. Routing decisions belong on the server, which also stamps `from` itself (Q9).
- **Cost:** N−1 times the server egress and client processing per signaling message, which adds up during N−1 parallel negotiations.
- **Correctness:** server-side validation can return `no-such-participant` to the sender, giving useful feedback that broadcast can't.

**Remember:** route on the server, stamp `from` on the server, and never broadcast SDP.
</details>

### Q48. "How would you run this signaling on several Node processes?"

<details><summary>Answer</summary>

**Simply:** the room data (`rooms`, `socketToRoom`) and Socket.IO's rooms are in one process's memory, so a second
process wouldn't know about the first one's users. Both pieces need to be shared, and the join order must stay unambiguous.

**Strong answer:**
1. **Socket.IO Redis adapter** (`@socket.io/redis-adapter`): `io.to(room).emit` reaches sockets connected to *any* process.
2. **Room state in Redis** instead of `Map`s. The service module was written without Socket.IO precisely so it can be swapped (`roomService.js:3-4`).
3. **Atomic joins:** check capacity and add the member in **one** atomic step (Lua script or `MULTI`), returning the
   current member list, so the order is defined by Redis, not by whichever process was faster.
4. **Sticky sessions** at the load balancer if HTTP long-polling is used (each polling request must reach the same process).
5. Even then, prefer **perfect negotiation** so that correctness doesn't depend on a perfectly ordered join stream.

**Remember:** a shared adapter and shared state, atomic joins, sticky sessions, and don't rely on join order alone.
</details>

### Q49. "Is the newcomer rule really correct? Prove it."

<details><summary>Answer</summary>

**Simply:** take any two people X and Y in the room. One of them, say Y, was added to the room after X. When Y joined,
the server's list already contained X, so Y offered to X. When Y joined, X only received `participant-joined(Y)`, and
X never offers to anyone in step 11. So the pair X–Y has exactly one offer. Since that holds for every pair, no pair
can ever have two crossing offers.

**Strong answer, including the assumptions it relies on:**
- **Total order of joins:** one process, synchronous `group:join` handler (Q46).
- **One negotiation per pair:** no renegotiation, no ICE restart, no second offer (Q33).
- **Membership changes are seen in order:** `participant-joined` before the newcomer's offer (Q14, per-connection FIFO).
- **Identities are stable during the negotiation:** a reconnect creates a new id. Step 11 handles this by rebuilding from scratch (Q41).

Break any assumption and the proof fails, which is why step 13 adds perfect negotiation.

**Remember:** the proof is per pair, and it only holds under a single, totally ordered join stream with one negotiation per pair.
</details>

### Q50. "Walk me through what the server stores per user and how you avoid leaks."

<details><summary>Answer</summary>

**Simply:** per user: one entry in their room's Map (`{ socketId, name, joinedAt }`), one entry in `socketToRoom`, the
display name in `socket.data.groupName`, and Socket.IO's own room membership. All of it is removed by one function
that every exit path calls.

**Strong answer:**
- `groups.leave()` removes the user from both maps and deletes the room when its last member leaves (`groupRoomService.js:37-46`).
- `leaveCurrentGroup` is called from `group:leave`, from switching rooms, **and** from `disconnect` (Q8). There's no exit path that skips it.
- `socket.data` and Socket.IO's room membership disappear with the socket object itself on disconnect.
- Client side: `removePeer` and `closeAll` close every `RTCPeerConnection` and channel. The effect cleanup (route change) and `pagehide` (tab close) both call them.
- The one leak window is a **dead-but-not-yet-detected** socket (up to about 45 s, Q21). It's bounded and cleaned up by the heartbeat.

**Remember:** every exit path goes through the same cleanup, and empty rooms are deleted.
</details>

### Q51. "What security problems do you see in this design?"

<details><summary>Answer</summary>

**Simply:** anyone can join any room under any name, nothing limits how fast a client sends, and (in the older 1:1
code) user-chosen room names can collide with other people's private socket rooms.

**Strong answer:**
1. **No authentication or authorization.** Names are self-declared, so anyone who guesses a room name can join it. Fix: a JWT verified in Socket.IO's handshake middleware (`io.use`), and room membership checked against it.
2. **Socket-id room collision (in the 1:1 handlers of step 8).** `roomHandlers.js` does `socket.join(roomId)` with the
   **user-chosen** name. Every socket is also in a room named after its own id, and `peer-joined` reveals socket ids to
   room peers. Someone who learned your socket id could create a 1:1 room *with that name*: they'd be added to the
   Socket.IO room that `io.to(yourSocketId)` targets, and receive your signaling. The group code is immune thanks to the
   `group:` prefix (Q12). Fix: prefix the 1:1 room names too (e.g. `room:`).
3. **No rate limiting.** A client can flood `group:signal` or `group:join`. Add per-socket token buckets.
4. **Message size:** bounded by `maxHttpBufferSize: 100_000` (100 KB per message). Good. The payload isn't validated, but it's never parsed either.
5. **Room enumeration / guessing:** room names are short, human-chosen strings. Use random room ids or invite tokens.
6. **XSS via names/chat:** React escapes text by default, and names are trimmed to 30 characters (`cleanName`). Fine, as long as nobody adds `dangerouslySetInnerHTML`.
7. **CORS is not access control:** WebSocket upgrades aren't subject to CORS (`socket/index.js:24-25`). Check the `Origin` header if needed.

**Remember:** add authentication, prefix every user-chosen room name, rate-limit, and treat CORS as non-security.
</details>

### Q52. "Your peer state lives in a ref plus a `publish()` snapshot. What are the trade-offs? Alternatives?"

<details><summary>Answer</summary>

**Simply:** the ref gives every callback the current truth, and the snapshot gives React something it can render. The
cost is discipline: you must remember to call `publish()` after every visible change, or the UI shows old data.

**Strong answer:**
- **Pros:** no stale closures; `RTCPeerConnection` objects (not serializable, not observable) never enter React state; updates are cheap (≤ 5 entries).
- **Cons:** manual `publish()` calls (easy to forget, and the bug is silent); the whole array is replaced on every change (fine at this size); two sources of truth to keep in sync.
- **Alternatives:**
  - `useSyncExternalStore` with a small store class (subscribe/getSnapshot), the React-blessed way to expose external mutable state;
  - an external store (Zustand) holding plain data, with the pcs in a separate non-reactive registry;
  - `useReducer` for the UI data, dispatched from the callbacks (dispatch is stable), with pcs still in a ref.
- In all cases: never put the `RTCPeerConnection` itself in React state.

**Remember:** keep mutable objects outside React and publish immutable snapshots. `useSyncExternalStore` is the formal version.
</details>

### Q53. "Review this code: find a real bug or weakness in the negotiation path."

<details><summary>Answer</summary>

**Simply:** if a peer's connection is ever *replaced* (a second offer from the same peer), its old queued candidates
stay in the queue. And if adding one of them fails, the error escapes the drain loop and **the answer is never sent**.

**Strong answer:**

```js
// frontend/src/hooks/useMeshRoom.js:180-186 (2615e64) — createPc replacing a pc keeps entry.pending
      if (entry.pc) { … entry.pc.close(); entry.dataChannel = null; }   // pending NOT cleared
// :233-235 — one failing candidate aborts the loop…
      for (const c of queued) await pc.addIceCandidate(c);
// :277-280 — …so the code after applyRemoteDescription (createAnswer + send) never runs
```

- Candidates from the **old** session have the old ICE ufrag, so `addIceCandidate` on the new pc can reject. The rejection propagates through `applyRemoteDescription` to `handleSignal`'s catch: logged, but no answer is sent, and that pair hangs.
- In step 11's flow, a second offer from the same peer id is practically unreachable (the newcomer rule plus reconnects
  creating *new* ids), so this is latent, not observed.
- **Fix** (what step 13 did): reset `pending` whenever a new pc is created, and make each queued add non-fatal:
  `await pc.addIceCandidate(c).catch(() => {})`.
- Bonus weaknesses: no `restartIce` on failure (Q44); a signaling blip tears down working P2P (Q45); `attachChannel`'s
  `alive()` only checks the entry, not the pc (harmless here because `createPc` nulls the old channel).

**Remember:** reset per-connection state when you replace a connection, and never let one bad candidate abort an answer.
</details>

### Q54. "Group chat consistency: how would you guarantee everybody sees the same messages in the same order?"

<details><summary>Answer</summary>

**Simply:** today each message is sent separately to each person with no relay and no shared clock, so a broken pair
misses messages and order can differ. To fix it you need ids, ordering metadata, and a way around broken pairs.

**Strong answer:**
- **Message ids** (`senderId + counter`) for de-duplication.
- **Ordering:** Lamport timestamps or vector clocks for a consistent causal order; sort by `(lamport, senderId)` for a total order. `Date.now()` (`ts` today) isn't reliable across devices.
- **Delivery around broken pairs:** gossip/relay (peers forward messages they haven't seen to their own peers, de-duplicated by id), or simply send chat **through the server** (it's tiny, and the server already exists). Most real products do the latter, with persistence.
- **History for late joiners:** in step 11 a newcomer sees nothing from before it joined. Persistence or a "sync" request to one peer would fix that.

**Remember:** P2P fan-out gives neither delivery nor ordering guarantees. Add ids + logical clocks, or let the server carry chat.
</details>

### Q55. "How would you test this system?"

<details><summary>Answer</summary>

**Simply:** test the pure room logic with unit tests, the server events with real Socket.IO clients in Node, and the
whole thing with several real browsers.

**Strong answer (most of this was actually done for step 11):**
1. **Unit:** `groupRoomService` is pure. Test join/leave/full/idempotent re-join/empty-room deletion/listing order/`stats()`.
2. **Socket integration:** spin up the server and connect 7 `socket.io-client`s from Node. Assert: 6 × `ok`, 7th `room-full`;
   `group:signal` to a socket in another room / to self → `no-such-participant`; unicast 1→3 is received **only** by 3;
   a 1:1 room with the same name receives no `group:*` events.
3. **E2E:** Playwright with several browser contexts (one with a phone user agent): join A, B, C, D in order; assert
   offers per user = 0/1/2/3 and glare = 0; chat from A reaches B, C, D with author "A" and "3/3"; B leaves → the others
   keep 2 connected peers; a tab close → removal; B re-joins → 2 offers.
4. **Fault injection:** kill the backend mid-call; drop network for one context; force simultaneous joins; delay `setRemoteDescription` to force the candidate queue.

**Remember:** pure logic → unit tests, protocol → Node socket clients, behaviour → multi-browser E2E plus fault injection.
</details>

### Q56. "When would you stop using a mesh, and what would you change first?"

<details><summary>Answer</summary>

**Simply:** as soon as there's video for more than about 4 people, or phones in the call. Every person would upload and
encode their camera N−1 times. The fix is a server that receives one stream per person and forwards it: an **SFU**.

**Strong answer:**
- Mesh is right for **2 people** (no server cost, lowest latency, true end-to-end encryption) and fine for small groups with data or audio only.
- Limits: per-person upload and encode CPU grow with N−1, and room connections with N×(N−1)/2. **Later:** step 13
  measured frame rate collapsing at N=4 on one laptop. Step 15: the SFU kept upload flat at ~1.35 Mbps and 20 fps up to N=6.
- What changes: the browser's `RTCPeerConnection` connects to the **server** (2 per user: send + recv) instead of to
  each peer. Signaling becomes request/response with the SFU (mediasoup), simulcast lets the server send each receiver
  the right quality, and there's no glare problem (the server drives negotiation).
- What carries over: rooms, unicast signaling with acks, per-peer bookkeeping, stats, and the React patterns.

**Remember:** mesh for 2 (or a few, without video). SFU for group video, because upload and encoding don't scale with N−1.
</details>

---

## 9. Rapid-fire

<details><summary>15 one-line questions (open for the answers)</summary>

| # | Question | Answer |
|---|---|---|
| 1 | Connections in a 5-person mesh? | 10 (5×4/2); each browser holds 4. |
| 2 | Which side creates the data channel? | The offerer (new joiner), before `createOffer`. |
| 3 | How does the answerer get it? | `pc.ondatachannel`. |
| 4 | What does `to` contain in step 11? | The target's **socket id**. |
| 5 | Who sets `from`? | The server, from `socket.id` (never the client). |
| 6 | Broadcast or unicast for `group:signal`? | Unicast: `io.to(target.socketId)`. |
| 7 | Why the `group:` prefix? | Separate from 1:1 rooms and from private socket-id rooms. |
| 8 | Error when the target already left? | `no-such-participant` in the ack. |
| 9 | Error for the 7th person? | `room-full`. |
| 10 | Where are early candidates kept? | `entry.pending`, one queue per peer. |
| 11 | What makes stale callbacks harmless? | The `alive()` check (entry still in the Map and pc still current). |
| 12 | Why a ref for the peers Map? | Callbacks must see the current Map, not a stale render copy. |
| 13 | What does a reconnect change? | The socket id, so step 11 closes all and re-joins as a newcomer. |
| 14 | Why does the newcomer rule prevent glare? | Exactly one offerer per pair, and the single server orders the joins. |
| 15 | When does it stop working? | Renegotiation, ICE restarts, reconnects, multiple signaling servers. |

</details>
