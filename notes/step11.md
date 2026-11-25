# Step 11: group room as a full mesh (chat only)

Theory: `Webrtc.md` §5 (signaling), §19 (renegotiation & perfect negotiation), §20.1 (mesh).

Page: **`/group`** (nav: *Group Mesh*). The 1:1 `/room` page is unchanged.

## What I built

| File | Role |
| ---- | ---- |
| `backend/services/groupRoomService.js` | Group rooms in memory: `roomId → Map(socketId → { socketId, name, joinedAt })`, max **6** |
| `backend/socket/groupHandlers.js` | `group:join` (ack lists existing participants), `group:leave`, `group:signal {to}` (unicast), `group:participant-joined/left` |
| `frontend/src/hooks/useMeshRoom.js` | `Map(peerId → { pc, dataChannel, state, pending, … })` in a ref; join rule; trickle ICE + per-peer queue; chat fan-out; per-peer cleanup |
| `frontend/src/pages/GroupMesh.jsx` | Lobby (room + name) → participants, mesh diagram, group chat |
| `frontend/src/components/ParticipantList.jsx` | Every peer with *my* `connectionState`, ICE/signaling/channel state, candidate counts, who offered |
| `frontend/src/components/MeshDiagram.jsx` | The room as a graph + live `N×(N−1)/2` numbers |
| `frontend/src/components/GroupChat.jsx` | Chat with author names and "sent over 2/3 channels" |

## Signaling: why the 1:1 relay isn't enough anymore

Step 8's server relays a `signal` to "the other user in the room". With 2 people that's unambiguous.

In a mesh **every pair has its own `RTCPeerConnection`**, and each has its own SDP (ICE ufrag/pwd, DTLS
fingerprint, m-lines) and its own candidates. When C joins A and B, C runs **two negotiations at once**:
C↔A and C↔B. The offer C made for A must reach **only** A:

- Broadcasting it to the room would make B apply an offer that belongs to a different connection. B would answer
  it, C would apply B's answer to the C↔A connection, and nothing would match.
- A candidate is only valid for the connection that gathered it. B's candidates added to the A↔C connection are useless.

So every message carries a **destination** and an **origin**:

```
client → server   group:signal { to: "<socketId of A>", type: "offer", payload }
server → A        group:signal { from: "<socketId of C>", type: "offer", payload }     io.to(to).emit(...)
```

`to` tells the server where to send it. `from` tells the receiver **which entry in its Map** it belongs to.
The server still never parses the payload; it only checks that `to` is in the *same* group room (otherwise
`no-such-participant`), so nobody can use it to message random sockets.

Group rooms use the Socket.IO room name `group:<id>`, so a 1:1 room and a group room with the same name never
receive each other's broadcasts (tested).

## The data structure

```
peersRef.current = Map {
  "s0cketB…" → { name: "B", role: "answerer", pc, dataChannel, state: { connection, ice, signaling }, pending: [], counts },
  "s0cketC…" → { name: "C", role: "offerer",  pc, dataChannel, … },
}
```

- **A ref, not state.** Socket callbacks and `pc.on…` handlers run long after the render that created them.
  They must all see the *current* Map. After every change `publish()` copies it into React state for rendering.
- Every handler checks `alive()`: "is this entry still in the Map, and is this still its pc?" Late events from a closed
  or replaced connection are ignored.

## Who sends the offer: the join rule

> The **new joiner** creates an offer to **everyone already in the room**. Existing users **only answer**.

```
A joins  → ack: participants []        → sends 0 offers
B joins  → ack: participants [A]       → offers to A
C joins  → ack: participants [A, B]    → offers to A, B
D joins  → ack: participants [A, B, C] → offers to A, B, C
```

Test result, 4 browsers: offers sent A 0, B 1, C 2, Phone 3. Glare: 0.

### Why it works

For **every pair** exactly one person joined later. The server handles `group:join` events **one at a time** (a single
Node process, a single event loop), so the later one always sees the earlier one in its participant list, and
the earlier one only ever gets `participant-joined`. Exactly one side of each pair offers, so two offers can never
cross. **No glare, without any extra logic.**

Even simultaneous joins are fine: if C and D click "Join" in the same millisecond, the server still processes one
first. Say C. Then D's list contains C, and C only hears `participant-joined(D)`.

There's also an ordering guarantee that makes the answerer side simple: the server emits `participant-joined` to the
others **before** acking the newcomer, the newcomer only sends offers **after** the ack, and Socket.IO keeps message
order per connection. So A always knows C's name before C's offer arrives.

