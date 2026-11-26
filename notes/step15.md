# Step 15: the SFU frontend (mediasoup-client), simulcast, and mesh vs SFU

Theory: `Webrtc.md` §16 (simulcast & SVC), §20.2 (SFU), §20.4 (comparison), §21 (stats).

Page: **`/sfu`** (nav: *Group SFU*). The mesh (`/group`) and 1:1 (`/room`) pages still work. You can open the
same people in both and compare.

## What I built

| File | Role |
| ---- | ---- |
| `frontend/src/hooks/useSfuRoom.js` | Device, send/recv transports (`connect` + `produce` events), produce mic + simulcast camera, consume existing + new producers, resume, producer-closed / paused / layers, rejoin after a reconnect, stats |
| `frontend/src/pages/GroupSfu.jsx` | Lobby → grid + controls + stats + participants + **Server** card (`/api/sfu`); tile size → simulcast layer; click a tile to pin it |
| `VideoGrid` / `ParticipantTile` / `VideoTile` | + spotlight (pinned tile via CSS `order`, no DOM moves), `onTileResize` (ResizeObserver), a badge per tile (layer + resolution) |
| `PeerStatsTable` | bitrate cap now optional; the SFU passes two rows: **send transport** and **recv transport** |
| `backend/mediasoup/sfuRoom.js` | + `setProducerPaused` (→ `producerpause`/`producerresume` on every consumer), `setPreferredLayers`, `preferredLayers` at consume time, `layerschange` → client, server in/out bitrate in stats |
| `backend/socket/sfuHandlers.js` | + `sfu:pauseProducer`, `sfu:resumeProducer`, `sfu:setPreferredLayers`; server → client `sfu:producer-paused/resumed`, `sfu:consumer-layers` |
| `backend/controllers/sfuController.js` | `/api/sfu` now has worker CPU % (delta between two calls) and per-room server bitrates |
| `App.jsx` | `/sfu` is **lazy-loaded**: mediasoup-client lives in its own 230 kB chunk (45 kB gzipped); other pages don't download it |

## 1. The client flow (`useSfuRoom`)

```js
const joined = await req('sfu:join', { roomId, name });          // → routerRtpCapabilities, peers, producers
const device = new Device();
await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });   // what can THIS browser do in THIS room?

const recv = device.createRecvTransport(await req('sfu:createTransport', { direction: 'recv' }));  // RTCPeerConnection #1
recv.on('connect', ({ dtlsParameters }, ok, fail) => req('sfu:connectTransport', { transportId: recv.id, dtlsParameters }).then(ok, fail));

const send = device.createSendTransport(await req('sfu:createTransport', { direction: 'send' }));  // RTCPeerConnection #2
send.on('connect', …same…);
send.on('produce', ({ kind, rtpParameters, appData }, ok, fail) =>          // fired by every send.produce()
  req('sfu:produce', { transportId: send.id, kind, rtpParameters, appData }).then(({ id }) => ok({ id }), fail));

await send.produce({ track: micTrack, stopTracks: false, zeroRtpOnPause: true });
await send.produce({ track: camTrack, stopTracks: false, zeroRtpOnPause: true, encodings: SIMULCAST_ENCODINGS, codec: vp8 });

for (const p of [...joined.producers, ...announcedMeanwhile]) consume(p);  // + socket.on('sfu:new-producer', consume)
// consume(): sfu:consume → recv.consume(params) → add track to the peer's MediaStream → sfu:resumeConsumer
```

Details that matter:
- **`connect` and `produce` are callbacks from mediasoup-client to *us*.** It needs the server's answer (`ok()`), so
  each handler forwards to the server and calls `ok` / `fail` with the ack. `connect` fires **once per transport**, on
  first use. `produce` fires for every `produce()`.
- **`stopTracks: false`**. mediasoup-client's default (`true`) would **stop the camera track** on `producer.close()`
  or `replaceTrack()`. Here the tracks belong to `useLocalMedia` (they also feed the local preview), so it must not touch them.
- **New producers announced before the recv transport exists** are queued and consumed once it's ready
  (`pendingProducers`). Otherwise someone who starts their camera while you're joining would be missed.
- **One `MediaStream` per remote peer**, created when they appear. Consumer tracks are added to it and removed from it.
  The `<video>`'s `srcObject` is set once per person (the step 12 rules still apply).
