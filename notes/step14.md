# Step 14: from mesh to SFU with mediasoup (backend)

Theory: `Webrtc.md` §16 (simulcast & SVC), §20.2 (SFU), §24 (ecosystem: mediasoup).

This step is **backend + theory**. The browser side (mediasoup-client in React) is next. The backend was still tested
end to end with real browsers through a small throwaway client (see "Testing").

## 1. Why an SFU

Step 13 measured the mesh hitting the wall: every person encodes and uploads their camera **N−1 times**.

```
MESH (step 11–13), N = 4                      SFU (step 14), N = 4

   A ═══════ B                                 A ──▶┐        ┌──▶ A gets B, C, D
   ║ ╲     ╱ ║                                 B ──▶┤  SFU   ├──▶ B gets A, C, D
   ║   ╲ ╱   ║      6 connections              C ──▶┤(server)├──▶ C gets A, B, D
   ║   ╱ ╲   ║      each person: 3 up, 3 down  D ──▶┘        └──▶ D gets A, B, C
   D ═══════ C      3 ENCODES each
                                               each person: 1 up, 3 down, 1 ENCODE
```

The **Selective Forwarding Unit** receives one stream from each person and **forwards** the RTP packets to everyone
else. It never decodes or re-encodes video (that would be an MCU, §20.3), so it's cheap: per packet it decrypts
(SRTP), rewrites a few header fields (SSRC, sequence numbers, timestamps), re-encrypts for each receiver, and sends.

| per person, N people | Mesh | SFU |
| -------------------- | ---- | --- |
| Uploads | N−1 | **1** (or 2–3 simulcast layers) |
| Encodes | N−1 | **1** |
| Downloads / decodes | N−1 | N−1 (the SFU can choose a lower layer per receiver) |
| Connections (RTCPeerConnections) | N−1 | **2** (send + recv), whatever N is |
| Server cost | signaling only | bandwidth: N in, N×(N−1) out; little CPU |

"Selective": the server decides **what** each receiver gets: only some people's video, a lower simulcast
layer for a phone (§16), nothing for a tile that's off-screen. A mesh sender can't do that per receiver without encoding again.

## 2. mediasoup building blocks

```
Node.js process (our backend)                     ┌───────────── mediasoup-worker (C++) ── 1 per CPU core ─────────────┐
                                                  │                                                                    │
 Socket.IO handlers ──── mediasoup API ─────────▶ │  Router  "room-42"   (mediaCodecs: opus, VP8, VP9, H264)          │
 (signaling, rooms)      (JS objects that         │   │                                                                │
                          mirror the C++ ones)    │   ├── WebRtcTransport  A:send ◀── RTP ── browser A                  │
                                                  │   │      └── Producer  A camera (VP8) ─────┐                        │
                                                  │   │      └── Producer  A mic (opus) ───┐   │                        │
                                                  │   ├── WebRtcTransport  A:recv           │   │                        │
                                                  │   │      └── Consumer  of B camera      │   │                        │
                                                  │   ├── WebRtcTransport  B:send           │   │                        │
                                                  │   │      └── Producer  B camera         │   │                        │
                                                  │   └── WebRtcTransport  B:recv ── RTP ──▶ browser B                  │
                                                  │          ├── Consumer of A camera ◀─────┼───┘  (the router copies    │
                                                  │          └── Consumer of A mic ◀────────┘       packets producer →   │
                                                  │                                                  its consumers)      │
                                                  └────────────────────────────────────────────────────────────────────┘
```

