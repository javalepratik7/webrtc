# services/

Server-side logic that isn't tied to HTTP or sockets.

- `roomService.js`: in-memory rooms (max 2 users), join / leave / getPeer.
  Swap for Redis when running more than one server process.
- `groupRoomService.js` (Step 11): group rooms for the full mesh (max 6 users,
  `{ socketId, name, joinedAt }` each).

Later: TURN credential generation.
