# Step 9: Peer-to-peer data channel over real signaling

Theory: `Webrtc.md` §9.7 (trickle ICE), §10 (full connection flow), §17 (data channels).

## What I built

| File | Role |
| ---- | ---- |
| `hooks/usePeerConnection.js` | One RTCPeerConnection: `startAsCaller`, `handleSignal` (offer/answer/candidate), `close`; trickle ICE out, **candidate queue** in; states, data channel, selected pair (getStats every 2 s) |
| `hooks/useChat.js` | + `notifyTyping()` (throttled, 1 msg / 2 s) and `peerTyping` (clears after 3 s or on their message) |
| `components/ChatBox.jsx` | + "Peer is typing…", sent/received labels with timestamps |
| `pages/Room.jsx` | Caller/callee logic, peer-connection card (states, selected pair type, RTT, candidate counters), Hang up / Connect, slow-callee switch |
| backend | `clientId` per browser tab, passed in `peer-joined`, `peers` and relayed `signal`s (`fromClientId`) |

## The flow

```
 Laptop (already in room)          Server                Phone (joins second)
   │                                 │ ◄──── join-room ──────│
   │ ◄──── peer-joined(Phone) ───────│ ───── ack(peers:[Laptop]) ─►  "I'm the callee: wait"
   │ I'm the CALLER:                 │                       │
   │ createDataChannel('chat')       │                       │
   │ createOffer, setLocalDescription│                       │
   │ ── signal offer ───────────────►│──── offer ───────────►│ new RTCPeerConnection
   │ ── signal candidate (host) ────►│──── candidate ───────►│   (queued if remote desc not set yet)
   │                                 │                       │ setRemoteDescription(offer) + flush queue
   │                                 │                       │ createAnswer, setLocalDescription
   │ ◄────────────── answer ─────────│◄─── signal answer ────│
   │ ── signal candidate (srflx) ───►│──── candidate ───────►│
   │ ◄────────── candidate (host) ───│◄─── signal candidate ─│
   │ ◄═════ ICE checks → DTLS → SCTP: data channel "chat" open (DIRECT) ═════► │
```

Measured on the laptop: `peer-joined` → connected in about **110 ms**. The selected pair was **host ↔ host**
(both on this machine/LAN), RTT 1 ms.

**Who's the caller?** The user who receives `peer-joined` (the one already in the room). Only one side
ever offers, so there's no glare. The second user learns from the join ack that someone is there, and just waits.

## Trickle ICE

`pc.onicecandidate = (e) => send('candidate', e.candidate.toJSON())`, as soon as each one is found.
The log shows the caller's host candidate going out **before the answer even came back** (23.838 vs
23.852). Checks start as early as possible, which is the whole point of trickle (compare step 7).

## The candidate queue, and why this bug is so common

`addIceCandidate()` needs to know which ICE session (ufrag/pwd, m-sections) the candidate belongs to,
and it learns that from the **remote description**. Call it before `setRemoteDescription` and you get
`InvalidStateError` (or the candidate is silently lost), and the connection may never come up.

**Why it bites almost everyone:**

1. **Trickle makes candidates fast.** The caller fires candidates within milliseconds of the offer, often
   before the callee has even *processed* the offer.
2. **The callee does async work first.** Creating the peer connection lazily, `await getUserMedia()` (step 10!),
   loading settings, or showing a "accept call?" prompt. Anything between "offer arrived" and
   "setRemoteDescription finished" is a window where candidates arrive too early.
3. **It works on localhost and fails in the real world.** On the same machine everything is so fast that the
   order happens to be right. Add a phone, a slow network or a permission prompt and it breaks
   intermittently. A classic "works on my machine" race.
4. **Message handlers are independent.** Each signaling message is handled in its own callback; nothing
   naturally makes the `candidate` handler wait for the `offer` handler's `await`s.
5. **It can fail silently.** An unhandled promise rejection from `addIceCandidate` just means one candidate
   fewer. If it was the important one (the only working pair), you get a mysterious "sometimes doesn't connect".

**Fix** (in `usePeerConnection`): if there's no peer connection yet, or `pc.remoteDescription` is still null,
push the candidate into `pendingRef`; right after `setRemoteDescription` resolves, add them all. The queue is
cleared whenever the connection is closed or replaced.

**Seen it happen:** tick "Simulate slow setRemoteDescription (1 s)" on the callee before joining:

```
← offer (458 chars) → I am the CALLEE
(slow callee simulation: waiting 1000 ms before setRemoteDescription)
← candidate host udp …local:47913 QUEUED (no remote description yet)
← candidate srflx udp <public IP>:47913 QUEUED (no remote description yet)
Added 2 queued candidate(s) after setRemoteDescription
→ answer
connectionState → connected
```