### When it isn't enough

1. **Renegotiation.** Adding video or screen sharing later fires `negotiationneeded` on the side that added the track,
   and that may be the *older* user. Now either side can offer at any time, and two offers can cross → glare. Fix:
   **perfect negotiation** (§19), with "polite" = e.g. whoever joined later (the same order we already have).
2. **ICE restart / recovering a failed connection.** Who restarts? Both might try at once. Same problem.
3. **Reconnects.** If my socket reconnects I get a **new socket id**. To everyone else I'm a brand-new participant.
   This page handles it by closing *all* my connections and re-joining as the new joiner (clean, but it rebuilds the whole mesh).
   If the server hasn't noticed the old socket died yet (ping timeout ≈ 45 s after a network drop), the
   old id is still in the room as a "ghost". I'd send it an offer that goes nowhere until the server removes it.
4. **More than one signaling server** (e.g. several Node processes behind a load balancer + Redis). There's no single
   event loop deciding the join order anymore. Two servers could each tell their user "you're the newcomer" → both offer.

## Sequence: C joins a room with A and B

```
   A                    B                  Server                   C
   │                    │                    │                      │
   │                    │                    │◀── group:join ───────│  {roomId, name:"C"}
   │                    │                    │  rooms[r] = {A,B,C}  │
   │◀─ participant-joined(C) ────────────────│                      │   (to A and B FIRST…)
   │                    │◀─ participant-joined(C)                   │
   │ entry C: "waiting  │ entry C: "waiting  │── ack {participants:[A,B]} ─▶│   (…then the ack)
   │  for offer"        │  for offer"        │                      │
   │                    │                    │      C is the new joiner: for EACH of A, B:
   │                    │                    │      new RTCPeerConnection, createDataChannel("chat"),
   │                    │                    │      createOffer, setLocalDescription
   │                    │                    │◀─ signal{to:A, offer} ─│
   │◀─ signal{from:C, offer} ────────────────│                      │
   │                    │                    │◀─ signal{to:B, offer} ─│
   │                    │◀─ signal{from:C, offer}                   │
   │                    │                    │◀─ signal{to:A, candidate} × n (trickle)
   │◀─ signal{from:C, candidate} ────────────│  (queued by A if setRemoteDescription isn't done)
   │                    │                    │◀─ signal{to:B, candidate} × n
   │                    │◀─ signal{from:C, candidate}               │
   │ new pc for C       │ new pc for C       │                      │
   │ setRemoteDesc      │ setRemoteDesc      │                      │
   │ (drain queue)      │ (drain queue)      │                      │
   │ createAnswer       │ createAnswer       │                      │
   │── signal{to:C, answer} ────────────────▶│                      │
   │                    │                    │── signal{from:A, answer} ──▶│ setRemoteDesc on C↔A
   │                    │── signal{to:C, answer} ──▶│               │
   │                    │                    │── signal{from:B, answer} ──▶│ setRemoteDesc on C↔B
   │── candidates to C ─────────────────────▶│── from:A ───────────▶│ (queued by C during setRemoteDesc!)
   │                    │── candidates to C ▶│── from:B ───────────▶│
   │                    │                    │                      │
   │◀═══════════ ICE + DTLS + SCTP, direct ═══════════════════════▶│   C↔A connected, chat "open"
   │                    │◀════════ ICE + DTLS + SCTP, direct ══════▶│   C↔B connected, chat "open"
   │◀══════ A↔B (from when B joined) is not touched at all ═══▶│     │
```

The server only appears in the signaling part. A↔B already existed before C came and nothing about it changes.

**Candidate queue observed:** in the 4-browser test the *offerer* side queued candidates too (C: 2, Phone: 1). The
answerer sends its answer and then immediately trickles its candidates. On the offerer they arrive while
`await setRemoteDescription(answer)` is still running, so `pc.remoteDescription` isn't set yet. The queue is
**per peer** (`entry.pending`): B's early candidates must never be added to the connection with A.

## Group chat: N−1 sends, no forwarding

`sendChat` loops over the Map and sends the same JSON on **every open data channel**. There is no server and no relay,
so each message leaves your browser N−1 times. Consequences:

- The author is known exactly: whoever is at the other end of the channel it arrived on.
- If my link to B failed but A↔B works, **B never sees my messages**. Nobody forwards them. The chat shows
  "sent over 2/3 channels" so you can see it happen.
