# Step 10: 1:1 peer-to-peer video call

Theory: `Webrtc.md` §10 (full flow), §13 (tracks, streams, transceivers), §18 (states & lifecycle), §21 (stats).

## What I built

| File | Role |
| ---- | ---- |
| `pages/Room.jsx` | Lobby (room + name) → call view: big remote tile, local picture-in-picture, controls, chat + people side panel, call status |
| `hooks/usePeerConnection.js` | + local tracks (caller before offer, callee after `setRemoteDescription`), `ontrack` → `remoteStream`, `replaceTrack`, `getStats`, `closeReason` |
| `hooks/useLocalMedia.js` | `start()` resolves with the stream, `switchDevice()` with the new track, `toggleEnabled()` returns the new value |
| `hooks/useChat.js` | + `sendJson` / `onData` for app messages over the data channel (`media-state`) |
| `components/CallControls.jsx` | Mute, camera off, switch camera, stats, hang up |
| `components/StatsOverlay.jsx` | Every 2 s over the remote video: path (candidate types), RTT, in/out bitrate, resolution, fps, codec, quality limitation |
| `components/VideoTile.jsx` | + overlay `children`, "click to play" if autoplay with sound is blocked |

## The whole flow: from opening the page to video playing

```
 1. Open https://<host>:5173/room          secure context (HTTPS via mkcert) → navigator.mediaDevices exists
 2. Socket.IO connects                     wss://<host>:5173/socket.io → Vite proxy → Express :4000 (polling → WebSocket)
 3. "Join call"                            getUserMedia({video, audio}) → local MediaStream (2 tracks), shown muted+mirrored in the PiP
 4. join-room {room, name, clientId}       server: rooms[room] = {A}; ack {peers: []} → "waiting for peer…"
 5. B does 1–4                             server: rooms[room] = {A, B}; B's ack {peers:[A]} → B waits; A gets peer-joined(B)
 6. A = caller                             new RTCPeerConnection({iceServers: STUN})
                                           addTrack(audio), addTrack(video), createDataChannel('chat')
                                           createOffer → setLocalDescription → ICE gathering starts
 7. A → signal "offer"                     server relays to B unchanged
 8. A → signal "candidate" × n             trickled as soon as onicecandidate fires (host, srflx…)
 9. B = callee                             new RTCPeerConnection; setRemoteDescription(offer)
                                           (+ add any candidates that arrived early: the queue)
                                           addTrack(audio), addTrack(video)  ← reuses the offer's transceivers
                                           createAnswer → setLocalDescription → B gathers, trickles candidates
10. B → signal "answer"                    A: setRemoteDescription(answer)
11. ICE                                    both sides pair candidates and run STUN connectivity checks;
                                           best working pair selected (host↔host on a LAN, srflx/prflx across NAT)
12. DTLS                                   handshake over that path; each side checks the cert against a=fingerprint
                                           → SRTP keys for media, SCTP for the data channel
13. connectionState: connected             ontrack fires (audio, video) → remote stream in the big tile → video plays
                                           ondatachannel / onopen → chat; media-state messages ("camera off")
14. During the call                        track.enabled for mute/camera off; sender.replaceTrack for switching;
                                           getStats every 2 s; consent checks keep the path alive
15. End                                    bye + pc.close() + track.stop() + leave-room → peer sees "peer hung up"
```

The server is involved in steps 2, 4–5, 7–8 and 10 only: **text in, text out**. From step 11 on, everything
is browser ↔ browser. (Step 9 proved it: the chat survived the backend being killed.)

## Tracks before offer/answer, and the callee's order

- **Caller**: `addTrack` **before** `createOffer`. Each track gets a transceiver, so the offer contains
  `m=audio` + `m=video` with `a=sendrecv`. Missing camera? `addTransceiver('video', {direction: 'recvonly'})`,
  so we can still receive.
