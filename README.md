# WebRTC Lab

A hands-on project for learning WebRTC from scratch, built step by step: from
`getUserMedia` to a complete 1:1 peer-to-peer video call with chat, over a
Socket.IO signaling server, and then group video calls (full mesh, up to 6 people).

Theory notes: `~/Desktop/Code/functionality/Webrtc.md`. What I learned in each step: [`notes/`](notes/).

```
WebRTC/
├── backend/                 Node.js + Express (ES modules), port 4000
│   ├── server.js            Express app + http.Server + Socket.IO
│   ├── config/              env vars (PORT, CLIENT_ORIGIN)
│   ├── routes/ controllers/ GET /api/health, GET /api/network (LAN IPs, dev helper)
│   ├── socket/              Socket.IO setup + room/signal handlers (1:1 and group:*)
│   └── services/            roomService (1:1, max 2), groupRoomService (mesh, max 6)
├── frontend/                React + Vite, HTTPS on port 5173
│   └── src/
│       ├── pages/           Home, MediaLab, Loopback, ManualSignaling, Room, GroupMesh
│       ├── hooks/           useLocalMedia, useDevices, useLoopback, useManualPeer,
│       │                    useSignaling, usePeerConnection, useChat, useMeshRoom, useActiveSpeaker, useLog, …
│       ├── components/      VideoTile, MicLevel, DeviceSelector, SdpViewer, CandidateTable,
│       │                    StatsPanel, StatsOverlay, ChatBox, CallControls, ParticipantList,
│       │                    MeshDiagram, GroupChat, VideoGrid, ParticipantTile, CopyBox, LogPanel, …
│       └── services/        webrtc.js (ICE config, candidate parser, stats), sdp.js,
│                            socket.js (single Socket.IO client), api.js
└── notes/                   step02.md … step12.md
```

## Prerequisites

- Node.js 20.19+ (`node -v`)
- Chrome, Edge or Firefox with a camera/mic; a phone on the same Wi-Fi for the 2-device tests

## First-time setup

```bash
cd backend  && npm install && cp .env.example .env
cd ../frontend && npm install
```

### Local HTTPS certs

