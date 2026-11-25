# Step 13: a robust mesh, and measuring why it doesn't scale

Theory: `Webrtc.md` §15 (quality control), §18 (states & lifecycle), §19 (perfect negotiation), §20.1 (mesh), §21 (stats).

Page: **`/group`** (Group Mesh). New buttons: 🖥️ Share screen, 📊 Stats, and ↻ ICE per participant.

## What changed

| File | Role |
| ---- | ---- |
| `hooks/useMeshRoom.js` | Perfect negotiation per peer, `pcId`/`toPcId` on every signal, per-peer ICE recovery, reconnect reconciliation, screen share on every pc, `setMaxBitrate`, `getPeerStats` |
| `services/meshStats.js` | `getStats()` → one summary per pc: path, RTT, up/down kbps, video sent/received, loss both ways, `qualityLimitationReason`, encode/decode CPU |
| `components/PeerStatsTable.jsx` | One row per peer every 2 s + totals tiles + "max bitrate" selectors (all peers / per row) |
| `backend/services/groupRoomService.js` | Participants carry `clientId`; a re-join by the same tab replaces its stale socket instead of adding a duplicate |
| `backend/socket/groupHandlers.js` | `group:signal { to }` is now a **clientId**; `from` too |
| `ParticipantList` / `ParticipantTile` / `VideoGrid` / `CallControls` | polite/impolite, offers/glare/restarts counters, ↻ ICE; screen tiles; optional Share-screen button |

## Peer identity: clientId, not socket id

You asked for polite/impolite decided **by comparing socket IDs**. I compare **clientIds** instead (the per-tab
`crypto.randomUUID()` from step 8), and peers are keyed by clientId in the Map and in `group:signal`. Why:

- A socket id changes on **every reconnect**. Requirement 3 (backend restart) gives *everyone* a new socket id. Keyed by
  socket id, every peer would look like a stranger after the restart: duplicates, or tearing down working calls.
- Polite/impolite must be decided the **same way on both sides at the same time**. Right after A reconnects, A compares
  its *new* socket id with B's, while B still compares A's *old* one. For a moment both can conclude "I'm impolite".
  Then both ignore each other's offers and the negotiation deadlocks. With ids that never change, that can't happen.

Same idea as comparing socket ids, but with an id that's stable for the lifetime of the tab.

## 1. Perfect negotiation, per peer

Every `RTCPeerConnection` has its own little state machine. One instance per peer:

```js
entry.polite = myClientId > peerId;                    // both sides compute it, no messages needed

pc.onnegotiationneeded = async () => {                 // THE only place offers are made
  entry.makingOffer = true;
  await pc.setLocalDescription();                      // implicit createOffer
  send({ pcId, toPcId, description: pc.localDescription });
  entry.makingOffer = false;
};

// on { description }
const readyForOffer = !entry.makingOffer && (pc.signalingState === 'stable' || entry.settingRemoteAnswer);
const collision = description.type === 'offer' && !readyForOffer;
entry.ignoreOffer = !entry.polite && collision;
if (entry.ignoreOffer) return;                         // impolite: "mine wins"
await pc.setRemoteDescription(description);            // polite + collision: implicit ROLLBACK of my offer
if (description.type === 'offer') { await pc.setLocalDescription(); send(answer); }

// on { candidate }
try { await pc.addIceCandidate(c) } catch (e) { if (!entry.ignoreOffer) throw e }   // candidates of an ignored offer may fail
```

What goes through `negotiationneeded` now: the first offer (new joiner adds tracks + data channel), screen share
start/stop, `restartIce()`, and the answerer's own renegotiation when it needs an m-line the offer didn't have.
None of that code checks "am I the caller?" anymore.

The step 11 join rule still decides who **starts**: only the new joiner adds the data channel, so there's exactly one
`"chat"` channel per pair. Perfect negotiation covers **everything after** that.

**Seen in the test** (A and B shared their screens at the same moment, then restarted ICE toward each other in the same millisecond):