- **Callee**: `setRemoteDescription(offer)` **first**, then `addTrack`. Applying the offer creates
  transceivers for its m-lines, and `addTrack` **reuses** the one of the matching kind that has no sender
  track yet. If the callee added its tracks *before* applying the offer, they'd sit in their own transceivers,
  which the answer cannot include (an answer can't add m-lines), so the callee's camera would never be sent.
- Both streams come from `getUserMedia` at **Join**, before signaling starts, so no `await getUserMedia()`
  sits between "offer arrived" and `setRemoteDescription` (the classic source of early candidates;
  the queue from step 9 handles it anyway).

## Mute, camera off, switch camera

- **Mute / camera off** = `track.enabled = false` on the local track. That's the *same object* the
  sender sends, so the peer gets silence / black frames immediately, with no signaling. The tracks keep
  running (verified: senders still hold `audio:false, video:false` tracks). A `{type:'media-state'}` message over
  the data channel tells the other side to show "📷 Phone turned the camera off" / 🔇 instead of a black rectangle.
- **Switch camera** = new camera track (`getUserMedia({deviceId: exact})`) → `sender.replaceTrack(newTrack)`.

### Why replaceTrack needs no renegotiation

SDP describes the **slots** (transceivers / m-lines): kind, direction, codecs, SSRCs, encryption, transport.
It does not describe *which camera* feeds a slot. `replaceTrack` keeps the transceiver, the m-line, the
SSRC, the negotiated codec and the ICE/DTLS transport, and just changes the frames going into the encoder. Nothing the
peer agreed to has changed, so there's nothing to renegotiate: no `negotiationneeded`, no new offer.

Verified: sender `fake_device_0 → fake_device_1`, `signalingState` stayed `stable`, still exactly **1 offer**
sent in the whole call, and the phone kept receiving.

You **do** need renegotiation when the *slots* change: adding a track of a new kind (or a second video), removing one
(`removeTrack`), changing direction, or a new track whose format the m-line can't carry.

Compare with step 4: there the camera switch only touched the local `MediaStream`. In a call, the stream
in the preview and the sender are **separate**, so both must be updated (`switchDevice`, then `replaceTrack`),
or the preview shows the new camera while the peer sees the old (stopped) one freeze.

(Test-harness gotcha: Chrome's second *fake* camera emulates a depth camera (Y16) that WebRTC can't encode.
In a bare loopback it sends 0 frames. Switching back to fake camera 0 resumed at 1280×720 / 620 kbps.
Real cameras are fine.)

## Call status

| Shown | Derived from |
| ----- | ------------ |
| waiting for peer… | in a room, nobody else |
| connecting… | peer present; `connectionState` `new`/`connecting`, or waiting for the offer |
| connected | `connectionState === 'connected'` |
| reconnecting… | `disconnected`: often a Wi-Fi hiccup, so wait (§18) |
| peer left / peer hung up | `peer-left` / `bye` |
| connection failed | `failed` → pc closed; "Call again" button while the peer is still in the room |

## Cleanup (verified with instrumented `RTCPeerConnection` + `getUserMedia`)

| Trigger | What happens | Result in the test |
| ------- | ------------ | ------------------ |
| **Hang up** | `bye` → `pc.close()` → `media.stop()` (all tracks) → `leave-room` → lobby | phone: pc `closed`, **0 live tracks**; laptop: "peer hung up" |
| **Route change** | unmount: usePeerConnection closes the pc, useLocalMedia stops tracks, useSignaling emits `leave-room` | laptop: pcs `closed`, **0 live tracks**; phone: "peer left" |
| **Tab close / reload** | `pagehide`: `bye` + `pc.close()` + stop tracks; the socket drop also makes the server send `peer-left` | laptop instantly: "peer hung up", pc closed |

`pc.close()` does **not** stop local tracks: they belong to `useLocalMedia`, so hang-up stops them
explicitly (otherwise the camera light stays on).

## Stats overlay (what a LAN call looks like)

```
path host udp ↔ prflx · RTT 1.0 ms
↓ in  video 248 kbps · 640×360 @ 19 fps · VP8
↓ in  audio  25 kbps · opus · lost 0/0
↑ out video 203 kbps · 480×270 @ 20 fps · VP8 · limited by bandwidth
↑ out audio  24 kbps · opus
```

- "limited by bandwidth" right after connecting: the congestion controller (transport-cc) **starts low and ramps up**.
  Resolution and bitrate climb over the first seconds (later samples: 1280×720 at ~620 kbps).
- `prflx` remote: the peer's checks reached us before its candidate did (step 7).
- `relay` would mean TURN, shown as "(TURN)".

## Testing: two tabs → laptop ↔ phone (Wi-Fi) → phone on mobile data

- **Two tabs / two browser profiles**: works (automated test, fake devices). With real mics, use headphones.
- **Laptop ↔ phone on the same Wi-Fi**: works in the automated test with the phone emulated on the LAN IP.
  On the real phone the expected path is host ↔ host, or srflx/prflx if mDNS `.local` names don't resolve between devices.
- **Phone on mobile data**: *expected to fail sometimes*. See below. The test for this must be done by hand.

### Why mobile data may fail: NAT, and why TURN is the next phase

On mobile data the phone is behind the carrier's **carrier-grade NAT (CGNAT)**, often a **symmetric** NAT, and the
laptop is behind the home router's NAT. Then:

1. **host** candidates are private addresses (192.168.x.x, 10.x.x.x). Each side can't reach the other's.
2. **srflx** (from STUN) is "my public IP:port *as seen by the STUN server*". A symmetric NAT assigns a **different
   external port for every destination**, so the mapping the STUN server saw is not the one the peer would need to use.
   The peer's packets arrive at a port that isn't open, and the NAT drops them.
3. Hole punching works when at least one side has an "endpoint-independent" NAT (most home routers). With
   symmetric ↔ symmetric (or restrictive firewalls, UDP blocked on corporate Wi-Fi) no direct pair ever passes the
   connectivity checks → `iceConnectionState: failed` after ~30 s → "connection failed".
4. **TURN** fixes it: a relay server with a public IP. Each peer sends its media *to the relay*, which forwards it.
   It yields `relay` candidates that always work (as long as the relay is reachable, also over TCP/TLS 443),
   at the cost of server bandwidth and a bit of latency. In practice ~10–20% of real-world calls need TURN.

Next phase: run **coturn**, have the backend hand out **short-lived credentials** (HMAC over a timestamp, never a
static password in the frontend), add it to `iceServers`, and watch `relay` show up in the stats overlay. Also
`iceTransportPolicy: 'relay'` to *force* TURN for testing.

## Quiz: steps 1–10

1. Why does `navigator.mediaDevices` exist on `https://192.168.0.115:5173` but not on `http://192.168.0.115:5173`,
   while `http://localhost:5173` works? Why can the backend stay plain HTTP on `localhost:4000`?
2. Why can't you write `<video srcObject={stream} />` in React, and why is the local preview `muted`?
3. A user clicks "mute". Should you call `track.stop()` or set `track.enabled = false`? What does the peer receive in each
   case, and what happens to the camera light?
4. Why are device labels empty before permission is granted, and what does `enumerateDevices()` return then?
5. In an SDP offer you see `a=group:BUNDLE 0 1 2`, `m=audio`, `m=video`, `m=application`. Where did each m-section come
   from in code, and how many ICE connections will there be?
6. What do `a=fingerprint` and `a=setup:actpass` do, and why must the signaling channel itself be trustworthy?
7. Order these candidate types by priority and explain each: `relay`, `host`, `srflx`, `prflx`. What is a `.local` address?
8. What is trickle ICE, why does it need a real-time signaling channel, and what is the "early candidate" bug and its fix?
9. Why did the chat keep working when the backend was killed? What exactly does the signaling server do, and what does it never do?
10. Switching cameras mid-call uses `sender.replaceTrack()`. Why is no new offer/answer needed, and when *would* you need one?
    Bonus: why does a call between a laptop on home Wi-Fi and a phone on mobile data sometimes fail without TURN?

<details>
<summary>Answers</summary>

1. Camera/mic need a **secure context**: HTTPS, or `http://localhost` (loopback never leaves the machine). Plain HTTP over the
   LAN could be tampered with (injected JS using your camera), so browsers hide `mediaDevices` entirely. The backend is only
   reached by **Vite's proxy on the same machine** (loopback), never by the browser; the browser sees one HTTPS origin, with no
   mixed content and no CORS.
2. JSX props become HTML **attributes** (strings); `srcObject` is a DOM **property** holding a live object, so set it via a ref
   in an effect. Muted: hearing your own mic causes **feedback/echo**, and muted video can **autoplay** without a gesture.
3. `enabled = false`: the peer gets **silence/black frames**, the track and device stay open (light usually on), instantly
   reversible. `stop()`: the track **ends** permanently (light off), and you'd need a new getUserMedia + `replaceTrack` to come back.
   Mute buttons use `enabled`.
4. **Fingerprinting protection**: device names + stable IDs would identify you across sites. Before permission:
   one entry per kind with **empty `deviceId` and `label`**. After permission: full list, per-origin IDs.
5. `m=audio`/`m=video` from `addTrack` (or `addTransceiver`), one per transceiver; `m=application` from `createDataChannel`
   (one for all channels). BUNDLE → **one** ICE connection / one DTLS handshake for all three.
6. `a=fingerprint` = hash of the peer's DTLS certificate; the handshake checks it, which binds encryption to the signaling.
   `actpass` = "I can be DTLS client or server" (the answer picks `active`/`passive`). A malicious signaling server could swap
   the fingerprint and sit in the middle → signaling must be authenticated and over TLS.
7. **host (126) > prflx (110) > srflx (100) > relay (0)** (type preference). host = own interface; srflx = public address
   seen by STUN; prflx = learned from incoming connectivity checks; relay = TURN server address. `.local` = a random **mDNS** name
   hiding your private IP from the page (shown as the real IP once camera permission is granted).
8. Send each candidate **as soon as it's found** instead of waiting for gathering → checks start earlier, faster setup.
   Needs millisecond delivery (step 7: a human copy-pasting is hopeless). Early-candidate bug: `addIceCandidate` before
   `setRemoteDescription` → `InvalidStateError`/lost candidate, typically when the callee `await`s something first.
   Fix: **queue** them until the remote description is set, then flush.
9. Media/data flow **directly between browsers** (ICE path, DTLS/SRTP/SCTP). The server only **relays signaling text**
   (offer, answer, candidates) and manages rooms. It never parses the SDP and never sees media.
10. `replaceTrack` keeps the transceiver, m-line, SSRC, codec and transport; nothing in the negotiated session changes,
    only the frames fed to the encoder. You'd need renegotiation to **add/remove** tracks/transceivers, change direction,
    or add the first data channel. Bonus: CGNAT/**symmetric NAT** on mobile data uses a different external port per
    destination, so srflx candidates don't work and hole punching fails; a **TURN relay** is needed.

</details>