- No common ordering: two people typing at once can see the messages in different orders.

## Removing one peer without affecting the others

On `group:participant-left` (or B clicking *Leave*, or B's tab closing → socket drops → server sends `participant-left`):

```js
peersRef.current.delete(id);   // first, so late events from this pc are ignored (alive() → false)
entry.dataChannel?.close();
entry.pc?.close();
publish();
```

Each `RTCPeerConnection` has its own ICE agent, ports, DTLS session and SCTP association, so closing one can't disturb
the others. Tested: after B left, A, C and Phone stayed `connected` and C's message went "over 2/2 channels". After
Phone closed its tab, A↔C stayed connected. Then B re-joined as the newest member and sent 2 offers.

Leaving the page closes every connection and emits `group:leave` (effect cleanup). `pagehide` closes them immediately.

## How the number of connections grows

Every person connects to every other person: each of the N people has N−1 connections, and each connection is
counted twice (once from each end):

```
connections in the room = N × (N − 1) / 2          connections per person = N − 1
```

| N | room total | per person | chat: one message is sent | with 720p video (~1.5 Mbps each), upload per person |
| - | ---------- | ---------- | ------------------------- | ------------------------------------------------- |
| 2 | 1  | 1 | 1× | 1.5 Mbps |
| 3 | 3  | 2 | 2× | 3 Mbps |
| 4 | 6  | 3 | 3× | 4.5 Mbps |
| 5 | 10 | 4 | 4× | 6 Mbps |
| 6 | 15 | 5 | 5× | 7.5 Mbps (+ 5 encoders on a phone) |
| 10 | 45 | 9 | 9× | 13.5 Mbps: not happening on mobile |

It's **quadratic for the room, linear per person**. For chat this doesn't matter (bytes). For video, every
person encodes and uploads N−1 copies. Upload bandwidth and CPU are what kill a mesh, which is why the cap is 6 and
why bigger calls use an SFU (§20.2): 1 upload, N−1 downloads.

## Testing

**Automated (headless Chrome, 4 contexts, one with an Android user agent and phone viewport), against the running dev servers:**

| Check | Result |
| ----- | ------ |
| A, B, C, Phone join in order | All 4 fully meshed (6 connections, 3 per page `connected`) in **2.3 s** |
| Offers per user | A 0 · B 1 · C 2 · Phone 3, **0 glare** |
| Chat from A | B, C, Phone receive it with author "A"; A shows "sent over 3/3 channels" |
| B clicks Leave | A, C, Phone keep 2 `connected` peers each; chat "2/2" |
| Phone closes the tab | A↔C still `connected`; diagram shows N=2, 1 connection |
| B re-joins | B sends 2 offers, all `connected` |
| 7th user (raw Socket.IO) | `room-full` |
| `group:signal` to a socket in another room / to self | `no-such-participant` |
| Unicast | message 1→3 received **only** by socket 3 |
| 1:1 room with the same name | 0 group events leaked |

**By hand (real devices):** open `https://<LAN-IP>:5173/group?room=mesh-room` in 3 laptop tabs (names A, B, C)
and on the phone (same Wi-Fi), then:

1. Watch the event log of the last tab to join: one `→ offer` per existing person, then `← answer` from each.
2. Send a message from the phone: it should show up in every tab with the author "Phone".
3. Close one tab: the others show "X left", and their other connections stay green.
4. Put the phone on mobile data: its connections may go `failed` (symmetric CGNAT, see step 10), while laptop↔laptop
   stays up. That's the per-peer independence: one bad link doesn't take down the room. TURN fixes it.

## Quiz

1. A and B are in a room. A server bug sends C an *empty* participant list in its `group:join` ack, but A and B still
   get `participant-joined(C)`. What happens to the connections C↔A and C↔B? What would happen instead if the bug made
   A and B *also* offer to newcomers?
2. Why does `group:signal` need a `to` field when step 8's `signal` didn't? What would go wrong if the server broadcast
   C's offer to the whole room?
3. Why is the candidate queue stored **per peer** (`entry.pending`) instead of one queue for the hook? And why did the
   *offerer* (C) end up queueing candidates in the test, even though it set its own local description long before?
4. In a room of 5, how many `RTCPeerConnection`s exist in total, and how many does each browser hold? If everyone
   then turns on a camera at 1 Mbps, how much does each person upload?
5. Later you add a "share screen" button that calls `addTrack` on an *existing* connection. Why can the join rule
   no longer prevent glare, and what pattern fixes it?