```
A: [B] ← offer COLLIDED with mine: I'm impolite → ignoring theirs (they'll roll back)
B: [A] ← offer COLLIDED with mine: I'm polite → rolling back mine, accepting theirs
```

Both sides end in `stable`. B's rolled-back change isn't lost: after the rollback the browser re-checks and fires
`negotiationneeded` again, so B sends its offer *after* A's (B: 4 offers, A: 2 for the same pair).

### pcId / toPcId: knowing which connection a message is for

Every signal carries the sender's pc id and the pc id it thinks it's talking to:

- an **offer with a new `pcId`** = "I threw my connection away and started a new one" → replace mine too
  (instead of feeding a brand-new DTLS/ICE session into the old pc, which would fail);
- a message with **`toPcId` ≠ my current pc** = meant for a connection I already replaced → ignored.

Without this, a late answer or candidate from a dead connection could land on its replacement.

## Screen share mid-call = renegotiation with every peer

```js
for each peer: pc.addTransceiver(screenTrack, { direction: 'sendonly', streams: [screenStream] })  → negotiationneeded × (N−1)
stop:          sender.replaceTrack(null); transceiver.direction = 'inactive'                         → negotiationneeded × (N−1)
again:         replaceTrack(track); sender.setStreams(newStream); direction = 'sendonly'                → reuses the SAME m-line
```

- Each pc gets a **new m-line** (`m=video … a=sendonly`). The SDP changes, so it's an offer/answer per peer.
- Stop doesn't `removeTrack`: a stopped transceiver keeps its m-line, and `addTrack` wouldn't reuse it, so the SDP
  would grow by one m-line every time you share. Making it `inactive` and reusing it keeps the SDP the same size.
- On the receiving side the track leaves its `MediaStream` (`removetrack`). An empty stream → the tile disappears.
- **Which remote stream is the screen?** The stream id survives the trip (`a=msid:<stream id> …`), and
  `media-state` carries `screenStreamId`. The other stream is the camera.
- **Joining while someone shares** (tested: D joined while A and B shared): D's offer has no slot for A's screen. A
  answers, then A's `addTransceiver` fires `negotiationneeded` **on the answerer side**, so A sends an offer to D.
  Before perfect negotiation, "the answerer offers" wasn't allowed. Now it's routine.

## 2. Per-peer recovery

```
connected ──▶ disconnected ──(5 s, still not back)──▶ restartIce()      'disconnected' is often a hiccup: ICE retries by itself
          └─▶ failed ─────────────────────────────▶ restartIce()      immediately (max 3 attempts, reset on 'connected')
```

- `pc.restartIce()` = new ICE ufrag/password → `negotiationneeded` → an offer through perfect negotiation → both sides
  gather fresh candidates and re-run connectivity checks. **DTLS, tracks, transceivers and the data channel stay.**
  Only the network path is rediscovered (new Wi-Fi, mobile ↔ Wi-Fi, NAT mapping expired).
- It's **per pc**: the timer, the attempt counter and the restart belong to one entry. The other connections don't notice.
  Test: ↻ ICE on C→A: C's restarts for A 0 → 1, offers 1 → 2. B and D counters unchanged, all four stayed `connected`.
- Both sides can hit `failed` at the same time and both call `restartIce()` → two offers cross → glare → handled by perfect negotiation.

**By hand:** in a call with the phone, turn the phone's Wi-Fi off for ~10 s (it falls back to mobile data or nothing),
then on again. The laptop log shows `disconnected` → `still disconnected after 5 s → restartIce() #1` for the phone
only. On mobile data without TURN it may stay `failed` (step 10: symmetric CGNAT).

## 3. Socket reconnect (backend restart) without duplicates

The signaling server is **only** needed to set up connections. Media and data channels are peer-to-peer, so a
backend restart shouldn't hang up anyone's call. What happens now:

1. Server dies → every socket `disconnect`. **P2P connections keep running** (video keeps playing).
2. Server is back → Socket.IO reconnects (new socket id) → `group:join { roomId, name, clientId }`.
3. The ack lists who's already back. **Reconcile:** for each listed participant, if I have an entry for that
   clientId and its pc isn't closed or failed → **keep it**, just update its socket id. Only missing or dead connections are rebuilt.
4. Those who re-join after me trigger `participant-joined`: same clientId + live pc → "re-joined after a reconnect: keeping our P2P connection".
5. **resync** each kept pc: if it was stuck in `have-local-offer` (the offer was lost while offline) → `rollback`
   (the browser re-fires `negotiationneeded` if still needed). If it's `disconnected`/`failed` → `restartIce()`.
6. Anyone not back within **15 s** is removed.

Supporting pieces:
- Server: a `group:join` from a clientId that's already in the room under an **old socket** (a client-side blip
  where the server hasn't noticed the old socket died yet) **replaces** it: no duplicate, no `participant-left`.
- `participant-left` with reason `disconnected` while our P2P link is still `connected` → don't hang up, wait
  15 s for a re-join. (Reason `left` = they clicked Leave → remove immediately.)
- `{type:'bye'}` over the data channels on Leave and on `pagehide`: peers remove you immediately (test: 154 ms),
  without waiting for the server.
- `sendSignal` refuses to send while the socket is offline. Socket.IO would otherwise buffer it and flush it
  on reconnect *before* we've re-joined, and the server would drop it as "not in room".

**Test** (4 tabs, `touch backend/server.js` → nodemon restarts the server): everyone re-joined in **3.1 s**.
`RTCPeerConnection`s created: **3 per tab before, 3 per tab after** (none rebuilt), 3 participants per tab (no duplicates).
Log: `Re-joined after a signaling reconnect: kept 3 existing P2P connection(s), created 0`. Then a screen share
(renegotiation over the *new* sockets) worked straight away.

## 4–5. Per-peer stats and totals

