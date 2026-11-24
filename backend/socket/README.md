# socket/

Socket.IO signaling (Step 8).

- `index.js`: attaches Socket.IO to the Express HTTP server (same port, path `/socket.io`)
- `roomHandlers.js`: `join-room`, `leave-room`, `signal` (client → server) and
  `room-full`, `peer-joined`, `peer-left`, `signal` (server → client)

The server never touches media and never parses SDP: it relays `{ type, payload }`
to the other user in the room. Room bookkeeping lives in `services/roomService.js`.