| Object | What it is | Here |
| ------ | ---------- | ---- |
| **Worker** | A separate **C++ process** (`mediasoup-worker`). It does all the media work: ICE, DTLS, SRTP, RTP/RTCP, bandwidth estimation, forwarding. Single-threaded, so ~1 core each. | `mediasoup/workers.js`: one per core (12 here), restarted on `died` |
| **Router** | A "room" inside a worker. Holds the room's **codecs** (`mediaCodecs`) and moves RTP from producers to consumers. Media only flows between transports of the **same** router. | `SfuRoom.router`, one per room |
| **WebRtcTransport** | The server end of one browser connection: its own ICE (lite), DTLS, SRTP. mediasoup-client creates **one for sending and one for receiving** per user. | `peer.transports` (`send`, `recv`) |
| **Producer** | One track a client **sends** to the router (on its send transport). | `peer.producers`: mic, camera (later screen) |
| **Consumer** | One track a client **receives**: "producer X, forwarded to me" (on its recv transport). One per (receiver, producer) pair. | `peer.consumers` |
| **rtpCapabilities** | *Router's*: which codecs/header extensions this room uses. *Device's*: which of those this browser can **receive**. `router.canConsume()` checks the producer's codec against the receiver's. | returned by `sfu:join`, sent with `sfu:consume` |
| **rtpParameters** | The **exact** encoding of one stream: codec + payload type, SSRC(s), RTX, header extensions, simulcast encodings. A producer's say what the browser sends; a consumer's say what the browser will receive. | `sfu:produce` in, `sfu:consume` out |
| **ICE parameters / candidates** | The server's ufrag/password and its address:port (`announcedIp:4001x`, UDP + TCP). | `sfu:createTransport` |
| **DTLS parameters** | Role (client/server) + **certificate fingerprints**. The server sends its own on createTransport; the browser sends its own on connect. Each side verifies the other's certificate in the DTLS handshake. | `sfu:createTransport` / `sfu:connectTransport` |

**Why separate send and receive transports?** A send transport only has `sendonly` m-sections (one per producer),
a recv transport only `recvonly` ones. Adding a consumer (someone new arrives) renegotiates **only** the recv
connection, adding a producer only the send one. They never interfere, so there's no glare between them.
And in the browser that's exactly **2 RTCPeerConnections** total, for 2 people or 50.

**Why one Router per room, and all of a room on one worker?** A router can only forward between its own transports.
So a room is limited to roughly one core (plenty for dozens of people). Bigger rooms span workers with
`router.pipeToRouter()`, out of scope here.

## 3. What changes compared with step 10

| | Step 10 (P2P) | Step 14 (SFU) |
| - | ------------- | ------------- |
| The other end of my `RTCPeerConnection` | the other **user's browser** | the **server** (a mediasoup WebRtcTransport) |
| How many pcs | 1 per other user | 2 (send + recv) |
| Who writes the SDP | each browser: `createOffer` / `createAnswer` | **mediasoup-client, locally**, from JSON parameters the server gives it |
| What travels over signaling | SDP offer/answer + ICE candidates (opaque, relayed) | **JSON**: rtpCapabilities, transport params (ICE + DTLS), rtpParameters, ids |
| Server's role in signaling | dumb relay ("text in, text out") | **the other party**: it creates transports, producers, consumers |
| ICE | full ICE on both sides, STUN for srflx, trickle candidates | **ICE-lite** server: fixed candidates (announcedIp), no STUN, no trickle; the browser connects to it |
| Where media goes | browser ↔ browser | browser → server → browsers |
| E2E encryption | yes (DTLS-SRTP between the two users) | hop by hop: the SFU decrypts SRTP. True E2EE needs Insertable Streams / SFrame (§12.4) |