- **`doJoin` must not depend on React state.** First version: `doJoin` depended on `paused` → muting created a new
  `doJoin` → the socket effect re-ran → its cleanup **left the room**. Fixed with a `pausedRef`.

## 2. Mute and camera off: how the server tells everyone

```
 B clicks Mute
 │ producer.pause()          (mediasoup-client; zeroRtpOnPause → sender.replaceTrack(null): B uploads 0 kbps)
 │── sfu:pauseProducer {id} ──▶ server: producer.pause()
 │                               └─ mediasoup fires 'producerpause' on EVERY consumer of that producer
 │                                   ├─▶ notify(A, 'sfu:producer-paused', {consumerId, kind:'audio'}) → A's tile: 🔇
 │                                   ├─▶ notify(C, …)                                                → C's tile: 🔇
 │                                   └─▶ …
 │ D joins later → sfu:consume returns { producerPaused: true } → D shows 🔇 from the start
```

Compare with the mesh (step 12), where `track.enabled = false` kept sending black frames and silence, so we needed a
`media-state` message on every data channel, plus a resend when a channel opened. In the SFU:
- the **server knows** the producer is paused, so it notifies every consumer and tells newcomers (`producerPaused`). No app message needed;
- **nothing is uploaded or forwarded** while paused (tested: B's send transport went to **1 kbps**, RTCP only).

## 3. Switch camera

`media.switchDevice('video', id)` (new track in the local stream: the preview) → `producer.replaceTrack({ track })`.
**One** sender to update (the mesh had N−1). No renegotiation, and the SFU only sees new pixels. All three simulcast
encodings now come from the new camera. Tested: C switched twice and A kept receiving C.

## 4. Simulcast and layer selection

```js
export const SIMULCAST_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000,   scalabilityMode: 'L1T3' },  // L0  320×180
  { scaleResolutionDownBy: 2, maxBitrate: 500_000,   scalabilityMode: 'L1T3' },  // L1  640×360
  { scaleResolutionDownBy: 1, maxBitrate: 1_500_000, scalabilityMode: 'L1T3' },  // L2 1280×720
];
```

```
  A's browser ──▶ [L0 320×180] [L1 640×360] [L2 1280×720] ──▶ SFU ──▶ B: big tile (pinned)  → L2
  (encodes 3×,      ~150k        ~500k         ~1.5M                ──▶ C: 344 px tile       → L1
   1.31× the pixels of one 720p encode)                             ──▶ D: phone, 167 px     → L0
```

- **Tile size → layer** (`GroupSfu.jsx: layerForWidth`): real pixels = CSS width × devicePixelRatio. Pick the
  **smallest layer at least that wide**: ≤ 320 → L0, ≤ 640 → L1, else L2. Never upscale, never send more than the tile shows.
  A `ResizeObserver` on every tile reports widths, the hook deduplicates, and only changes go to the server:
  `sfu:setPreferredLayers { consumerId, spatialLayer }` → `consumer.setPreferredLayers()`.
- **Preferred ≠ current.** The SFU may forward a *lower* layer than you asked for: when the receiver's bandwidth
  estimate is too low, or the sender stopped sending the top layer (its own CPU/bandwidth). `consumer.on('layerschange')` →
  `sfu:consumer-layers` → the tile shows what's **actually** arriving, e.g. `L1 medium → wants L2 · 640×360@20`.
- New consumers start at the last layer chosen for that peer (`preferredLayers` in `sfu:consume`), so a small tile
  doesn't receive 720p first and then switch down.
- **Spotlight:** click a tile → pinned full width, the others become a strip. Done with CSS `order: -1` on the pinned tile,
  **not** by reordering React children, so no `<video>` is moved or re-attached.
- Chrome only sends as many simulcast layers as the camera resolution allows (720p → 3, 360p → 2). A phone camera
  at 640×480 may only produce 2.

**Tested (3 people, 1400 px window):** grid tiles 344 px → **L1 640×360**. Pin B → B's tile 696 px → **L2 1280×720**,
C's strip tile 168 px → **L0 320×180**. Phone (390 px wide, 167 px tiles) → **L0**. A muted peer's tile:
"video paused · nothing forwarded".

## 5. Stats: one send transport

`PeerStatsTable` gets two rows, because in the SFU there are only two `RTCPeerConnection`s:

```
↑ send transport  prflx ↔ host udp  2.0 ms  1.34 Mbps    6 kbps  640×360@19 + 1280×720@19 + 320×180@19
↓ recv transport  prflx ↔ host udp  0.0 ms     9 kbps  605 kbps  –         (receives 1280×720@20 + 320×180@20)
```

"Video encoders running: **3**" = the three simulcast encodings of ONE camera (in the mesh: one per peer). The
**Server** card (`/api/sfu`) shows the other side: the room's peers/producers/consumers, server in/out kbps, and worker CPU.

## 6. Reconnects: the server is now in the media path

Mesh (step 13): a backend restart doesn't interrupt calls, because media is peer-to-peer. SFU: a backend restart **kills the
workers** → every transport is gone → media stops. The client re-joins automatically (on `connect` and on `sfu:room-closed`):
teardown → `sfu:join` → new transports → produce → consume. **Tested: back in a call 2.2–2.8 s after `touch server.js`.**
The price of the SFU: it's a single point of failure, which is why production runs several (section 10).

## 7. The experiment: mesh vs SFU, 2 → 6 participants

Same machine (12 cores), same headless Chrome, fake 720p camera, every participant a tab on this laptop. Measured on
tab A after 20 s at each N. CPU from `/proc` over 5 s (100 % = one core). The browser number is **all tabs together**.

| N | | **A upload** | **A download** | **A sends** | **A receives (quality)** | Limited by | **All tabs CPU** | **Server CPU** (workers) | **Server in / out** |
|---|---|---|---|---|---|---|---|---|---|
| 2 | mesh | 597 kbps | 598 kbps | 1× 720p @21 | 720p @20 | none | 73 % | – (signaling) | – |
| 2 | SFU | 1.39 Mbps | 429 kbps | 3 layers (180/360/720p) @20 | 360p @20 | none | 100 % | 3 % | 2.7 / 0.9 Mbps |
| 3 | mesh | 1.32 Mbps | 1.31 Mbps | 2× 720p @21 | 720p @20 | none | 283 % | – | – |
| 3 | SFU | 1.36 Mbps | 797 kbps | 3 layers @20 | 360p @20 | none | 182 % | 4 % | 4.1 / 2.4 Mbps |
| 4 | mesh | 925 kbps | 980 kbps | 3× 720/540p @**7–10** | 720p @**9–10** | bandwidth | **1060 %** | – | – |
| 4 | SFU | 1.36 Mbps | 1.30 Mbps | 3 layers @20 | 360p @20 | none | 308 % | 7 % | 5.6 / 5.4 Mbps |
| 5 | mesh | 727 kbps | 745 kbps | 4× 540p @**5–6** | 540p @**2–6** | **cpu**, bandwidth | 1108 % | – | – |
| 5 | SFU | 1.35 Mbps | 793 kbps | 3 layers @20 | 180p @20 (tiles 3 per row) | none | 414 % | 8 % | 6.9 / 4.3 Mbps |
| 6 | mesh | 908 kbps | 910 kbps | 5× 360–540p @**4–8** | 360–540p @**4–8** | **cpu**, bandwidth | 1093 % | – | – |
| 6 | SFU | 1.34 Mbps | 952 kbps | 3 layers @20 | 180p @20 | none | 623 % | **10 %** | 8.0 / 6.7 Mbps |

### What the numbers say

**Upload.** Mesh: ×N−1 until the machine gives out (597 kbps → 1.32 Mbps from 2 to 3 people). From 4 on, upload
*falls*, because the encoders can't produce frames anymore. **SFU: flat at ~1.35 Mbps from 2 to 6.** You send one
camera (as 3 layers) whoever is listening. That's the whole point.

**Download.** Both are "N−1 streams", but the SFU sends each receiver the **layer its tile needs**. At N=5–6 the
tiles are 3 per row → L0 → download *drops* (1.30 → 0.79 Mbps) while N grows. A mesh sender can't do that per receiver.

**CPU / quality.** Mesh: N tabs × (N−1) encodes = 2, 6, 12, 20, 30 encoders on one laptop. At N=4 the laptop is
saturated (1060 % of 1200 %), and frame rate collapses to 2–10 fps with `qualityLimitationReason: cpu`. SFU: N tabs × 3
small encodes. At N=6 the browsers use 623 % and **every stream still runs at 20 fps, limited by nothing**.

**The cost of simulcast at small N.** At N=2 the SFU uses *more* (100 % vs 73 % CPU, 1.39 vs 0.6 Mbps up): three
encodes and three uploads where P2P needed one. For 2 people, P2P is cheaper (step 10 was right for 1:1).

**A's "encode CPU" rises with N in the SFU (38 % → 128 %) although A always encodes the same 3 layers.**
`totalEncodeTime` is wall-clock time. When 6 tabs fight over the cores, each encode takes longer. In a real call
everyone has their own machine, and the per-person cost would stay flat.

**Server load.** The SFU forwards without decoding: 6 people, 8 Mbps in, 6.7 Mbps out, **10 % of one core**. Out
would be N×(N−1) × 1.5 Mbps = 45 Mbps if everyone received 720p of everyone. Layer selection keeps it at 6.7. Rule of
thumb: an SFU is **bandwidth-bound, not CPU-bound**. Pay attention to the egress price on AWS.

| | Mesh | SFU |
|---|---|---|
| Per-person upload | (N−1) × stream | 1 stream (+30 % for simulcast) |
| Per-person download | N−1 full streams | N−1 streams, each at the layer the tile needs |
| Per-person CPU | N−1 encodes + N−1 decodes | 1 (×3 small) encode + N−1 decodes |
| Quality as N grows | collapses at N≈4 (this laptop) | stable to 6 (and far beyond) |
| Server | signaling only, ~0 | forwards everything: bandwidth N×(N−1), little CPU |
| Latency | lowest (direct) | +1 hop (a few ms on a LAN) |
| E2EE | built in (DTLS-SRTP end to end) | needs Insertable Streams / SFrame |
| Failure | P2P survives a backend restart | backend restart = 2–3 s interruption |

**Conclusion:** P2P for 1:1. Mesh only for 3–4 people with data or audio. **SFU for any group video call**, and
mandatory once phones are involved or N > 4.

## 8. Deploying on AWS EC2

```
                       ┌──────────────────────── EC2 (c6i/c7i.large+, Elastic IP 3.110.20.30) ────────────────────────┐
 browser ── HTTPS 443 ─▶ nginx (Let's Encrypt cert)                                                                   │
                       │   ├── /            → frontend/dist (static files from `vite build`)                           │
                       │   ├── /api         → http://127.0.0.1:4000                                                    │
                       │   └── /socket.io   → http://127.0.0.1:4000  (WebSocket upgrade)                               │
 browser ── UDP/TCP 40000–40100 ─▶ mediasoup-workers (announcedAddress = 3.110.20.30)                                │
 browser ── 3478 UDP/TCP, 5349 TLS ─▶ coturn (TURN), relays 49152–65535 UDP                                         │
                       └───────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Instance**: compute-optimized (c6i/c7i) with enough **network bandwidth**. Node 20 + build-essential + python3-venv
   (the worker compiles, see step 14; a 1 GB instance needs swap for the build). Attach an **Elastic IP**.
2. **Backend `.env`**: `MEDIASOUP_LISTEN_IP=0.0.0.0`, `MEDIASOUP_ANNOUNCED_IP=<Elastic IP>` (**not** the private
   172.31.x.x: the instance only sees its private IP, AWS NATs the public one onto it), `CLIENT_ORIGIN=https://call.example.com`,
   `NODE_ENV=production`. Run it with **systemd** or **pm2**, and restart it on failure.
3. **Security group**: TCP 22 (your IP only), **TCP 80 + 443** (web + Let's Encrypt), **UDP + TCP 40000–40100**
   (mediasoup), **UDP/TCP 3478 + TCP 5349** and **UDP 49152–65535** (coturn). Forget the UDP range and ICE times out after 30 s with no error.
4. **HTTPS**: Vite's dev server and mkcert certs are dev-only. `npm run build` → nginx serves `frontend/dist`;
   `sudo certbot --nginx -d call.example.com` gets and renews a Let's Encrypt cert. getUserMedia needs a secure context, so HTTPS is mandatory.
   ```nginx
   location /socket.io/ {
     proxy_pass http://127.0.0.1:4000;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;      # WebSocket upgrade, like ws:true in vite.config.js
     proxy_set_header Connection "upgrade";
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   }
   location /api/ { proxy_pass http://127.0.0.1:4000; }
   location / { root /srv/webrtc/frontend/dist; try_files $uri /index.html; }   # SPA fallback for /sfu, /group…
   ```
5. **TURN (coturn)**: mediasoup has a public IP, but some *clients* can't reach UDP or high TCP ports (corporate
   firewalls, some hotel Wi-Fi). They need TURN, ideally over **TLS on 443** (which looks like HTTPS); that needs a
   second IP or a separate small instance, because nginx already owns 443 here. The mesh and 1:1 pages need TURN even more
   (P2P through symmetric NAT, step 10).
   - `/etc/turnserver.conf`: `listening-port=3478`, `tls-listening-port=5349`, `external-ip=<Elastic IP>/<private IP>`,
     `use-auth-secret`, `static-auth-secret=<long random>`, `realm=call.example.com`, cert paths, `no-cli`, and
     `denied-peer-ip` for private ranges (otherwise people can use your TURN server to reach your VPC).
   - **Short-lived credentials** (TURN REST API): the backend hands out `username = <expiry timestamp>:<userId>`,
     `credential = base64(HMAC-SHA1(secret, username))`. Never put a static TURN password in the frontend.
   - Pass them to the client: `new RTCPeerConnection({ iceServers })` in the mesh, and
     `device.createSendTransport({ ...params, iceServers })` / `createRecvTransport` in the SFU.
     Test with `iceTransportPolicy: 'relay'`: the stats `Path` column must show `relay`.

## 9. What production would still need

| Area | What's missing here | How |
| ---- | ------------------- | --- |
| **Authentication** | anyone can join any room with any name | login → JWT; verify it in Socket.IO's handshake middleware (`io.use`); name comes from the token |
| **Authorization** | everyone can produce and consume everything | room membership + roles (host, speaker, viewer); check in `sfu:join` / `sfu:produce` / `sfu:consume`; host can mute/kick (server-side `producer.pause/close`) |
| **Limits** | only max peers per room | rate-limit signaling per socket, max producers per peer, `maxIncomingBitrate` per plan, max rooms per worker (CPU/bandwidth based), room TTL |
| **Recording** | none | mediasoup `PlainTransport` + `consume()` → **FFmpeg/GStreamer** (RTP in, MP4/WebM out), or a headless browser that "joins" and records the composed grid; upload to S3; consent UI |
| **E2EE** | the SFU decrypts SRTP (it has to, to rewrite headers), so it *could* see media | **Insertable Streams / Encoded Transform** (`RTCRtpScriptTransform`): encrypt each encoded frame (SFrame) in the browser before SRTP, decrypt after. The SFU forwards frames it can't read. Simulcast still works (layers are separate encodings). Needs key distribution/rotation (e.g. MLS) |
| **Multiple servers** | one process, rooms pinned to one worker | many SFU hosts; assign rooms to hosts (by load/region); Redis for room state + the Socket.IO Redis adapter for signaling across Node processes; `pipeToRouter` to spread big rooms over workers/hosts; **cascading** SFUs across regions; health checks + draining before deploys |
| **Resilience** | rejoin on reconnect | transport ICE restart (`transport.restartIce()` server + client) for network changes without a full rejoin; graceful shutdown |
| **Quality** | client-side speaker detection | `ActiveSpeakerObserver` / `AudioLevelObserver` on the server; pause consumers of off-screen tiles; VP9 **SVC** / AV1; dynacast (stop encoding layers nobody consumes) |
| **Observability** | `/api/sfu` | Prometheus metrics (per worker CPU, bitrates, scores, packet loss), call-quality logging, alerts |
| **Privacy** | logs contain names | no PII or SDP in logs, retention policy, GDPR for recordings |

## 10. mediasoup vs LiveKit, honestly

| | **mediasoup** (what we built on) | **LiveKit** |
|---|---|---|
| What it is | a **library**: C++ media engine + Node (or Rust) API | a **product**: a Go SFU server with signaling, rooms, auth, SDKs, plus a managed cloud |
| Signaling | **you** write it (steps 14–15: ~600 lines) | built in (WebSocket/protobuf), token-based auth |
| Client SDK | mediasoup-client: transports/producers/consumers, you build the room logic | `livekit-client` + React components: `room.connect(url, token)` and you're in a call |
| Simulcast / layer selection | you pick encodings and call `setPreferredLayers` (section 4) | automatic: adaptive stream (tile size) + dynacast out of the box |
| Scaling | you design it: workers, routers, `pipeToRouter`, multi-host, Redis | built-in multi-node with Redis, region routing, cascading in the cloud |
| TURN | bring coturn | embedded TURN (TLS/443) |
| Recording, streaming | build it (PlainTransport + FFmpeg) | **Egress** service (record/stream composite or tracks), **Ingress** (RTMP/WHIP in) |
| Extras | | agents framework (AI voice), SIP, E2EE option, webhooks, analytics in the cloud |
| Control | **total**: every packet path, custom topologies, custom auth, embed in your Node app | high, but within LiveKit's model and protocol |
| Learning value | very high: you see every concept (this course) | you learn LiveKit's API more than WebRTC |
| Ops burden | high: you own signaling bugs, reconnection, scaling, upgrades | self-host: one Go binary + Redis (moderate); cloud: none, pay per minute |
| Cost | servers + bandwidth only | self-host: same; cloud: per participant-minute (cheap to start, expensive at scale) |
| License | ISC | Apache 2.0 (server and SDKs) |

**Recommendation:** for *learning*, and for products that need unusual media routing or must embed media in an
existing Node backend, **mediasoup** is excellent. You now understand every piece. For *shipping* a standard video
product with a small team, **LiveKit** gets you reconnection, adaptive streaming, recording, scaling and mobile SDKs that
would take months to build and harden on mediasoup. Start on LiveKit Cloud, self-host when the bill justifies it. The
concepts from steps 1–15 (ICE, DTLS, simulcast, layers, stats) are exactly what you'll debug with on either.

## Testing

Automated (headless Chrome, fake devices: 2 fake cameras, one tab with an Android user agent and a 390 px viewport) against the running dev servers:

| Check | Result |
| ----- | ------ |
| A, B, C join | each: 3 tiles playing, send + recv transports `connected`; server 3 peers · 6 transports · 6 producers · 12 consumers |
| Simulcast | A sends 320×180 + 640×360 + 1280×720 @ 19–20 fps (1.34 Mbps total) |
| Layer by tile | 344 px → L1 640×360; pin B (696 px) → L2 1280×720; strip (168 px) → L0 320×180; phone (167 px) → L0 |
| Mute + camera off | others show 🔇 + camera off; B uploads 1 kbps; phone joining later sees it (`producerPaused`) |
| Switch camera | 2 × `producer.replaceTrack`, A still receives C |
| Leave / tab close | tiles removed; server counts drop (3 → 2 peers, 12 → 4 consumers) |
| Backend restart | both tabs back in a call after 2.2–2.8 s (automatic rejoin) |
| Mesh still works | the mesh experiment above ran on `/group` |
| Console errors | none |

**By hand:** open `https://<LAN-IP>:5173/sfu?room=sfu-room` in 2–3 laptop tabs and on the phone. Watch:
- the tile badges change when you pin someone or rotate the phone;
- the Server card's numbers grow by N×(N−1) while your upload stays flat;
- muting on the phone shows 🔇 everywhere without any data channel;
- with the phone on mobile data the SFU often works where the mesh didn't. The server has a reachable IP on your LAN,
  but over the internet it needs the EC2 setup above.

## Quiz: steps 11–15

1. **(11)** In a mesh room, C joins A and B. Who sends offers to whom, and why can't two offers for the same pair cross
   as long as there's one signaling server? What does `group:signal` need that step 8's `signal` didn't?
2. **(11)** Write the number of RTCPeerConnections in a 5-person room for the whole room and for one browser, in a mesh and with an SFU.
3. **(12)** Why can one `MediaStreamTrack` be added to 5 RTCPeerConnections, yet the CPU cost grows with each one?
4. **(12)** Name three things in the grid that keep a `<video>` from flickering or re-attaching when people join, leave, or start speaking.
5. **(13)** Explain perfect negotiation in one paragraph: who is polite, what happens on a collision for each side, and
   why this project compares clientIds instead of socket ids.
6. **(13)** `connectionState` goes `disconnected`. Why wait before `restartIce()`, and what does an ICE restart keep and replace?
7. **(14)** What are the Worker, Router, WebRtcTransport, Producer and Consumer, and which one is a separate OS process?
8. **(14)** Why does every consumer start paused, and why does `announcedIp` have to be the Elastic IP on EC2?
9. **(15)** B mutes in the SFU. Trace what happens in B's browser, on the server, and in A's and late-joiner D's
   browsers. Why is no data channel message needed, unlike the mesh?
10. **(15)** With simulcast, A's tile for B is 300 CSS px wide on a phone with devicePixelRatio 3. Which layer does
    `layerForWidth` pick, what does the tile badge show if the phone's bandwidth only allows L0, and why does A's upload
    in the experiment stay at ~1.35 Mbps from N=2 to N=6?