Camera/mic only work in a **secure context**, and a phone reaches the laptop via
`https://<LAN-IP>:5173`. So the dev server needs a certificate for both. Generate one with
[mkcert](https://github.com/FiloSottile/mkcert) (once per machine; `frontend/certs/` is gitignored):

```bash
sudo apt install mkcert libnss3-tools
mkcert -install
cd frontend && mkdir -p certs
mkcert -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem \
  localhost 127.0.0.1 ::1 <your-LAN-IP>      # find it with: hostname -I
```

If your LAN IP changes, regenerate. Trusting the CA on Android/iPhone: [notes/step02.md](notes/step02.md).

## Running (two terminals)

```bash
cd backend  && npm run dev     # http://localhost:4000 (nodemon)
cd frontend && npm run dev     # https://localhost:5173 and https://<LAN-IP>:5173
```

The browser only ever talks to the Vite origin. Vite proxies `/api` and `/socket.io`
(including the WebSocket upgrade) to Express on `localhost:4000`, so the backend can stay
plain HTTP and there's no CORS or mixed content.

## Making a video call

1. Laptop: open https://localhost:5173/room, pick a room name, **Join call** (camera + mic start).
2. The page shows a link like `https://192.168.x.x:5173/room?room=…`. Open it on the phone (same
   Wi-Fi) or in a second browser, and **Join call**.
3. The first person becomes the caller; offer, answer and ICE candidates go through the server;
   video, audio and chat then flow **directly** between the two browsers.
4. Controls: mute, camera off, switch camera (`sender.replaceTrack`), 📊 live stats, hang up.

Two tabs on one laptop work too. Use headphones or mute one side, or you'll get audio feedback.

## Pages

| Page | Steps | What it shows |
| ---- | ----- | ------------- |
| **Home** | 1–2 | Secure context, `navigator.mediaDevices`, backend health, roadmap |
| **Media Lab** | 3–4 | getUserMedia, track table, mic meter, device pickers, resolution presets, mute vs stop, audio processing, screen share, speaker selection |
| **Loopback** | 5–6 | Two peer connections in one tab; SDP viewer with per-line explanations, ICE candidate table (mDNS, srflx), getStats, trickle vs non-trickle |
| **Manual Signaling** | 7 | Connect two tabs by copy-pasting offer/answer (and candidates): you are the signaling server |
| **Room** | 8–10 | Socket.IO rooms → P2P data-channel chat → full video call |
| **Group Mesh** | 11–12 | Up to 6 people, one peer connection per pair (N×(N−1)/2), per-peer states, group chat; video grid, mute/camera state over data channels, active speaker, camera switch on every sender |

Every page writes timestamped events to the **Event log** at the bottom.

## Environment variables (`backend/.env`)

| Variable        | Default                  | Purpose |
| --------------- | ------------------------ | ------- |
| `PORT`          | `4000`                   | Port the Express + Socket.IO server listens on |
| `CLIENT_ORIGIN` | `https://localhost:5173` | Allowed origin(s) for CORS and Socket.IO, comma-separated |

## Signaling protocol (Socket.IO)

| Direction | Event | Data |
| --------- | ----- | ---- |
| client → server | `join-room` | `{ roomId, name, clientId }`, ack `{ ok, you, peers }` |
| client → server | `leave-room` | |
| client → server | `signal` | `{ type, payload }`, relayed unchanged to the other user |
| server → client | `peer-joined` / `peer-left` / `room-full` | `{ id, name, clientId }` / `{ id, name, reason }` / `{ roomId }` |
| server → client | `signal` | `{ from, fromClientId, type, payload }` |

Signal types used: `offer`, `answer`, `candidate`, `bye`, `ping`/`pong`. The server never parses payloads
and logs only type + size.

Group mesh (step 11): separate `group:*` events. Signals are **unicast** to one participant:

| Direction | Event | Data |
| --------- | ----- | ---- |
| client → server | `group:join` | `{ roomId, name }`, ack `{ ok, you, participants }` (everyone already there) |
| client → server | `group:leave` | |
| client → server | `group:signal` | `{ to, type, payload }`, relayed only to `to` (must be in the same group) |
| server → client | `group:participant-joined` / `group:participant-left` | `{ socketId, name, joinedAt }` / `{ socketId, name, reason }` |
| server → client | `group:signal` | `{ from, type, payload }` |

The new joiner offers to everyone in `participants`; existing users only answer.

## Testing tips

- **Fake devices** (no camera needed, two cameras to switch between, no permission prompt):
  `google-chrome --use-fake-device-for-media-stream=device-count=2 --use-fake-ui-for-media-stream`.
  Note: Chrome's second fake camera emulates a depth camera that WebRTC can't encode (0 frames sent). Use
  it to test switching, but don't expect video from it.
- **chrome://webrtc-internals**: every peer connection's events, candidate pairs, and stats graphs.
- The Room lobby's "Simulate slow setRemoteDescription" checkbox (tick it on the callee) makes the candidate queue visible in the log.

## Roadmap

| #  | Step                        | Where              | Key APIs / concepts | Notes |
| -- | --------------------------- | ------------------ | ------------------- | ----- |
| 1  | Setup ✅                    | whole repo         | Project structure, proxy, shared logger | |
| 2  | HTTPS & LAN ✅              | Vite + backend     | Secure context, mkcert, phone on Wi-Fi | [step02](notes/step02.md) |
| 3  | Camera / mic ✅             | Media Lab          | `getUserMedia`, `MediaStream`, `<video>`, Web Audio meter | [step03](notes/step03.md) |
| 4  | Devices & controls ✅       | Media Lab          | `enumerateDevices`, constraints, `applyConstraints`, `getDisplayMedia`, `setSinkId` | [step04](notes/step04.md) |
| 5  | Loopback peer connection ✅ | Loopback           | Two `RTCPeerConnection`s, offer/answer | [step06](notes/step06.md) |
| 6  | SDP & ICE inspection ✅     | Loopback           | Reading SDP, ICE candidates, `getStats()` | [step06](notes/step06.md) |
| 7  | Manual signaling ✅         | Manual Signaling   | Copy/paste signaling, trickle vs vanilla ICE | [step07](notes/step07.md) |
| 8  | Socket.IO signaling ✅      | backend + Room     | Rooms, relay, reconnects | [step08](notes/step08.md) |
| 9  | P2P data channel ✅         | Room               | Trickle ICE, candidate queue, `RTCDataChannel` chat | [step09](notes/step09.md) |
| 10 | P2P video call ✅           | Room               | Tracks before offer/answer, `ontrack`, `replaceTrack`, stats, cleanup | [step10](notes/step10.md) |
| 11 | Group mesh (chat) ✅        | Group Mesh         | Per-peer `RTCPeerConnection` Map, unicast signaling, join rule vs glare, N×(N−1)/2 | [step11](notes/step11.md) |
| 12 | Group mesh video ✅         | Group Mesh         | One track → N−1 senders, remote streams per peer, media-state broadcast, `audioLevel` active speaker, flicker-free grid | [step12](notes/step12.md) |

### Next phase

- **TURN server** (coturn) with short-lived credentials from the backend, so calls work across strict NATs / mobile data
- ICE restart on network changes, perfect negotiation (renegotiation without glare)
- Auth, room authorization and rate limits on the signaling server
- Group calls: an SFU (one upload instead of N−1)
