# socket/

Socket.IO signaling (Step 8).

- `index.js`: attaches Socket.IO to the Express HTTP server (same port, path `/socket.io`)
- `roomHandlers.js`: `join-room`, `leave-room`, `signal` (client → server) and
  `room-full`, `peer-joined`, `peer-left`, `signal` (server → client)
- `groupHandlers.js` (Step 11): `group:join`, `group:leave`, `group:signal {to}` (client → server) and
  `group:participant-joined`, `group:participant-left`, `group:signal {from}` (server → client).
  Signals are unicast to ONE socket: in a mesh every pair has its own connection.

The server never touches media and never parses SDP: it relays `{ type, payload }`
to the other user in the room. Room bookkeeping lives in `services/roomService.js`.