## Proof it's peer to peer

With both connected, I **killed the backend** (port 4000 not listening, Socket.IO showing `connect error:
xhr poll error`) and kept chatting:

```
[sent]     backend is DOWN, still here?   (laptop)
[received] yes! peer-to-peer               (phone → laptop)
```

The data channel is SCTP over DTLS over the ICE-selected UDP path **between the two browsers**. The
server was only needed to *introduce* them (offer, answer, candidates). Once connected, it isn't in
the path at all. (The Room page shows a banner when that's the situation.)

When the backend came back (nodemon restart), both sockets reconnected and re-joined. The phone got
`peer-joined: Laptop` again, and because it's the **same `clientId`**, it **kept** the existing connection
instead of renegotiating: still exactly **one** RTCPeerConnection per side.

`clientId` (`crypto.randomUUID()` per page load) is needed because `socket.id` changes on every
reconnect. Without it, a signaling reconnect would look like a new peer → tear down a perfectly good call.
A **page reload** creates a new `clientId`, so the old connection is closed and a fresh one negotiated, which is correct.

## StrictMode: never two peer connections

- The RTCPeerConnection is created **only in event handlers** (`peer-joined` → `startAsCaller`, incoming
  `offer` → callee), never in a `useEffect`. StrictMode double-runs effects, not event handlers.
- `useSignaling` removes every socket listener in cleanup, so `peer-joined` can't be handled twice either.
- `createPc()` closes any existing connection first, and a generation counter makes callbacks of a closed
  connection ignore late events.
- The only effect that touches the pc is unmount cleanup (`pc.close()`), which is fine to run twice.
- Verified by wrapping the constructor in the test: `1 created` per side after connecting, and after a
  signaling reconnect. Leave + rejoin made it `closed, connected` (old one properly closed).

## When the peer leaves

| Event | What happens |
| ----- | ------------ |
| `peer-left` (Leave button / tab closed / navigated away) | `peer.close()`, UI back to "waiting", chat shows `none` |
| `bye` signal (Hang up) | both sides close; "Connect (I'll be the caller)" appears while both are still in the room |
| `connectionState: failed` | closed automatically |
| signaling server down | **nothing**: the P2P connection keeps going |

## chrome://webrtc-internals

Open it in a separate tab **while** the Room is connected:

- One tab per page with a peer connection. Each shows the config (`iceServers: stun:stun.l.google.com:19302`).
- **Event log**: `setLocalDescription (offer)`, `setRemoteDescription (answer)`, `icecandidate`, state changes, with timestamps.
- **Stats tables**: `candidate-pair (state=succeeded)` (the selected pair is bold), `local-candidate` /
  `remote-candidate` with their types, `data-channel (label=chat, state=open)` with `messagesSent/Received`,
  `transport (dtlsState=connected)`, and two `certificate` entries whose fingerprints match the SDP's `a=fingerprint`.
- "Create a WebRTC-Internals dump" downloads everything as JSON, which is useful for bug reports.

## Testing laptop ↔ phone (real devices)

1. Laptop: `https://localhost:5173/room` → Join. The page shows the phone link (`https://192.168.0.115:5173/room?room=…`).
2. Phone (same Wi-Fi): open the link, accept the cert warning if you haven't installed the CA (step 2), Join.
3. Chat, and watch "typing…". The selected pair should be **host ↔ host** (same LAN), or **srflx/prflx** if mDNS
   (`.local`) names don't resolve between the devices. Some Android/router combos block multicast DNS. Either
   way it connects; that's ICE doing its job.
4. Stop the backend (Ctrl+C in its terminal), keep chatting. Start it again: both re-join, and the
   connection is kept.

Automated version of all of the above (headless Chrome, phone emulated on the LAN IP): passed. Steps 1–4
on the actual phone are for me to do by hand.

## Exercises

1. **Unordered / unreliable channel.** Add a second channel `createDataChannel('cursor', { ordered: false,
   maxRetransmits: 0 })` and stream mouse/touch positions. Why is that the right choice for positions but not for chat?
2. **Large messages.** Send a 1 MB string. What happens? Chunk it (16 KB) and use `bufferedAmount` /
   `bufferedamountlow` for backpressure, the basis of file transfer.
3. **ICE restart.** On `iceConnectionState: disconnected`, call `pc.restartIce()` and renegotiate through
   signaling. Test it by switching the phone from Wi-Fi to mobile data mid-chat.
4. **Read receipts.** Send `{type:'ack', id}` when a message is received and show ✓✓ on the sender's side.
