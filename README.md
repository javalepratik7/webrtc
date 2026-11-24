# WebRTC Lab

A hands-on project for learning WebRTC from scratch, one step at a time.
Theory notes: `~/Desktop/Code/functionality/Webrtc.md`.

```
WebRTC/
├── backend/    Node.js + Express (ES modules). Health API now, Socket.IO signaling in Step 8
└── frontend/   React + Vite. One page per group of roadmap steps, shared on-screen event log
```

## Prerequisites

- Node.js 20.19+ (`node -v`)
- A browser with camera/mic (Chrome or Firefox recommended)

## First-time setup

```bash
cd backend  && npm install && cp .env.example .env
cd ../frontend && npm install
```

## Running (two terminals)

**Terminal 1: backend** (http://localhost:4000)

```bash
cd backend
npm run dev      # auto-restarts on file changes (nodemon)
# npm start      # plain node, no auto-restart
```

**Terminal 2: frontend** (http://localhost:5173)

```bash
cd frontend
npm run dev
```

Open http://localhost:5173. The Home page should show **Backend: online**.
Stop the backend and press *Recheck* to see it switch to **offline**.

In dev, the browser only talks to Vite (`:5173`). Requests to `/api/*` are
proxied by Vite to Express (`:4000`), so there are no CORS issues and no
hard-coded backend URLs in the React code.

## Environment variables (`backend/.env`)

| Variable        | Default                 | Purpose                                     |
| --------------- | ----------------------- | ------------------------------------------- |
| `PORT`          | `4000`                  | Port the Express server listens on          |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Allowed origin for CORS (and Socket.IO later) |

## Roadmap

| #  | Step                        | Where              | Key APIs / concepts |
| -- | --------------------------- | ------------------ | ------------------- |
| 1  | Setup ✅                    | whole repo         | Project structure, proxy, shared logger |
| 2  | HTTPS & LAN                 | Vite + backend     | Secure context, testing from a phone on Wi-Fi |
| 3  | Camera / mic                | Media Lab          | `getUserMedia`, `MediaStream`, `<video>` |
| 4  | Devices & controls          | Media Lab          | `enumerateDevices`, constraints, mute/unmute, `devicechange` |
| 5  | Loopback peer connection    | Loopback           | Two `RTCPeerConnection`s in one tab, offer/answer |
| 6  | SDP & ICE inspection        | Loopback           | Reading SDP, ICE candidates, `getStats()` |
| 7  | Manual signaling            | Manual Signaling   | Copy/paste offer & answer between tabs/devices |
| 8  | Socket.IO signaling server  | backend `socket/` + Room | Rooms, relaying offers/answers/candidates |
| 9  | P2P data channel            | Room               | `RTCDataChannel` chat |
| 10 | P2P video call              | Room               | Full two-person video call, trickle ICE, hang-up |