How mediasoup-client builds the SDP: `device.createRecvTransport({ id, iceParameters, iceCandidates, dtlsParameters })` creates an
`RTCPeerConnection`. On `transport.consume({ rtpParameters, … })` it **writes a remote SDP itself** (an "offer from the
server" containing the server's ICE ufrag, candidates, fingerprint, and an m-section with the consumer's codec/SSRC),
calls `pc.setRemoteDescription()` with it, then `createAnswer()` / `setLocalDescription()`. The browser's answer
**never leaves the browser**. mediasoup-client extracts the DTLS fingerprint from it and fires `transport.on('connect')`,
and we send just `dtlsParameters` to the server. The send side mirrors this: the client creates the offer, extracts
`rtpParameters` for `sfu:produce`, and fakes the server's answer locally. SDP is now an internal detail of the browser
API, and the protocol on the wire is mediasoup's JSON.

## 4. Setup: installing mediasoup on Ubuntu

```bash
sudo apt update
sudo apt install -y build-essential python3 python3-pip python3-venv   # make + g++ + Python for the worker build
cd backend && npm install mediasoup@3
```

- mediasoup = a Node package **plus a C++ program** (`mediasoup-worker`). On install it first tries to **download a
  prebuilt worker** for your OS/arch. If none fits (or GitHub isn't reachable) it **compiles from source**: Python
  installs `meson` + `ninja` into a private venv, then g++ builds the worker and its dependencies (OpenSSL, libuv, libsrtp…).
- On this machine (Ubuntu 24.04, Node 20, g++ 13.3, Python 3.12, 12 cores) it **compiled from source**:
  **5 min 41 s** wall clock, ~24 min CPU. Result: `node_modules/mediasoup/worker/out/Release/mediasoup-worker`.
- Requirements: Node ≥ 18, Python ≥ 3.7 **with pip and venv**, GNU make, a C++17 compiler (g++ ≥ 8 / clang).

**If the install fails:**
1. Read the real error: `npm install mediasoup@3 --foreground-scripts` shows the build output.
2. `ensurepip is not available` / `No module named venv` → `sudo apt install python3-venv python3-pip`.
3. `make: not found`, `g++: not found`, missing headers → `sudo apt install build-essential`.
4. Killed / `c++: fatal error: Killed signal` → out of memory (classic on a 1 GB EC2 t2/t3.micro). Add swap
   (`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`), or build
   on a bigger machine and point `MEDIASOUP_WORKER_BIN=/path/to/mediasoup-worker` at the binary.
5. Clean retry: `rm -rf node_modules/mediasoup && npm install`. After a Node major upgrade: `npm rebuild mediasoup`.

**Firewall:** if `sudo ufw status` says active, open the media ports (otherwise ICE silently times out):
`sudo ufw allow 40000:40100/udp && sudo ufw allow 40000:40100/tcp`.

## 5. Configuration: `mediasoup/config.js` + `.env`

| Setting | Value | Why |
| ------- | ----- | --- |
| `mediaCodecs` | Opus 48 kHz stereo; VP8; VP9 (profile 0); H264 (packetization-mode 1, profile-level-id 42e01f) | The router's codecs. The SFU never transcodes: a VP8 producer can only go to receivers that decode VP8. H264 Constrained Baseline is what iOS/Safari hardware does. |
| ports | `MEDIASOUP_RTC_MIN_PORT=40000`, `MAX=40100` | Each transport takes one port per protocol. UDP + TCP × (send + recv) = **4 ports per user** → ~25 users on 101 ports. Fine for dev. In production use a `WebRtcServer` (one port per worker) to open fewer ports. |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | Bind on every interface. |
| `MEDIASOUP_ANNOUNCED_IP` | your LAN IP (auto-detected if empty: 192.168.0.115 here) | See below. |
| `MEDIASOUP_WORKERS` | default = CPU cores (12 here, ~18 MB RSS each) | Set to 2 in dev if you like. |
| `maxIncomingBitrate` | 3 Mbps per send transport | Caps what one user may push to the server. |

### Why `announcedIp` matters

mediasoup is **ICE-lite**: it doesn't discover its own addresses (no STUN). It just tells the browser "send to
*X*:port" in its ICE candidates and answers connectivity checks there. *X* is the announced address, and it must be
reachable **from the browser**:

```
listenIp 0.0.0.0  →  binds UDP 40012 on wlo1 (192.168.0.115), docker0, virbr0, …
announcedIp       →  candidate sent to the browser: "udp 192.168.0.115 40012"    ← the phone on Wi-Fi can reach this
```

- Announce `127.0.0.1` → it works on the laptop, but the **phone** tries to reach *itself* → ICE fails.
- You can't announce `0.0.0.0`: it isn't an address anyone can send to.

**On EC2 later:** the instance's network interface only has a **private** IP (e.g. 172.31.5.10). AWS translates the
public / Elastic IP to it (1:1 NAT), so the machine never "sees" its public address:

- `MEDIASOUP_LISTEN_IP=0.0.0.0` (or the private IP), `MEDIASOUP_ANNOUNCED_IP=<Elastic IP>` (use an Elastic IP; a plain
  public IP changes on stop/start).
- Security group: **UDP and TCP 40000–40100** from 0.0.0.0/0, plus 443 for the web app/signaling.
- Announce the private IP by mistake → every client gets an unreachable candidate → `connecting` → `failed` after ~30 s, and
  no error appears anywhere. The #1 mediasoup deployment bug.
- Clients behind firewalls that block UDP *and* the high TCP ports still need **TURN** (TCP/TLS on 443).

## 6. Workers: `mediasoup/workers.js`

- `startWorkers()` at boot creates one worker per core (`os.availableParallelism()`). If mediasoup fails to start, the
  backend still runs (1:1 and mesh pages don't need it) and `sfu:join` answers "SFU not available".
- New rooms are assigned **round-robin** to live workers.
- `worker.on('died')`: logged, and a replacement starts in the same slot after 2 s. Every router on the dead worker
  fires `workerclose` → its `SfuRoom` closes and sends `sfu:room-closed` to its peers (they must re-join). Other workers' rooms are unaffected.
- `GET /api/sfu`: workers (pid, CPU ms, memory) and rooms (peers / transports / producers / consumers).

## 7. Rooms: `mediasoup/sfuRoom.js`

`SfuRoom` = router + `peers: Map(socketId → { transports, producers, consumers })` + a room-wide `producers` index.
It knows nothing about Socket.IO: it reports through `notify(peerId, event, data)` and emits `close`.

**Cleanup follows ownership:**

```
peer leaves / disconnects
 └─ close its transports
     ├─ its producers close ──▶ every consumer of them (in OTHER peers) closes and fires 'producerclose'
     │                           └─▶ notify that peer: sfu:producer-closed → client closes the track, removes the tile
     └─ its consumers close
 └─ room empty? → router.close() (releases everything in the worker), room removed
worker dies → router 'workerclose' → room.close() → sfu:room-closed to everyone in it
```

Tested: after C closed its tab the server went from 4 peers / 7 transports / 5 producers / 15 consumers to **3 / 5 / 3 / 6**,
and A got `sfu:peer-left C`, then `producer-closed` for C's audio and video within 5 ms.

## 8. Signaling: `socket/sfuHandlers.js`

Request/response with **Socket.IO acknowledgements** (`socket.emitWithAck(event, data)` → `{ ok, …data }` or `{ ok:false, error }`),
because mediasoup-client's flow is "ask the server for X, wait for X". Every error comes back as `{ ok:false, error }`.

| Client → server | Data | Reply |
| --------------- | ---- | ----- |
| `sfu:join` | `{ roomId, name }` | `{ routerRtpCapabilities, peers, producers }` |
| `sfu:createTransport` | `{ direction: 'send' \| 'recv' }` | `{ id, iceParameters, iceCandidates, dtlsParameters }` |
| `sfu:connectTransport` | `{ transportId, dtlsParameters }` | `{}` |
| `sfu:produce` | `{ transportId, kind, rtpParameters, appData:{source} }` | `{ id }`, + broadcast `sfu:new-producer` |
| `sfu:consume` | `{ transportId, producerId, rtpCapabilities }` | `{ id, producerId, kind, rtpParameters, type, producerPaused }` (**paused**) |
| `sfu:resumeConsumer` | `{ consumerId }` | `{}` |
| `sfu:closeProducer` | `{ producerId }` | `{}` (e.g. stop screen share) |
| `sfu:leave` | | `{}` |

Server → client: `sfu:peer-joined`, `sfu:peer-left`, `sfu:new-producer { producerId, peerId, name, kind, source }`,
`sfu:producer-closed { consumerId, producerId, peerId }`, `sfu:room-closed { reason }`.

## 9. The full sequence: "C joins" → "C sees A's video" (and A sees C's)

Timings from the test log (C joined a room where A and B were already sending):

```
 C (browser, mediasoup-client)                 Server (Node + mediasoup)                    A (already in the room)
 │                                              │                                             │
 │── sfu:join {room, name} ───────────────────▶ │ getOrCreateRoom → router (worker #0)        │
 │◀─ ack {routerRtpCapabilities, peers:[A,B],   │ room.addPeer(C)                              │
 │        producers:[A cam, A mic, B cam, B mic]}│── sfu:peer-joined ─────────────────────────▶│   34 ms
 │ device.load(routerRtpCapabilities)            │                                             │
 │   → device.rtpCapabilities (what C decodes)   │                                             │   73 ms
 │                                              │                                             │
 │── sfu:createTransport {recv} ──────────────▶ │ router.createWebRtcTransport()               │
 │◀─ ack {id, iceParameters, iceCandidates:     │   (binds UDP 40012 + TCP 40001)              │
 │        udp 192.168.0.115:40012, tcp …:40001,  │                                             │   78 ms
 │        dtlsParameters (server fingerprint)}   │                                             │
 │ device.createRecvTransport(...) → RTCPeerConnection #1 (no SDP exchanged yet)              │
 │── sfu:createTransport {send} ──────────────▶ │ another WebRtcTransport                      │   86 ms
 │ device.createSendTransport(...) → RTCPeerConnection #2                                     │
 │                                              │                                             │
 │ sendTransport.produce({track: camera})        │                                             │
 │   (local offer; first use → 'connect' event)  │                                             │
 │── sfu:connectTransport {send, dtlsParams} ─▶ │ transport.connect(): now knows C's cert      │  115 ms
 │── sfu:produce {kind:video, rtpParameters} ─▶ │ transport.produce() → Producer C-cam (VP8)   │  132 ms
 │◀─ ack {id}                                   │── sfu:new-producer {C cam} ────────────────▶│
 │═══ ICE checks → DTLS handshake → SRTP ═════▶ │ send transport "connected"                   │  136 ms
 │═══ C's camera RTP ════════════════════════▶ │                                             │
 │── sfu:produce {audio} ──────────────────────▶ │ Producer C-mic ── sfu:new-producer ───────▶│  155 ms
 │                                              │                                             │
 │ for each existing producer (A cam, A mic, B …):                                            │
 │── sfu:consume {recv, A-cam, rtpCapabilities}▶│ router.canConsume? → transport.consume(     │
 │                                              │   {paused: true}) → Consumer (paused)        │
 │◀─ ack {id, kind, rtpParameters (SSRC, VP8)}  │                                             │  195 ms
 │ recvTransport.consume(...) → builds the       │                                             │
 │   remote SDP, setRemoteDescription, answer;   │                                             │
 │   first use → 'connect':                      │                                             │
 │── sfu:connectTransport {recv, dtlsParams} ─▶ │                                             │  185 ms
 │── sfu:resumeConsumer {id} ─────────────────▶ │ consumer.resume() → asks A's producer        │  212 ms
 │                                              │   for a KEYFRAME, starts forwarding          │
 │◀══ ICE/DTLS on the recv transport ═══════════ │ recv transport "connected"                   │  222 ms
 │◀══ A's camera RTP (forwarded, not decoded) ══ │◀═══════ A's camera RTP (A uploads ONCE) ═════│
 │ track → <video> → A's video plays ▶           │                                             │
 │                                              │                                             │
 │                       meanwhile A, on sfu:new-producer {C cam}:                             │
 │                                              │◀─ sfu:consume {A recv, C-cam} ──────────────│ 2599 ms (A's clock)
 │                                              │── ack (paused consumer) ────────────────────▶│
 │                                              │◀─ sfu:resumeConsumer ───────────────────────│ 2609 ms
 │═══ C's camera RTP ════════════════════════▶ │═══ forwarded to A ═════════════════════════▶│   A sees C ▶
```

From `sfu:join` to C's first forwarded packet: **~220 ms**. Three people in the test: each **sends 1 outbound video
stream** and receives 2. The server held exactly 3 peers, 6 transports, 6 producers, **12 consumers** (= 3 × 2 × 2 tracks).

## 10. Why consumers start paused, then get resumed

`transport.consume({ paused: true })` creates the consumer but forwards **nothing** yet. The client resumes it only
after it has set it up locally (`recvTransport.consume()` resolved, track attached):

1. **Ordering.** Without the pause, the server forwards RTP the moment `sfu:consume` returns, while the ack is still
   travelling and the browser hasn't applied the SDP with that SSRC yet. Those first packets arrive for an unknown
   stream and are **dropped**, including the keyframe the decoder needs. Result: a black tile until the next keyframe,
   which can be several seconds away.
2. **A keyframe on resume.** Resuming a video consumer makes mediasoup ask the producer for a fresh keyframe (PLI/FIR),
   so the new receiver can start decoding immediately instead of waiting for the next periodic one.
3. **Don't pay for what nobody shows.** The same mechanism later lets the UI pause consumers for off-screen tiles or
   minimized windows (no bandwidth, no decoding), and resume when visible.

**Measured** (D consumed A, B and C without resuming): after 2.5 s, **0 bytes / 0 frames** for all three. 2.5 s after
`sfu:resumeConsumer`: ~200 KB and 50 decoded frames each.

## 11. Where simulcast (§16) fits next

With one stream per sender, the SFU can only forward that one quality to everyone. With **simulcast** the browser
sends 3 encodings (e.g. 180p/360p/720p, each with its own RID). The producer's `rtpParameters.encodings` has three
entries, and each consumer picks a layer (`consumer.setPreferredLayers({ spatialLayer })`), automatically too, based on
the receiver's bandwidth estimate. Upload rises from 1 to ~1.3× (the small layers are cheap), but each **receiver** gets
what it can handle: what step 13's mesh could only approximate with `maxBitrate` on every connection. VP9/AV1 can
do the same with **SVC** inside a single stream.

## Testing (backend tested with real browsers)

No UI yet, so the test used a ~100-line client bundled from `mediasoup-client` + `socket.io-client` and injected into headless
Chrome pages on `https://localhost:5173` (fake 720p camera + mic). It ran against this backend through the Vite proxy.

| Check | Result |
| ----- | ------ |
| Boot | 12 workers in ~0.5 s, ~18 MB each; announced 192.168.0.115, ports 40000–40100 |
| A, B, C send camera + mic | everyone receives the other two at 1280×720, playing; **1 outbound video per user** |
| Server state | 3 peers · 6 transports · 6 producers · 12 consumers |
| Candidates | `udp 192.168.0.115:40012`, `tcp 192.168.0.115:40001` (announced IP, not 0.0.0.0) |
| Paused consumers | 0 B before resume, ~200 KB / 50 frames 2.5 s after |
| B closes its camera producer | A, D get `producer-closed` → tile removed; consumers 15 (4 peers) |
| C closes the tab | peers 4 → 3, transports 7 → 5, producers 5 → 3, consumers 15 → 6; others notified |
| `kill -9` the room's worker | peers get `sfu:room-closed (mediasoup worker died)`, worker #0 restarted (new pid), new room on it works |
| Everyone leaves | `rooms: []` (router closed) |
| Mesh + 1:1 still work | `/group` with 3 tabs: all connected, video playing |
| Errors | none (after fixing: a closed room's sockets stayed in its Socket.IO room and received a *new* same-name room's broadcasts) |

Try it yourself: `curl -sk https://localhost:5173/api/sfu` while clients join (next step's page) to watch the server side.

## Quiz

1. In a 6-person call, how many RTCPeerConnections does each browser have, how many times does it encode its camera,
   and how many streams does the server send in total, with the mesh vs. the SFU?
2. Your backend runs on EC2 with private IP 172.31.5.10 and Elastic IP 3.110.20.30. What do you put in `MEDIASOUP_LISTEN_IP`
   and `MEDIASOUP_ANNOUNCED_IP`, what must the security group allow, and what exactly fails (and how does it look) if you
   announce the private IP?
3. In step 10 the browsers exchanged SDP through the server. In this step, what does the browser actually send in
   `sfu:produce` and `sfu:connectTransport`, and where does the SDP for the recv RTCPeerConnection come from?
4. Why does a consumer start paused? Describe what the user would see if it started unpaused, and what mediasoup does
   for video when the consumer is resumed.
5. A user's browser only decodes H264, and the sender's producer is VP8. What does `router.canConsume()` return, why can't
   the SFU fix it, and what are two ways to make this call work?