| Column | From getStats | What it tells you |
| ------ | ------------- | ----------------- |
| Path | selected `candidate-pair` → local/remote `candidateType` | host ↔ host on a LAN, srflx/prflx through NAT, relay = TURN |
| RTT | `candidate-pair.currentRoundTripTime` | network latency to that peer |
| ↑ up / ↓ down | Δ `transport.bytesSent/Received` × 8 / Δt | everything on the wire for this pc: RTP + RTCP + data channel |
| I send / I receive | `outbound-rtp` / `inbound-rtp` video `frameWidth×frameHeight@framesPerSecond` | what congestion control and CPU adaptation left of your camera |
| Loss ↓ / ↑ | ↓ Δ`packetsLost` / Δ(lost+received) on inbound · ↑ `remote-inbound-rtp.fractionLost` (what the peer reports back) | network quality per direction |
| Limited by | `outbound-rtp.qualityLimitationReason` | `bandwidth` (congestion control), `cpu` (encoder can't keep up), `none` |
| Encode CPU | Δ `totalEncodeTime` / Δt | fraction of **one core** spent encoding video for that peer |

**Totals** (tiles above the table): my total upload, total download, number of video encoders running, encode/decode CPU.

## 6. Max bitrate per peer: `sender.setParameters`

```js
const params = sender.getParameters();
params.encodings[0].maxBitrate = 150_000;   // bits/s; delete it for "unlimited"
await sender.setParameters(params);          // live, no renegotiation (nothing in the SDP changes)
```

The congestion controller of that one pc may never exceed the cap, so the encoder lowers quality, then resolution,
then frame rate to fit. That's how a mesh tries to survive: if every person caps every peer at 300 kbps, upload is
(N−1) × 300 kbps instead of (N−1) × 1.5 Mbps. The cost is that everyone looks worse to everyone. Per-row
selectors let you squeeze one bad link (a phone on 4G) without hurting the others.

Test: cap 150 kbps on A for all peers → every video sender has `maxBitrate: 150000`, A's per-peer upload went from
~360–530 kbps to **175–205 kbps** (150 video + ~30 audio + headers), and A's sent video dropped to 640×360.

Caps re-apply automatically: on `connected`, and whenever signaling returns to `stable` (a new screen sender only has
`encodings` after it's negotiated).

## The experiment: 2 → 6 participants

### Setup
1. **Close** other heavy apps. Plug in the laptop (battery saver throttles the CPU). Note the CPU model and core count (`nproc`).
2. Open `htop` (or `top`, press `1` for per-core) in a terminal next to the browser.
3. Tab A = the one you watch. Open the 📊 stats there. Use headphones / mute other tabs (echo).
4. For each N: add one participant (a tab or the phone), **wait 30 s** (congestion control ramps up), then read
   the stats tiles on A, the per-row "I send" and "Limited by", and `htop` (the sum of the chrome/firefox lines).
5. Optional: repeat N = 4 with "Max video bitrate, every peer = 300 kbps" *on every tab* and compare.

### Your table

| N | A upload (kbps) | A download (kbps) | A encoders | A encode CPU (% core) | What A sends (res@fps) | Limited by | Browser CPU % (htop) | Quality (1–5) | Fan noise 😄 (0–3) |
|---|---|---|---|---|---|---|---|---|---|
| 2 | | | 1 | | | | | | |
| 3 | | | 2 | | | | | | |
| 4 | | | 3 | | | | | | |
| 5 | | | 4 | | | | | | |
| 6 | | | 5 | | | | | | |
| 4, capped 300 | | | 3 | | | | | | |

Upload formula to check against: **upload ≈ (N−1) × (video + ~30 kbps audio + overhead)**.

### My reference run (12-core laptop, headless Chrome, fake 720p camera, all tabs on ONE machine)

| N | A upload | A download | A encoders | A encode / decode CPU | What A sends | Limited by | All tabs CPU (top, 100 % = 1 core) |
|---|---|---|---|---|---|---|---|
| 2 | 585 kbps | 584 kbps | 1 | 6 % / 3 % | 1280×720 @ 21 | none | 72 % |
| 3 | 1.30 Mbps | 1.27 Mbps | 2 | 27 % / 7 % | 1280×720 @ 21 | none | 234 % |
| 4 | 890 kbps | 753 kbps | 3 | **261 %** / 9 % | 1280×720 @ **6–9** | none | **921 %** |
| 5 | 475 kbps | 521 kbps | 4 | 349 % / 2 % | 960×540 @ **2–3** | **cpu**, bandwidth | 976 % |
| 6 | 873 kbps | 894 kbps | 5 | 160 % / 4 % | 640×360–960×540 @ 3–7 | **cpu**, bandwidth | 992 % (≈ 10 of 12 cores) |

(The 2→3 jump at constant quality is the clean "N−1" part: upload ×2.2, encode CPU ×4.5. From 4 on, the machine is
saturated, and the numbers you'd *expect* (3× and 4× the upload) never happen. Instead the frame rate collapses.)

### Explaining the results

**Why upload grows as N−1.** In a mesh, nobody forwards anything. If B, C and D all want my camera, my browser
must send it to each of them **separately**: three connections, three RTP streams, three times the bits. Upload =
(N−1) × one stream. With 720p at ~1.5 Mbps that's 7.5 Mbps at N=6. Home upload links are often 5–20 Mbps,
mobile uplinks less and highly variable. Download is also N−1 streams, but that's the same in an SFU, and download
links are usually much bigger.

**Why encoding the same video N−1 times kills the CPU.** Step 12: one camera track, but **every `RTCRtpSender` runs its own encoder**.
They can't share one encoded stream, because each connection has its own:
- **congestion controller and bitrate**: the phone on 4G gets 300 kbps, the laptop on LAN gets 1.5 Mbps. Different
  bitrates need different encodes (and different resolutions/frame rates as they adapt);
- **keyframe requests** (PLI/FIR): when one receiver loses packets it asks for a keyframe; sharing an encoder would force
  keyframes on everyone;
- **SSRC, sequence numbers, SRTP keys**: per connection. (These could be rewritten after encoding, but browsers don't do that.)

Video encoding is the most expensive thing a browser does (motion search, transforms, entropy coding, at 30 fps), and
VP8 in Chrome is usually software. So CPU ≈ (N−1) × one encode + (N−1) decodes. When the encoder can't finish a frame
in 33 ms, `qualityLimitationReason` turns to **`cpu`** and WebRTC degrades: fewer fps first (with the default
`balanced` preference), then resolution. In the table, A's frame rate went 21 → 6–9 → 2–3 fps. Upload even **went
down** at N=4–5, because a starving encoder produces fewer, smaller frames. A mesh doesn't fail loudly. It just gets uglier.

**Caveat for your experiment: N tabs on ONE laptop is the worst case.** Each tab encodes N−1 times, so the laptop runs
**N × (N−1)** encoders: 2, 6, 12, 20, 30 for N = 2…6 (plus N × (N−1) decoders and video elements). In a real call each
person has their own machine and pays (N−1). Your phone is the more realistic data point: watch its tile frame rate,
`qualityLimitationReason` for the phone's row (on the phone's own stats), and how hot it gets.

### When an SFU becomes necessary

An SFU (§20.2): you send **one** stream (or 2–3 simulcast layers) **up** to the server, and it **forwards** each
receiver the layer it can handle. Upload and encoders: 1 instead of N−1. Download: still N−1 (but the SFU can send
thumbnails at low quality and only the active speaker in HD).

| Situation | Mesh OK? |
| --------- | -------- |
| 2 people | Mesh = SFU, but cheaper (no server, lowest latency). Use P2P. |
| 3–4 people, laptops, good upload, video ≤ 720p | Works (tested: 2–3 fine; 4 is the edge on one machine) |
| Any phone in the call, or uplinks < 5 Mbps | SFU from 3–4 people |
| 5+ people with video | SFU. Upload and CPU are already saturated |
| Recording, server-side moderation, large audiences, dial-in | SFU (or MCU): the server needs to see the streams anyway |
| Data only / chat / audio only | Mesh scales further (audio ~30 kbps per peer, cheap to encode) |

Rule of thumb: **mesh is for 2–4 people. Beyond that, or with mobile participants, you want an SFU** (mediasoup,
LiveKit, Janus, Jitsi). The signaling you built (rooms, per-peer messages, perfect negotiation, stats) carries over.
Only "one pc per peer" becomes "one pc to the SFU".

## Automated tests run for this step

| Check | Result |
| ----- | ------ |
| Simultaneous screen share A + B | collision on A↔B: impolite A ignored, polite B rolled back; all `stable`, 2 screen tiles everywhere |
| Forced glare (restartIce both ways in the same ms) | handled the same way, connections stayed up |
| D joins during 2 shares | D sees both screens (A and B renegotiated as *answerers*) |
| Stop share | tile disappears on others; no new RTCPeerConnection |
| ↻ ICE on one peer | only that pc restarted; others untouched |
| Backend restart | re-joined in 3.1 s, 0 pcs rebuilt, 0 duplicates; renegotiation works afterwards |
| Bitrate cap 150 kbps | every video sender `maxBitrate 150000`, per-peer upload ~180 kbps |
| Leave | others updated in 154 ms (`bye` over P2P) |
| Console errors | none |

## Quiz

1. A and B both click "Share screen" in the same millisecond. Walk through what each pc does with perfect negotiation if
   A is polite. Does B's screen still reach A, and how?
2. Why does this page compare **clientIds** for polite/impolite? Describe the deadlock that comparing socket ids could cause right after a reconnect.
3. The phone goes `disconnected`. Why wait 5 s before `restartIce()`, and what does `restartIce()` keep and throw away?
4. During a backend restart, A's ICE restart offer to B is sent while the socket is down. What state is A's pc in, and how does resync fix it?
5. With 5 people and 1.2 Mbps video, how much does each person upload in a mesh vs. with an SFU? Why does the
   encoder CPU differ even more than the bandwidth, and what does `qualityLimitationReason` show when it runs out?
