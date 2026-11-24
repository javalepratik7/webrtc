// In-memory rooms: who is in which room. Max 2 users per room (one 1:1 call).
//
// Pure logic: no Socket.IO in here, so it's easy to test and to swap for Redis
// later (needed as soon as you run more than one server process).
//
//   rooms:       roomId → Map(userId → { id, name, joinedAt })
//   userToRoom:  userId → roomId   (lets disconnect find the room quickly)
//
// A "user" is one socket connection; userId = socket.id.
// clientId is chosen by the browser tab and survives socket reconnects, so a
// peer can tell "same tab, signaling reconnected" from "new tab / page reload".

export const MAX_USERS_PER_ROOM = 2;

// Basic input validation: room names end up in logs and URLs.
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

const rooms = new Map();
const userToRoom = new Map();

export function validateRoomId(roomId) {
  if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
    return 'Room name must be 1–40 characters: letters, digits, "-" or "_".';
  }
  return null;
}

export function cleanClientId(clientId) {
  return typeof clientId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(clientId) ? clientId : null;
}

export function cleanName(name) {
  const n = typeof name === 'string' ? name.trim().slice(0, 30) : '';
  return n || 'Anonymous';
}

// → { ok: true, peers: [other users] }  or  { ok: false, reason: 'full' }
export function join(roomId, user) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  if (room.has(user.id)) return { ok: true, peers: listPeers(roomId, user.id) }; // already in (idempotent)
  if (room.size >= MAX_USERS_PER_ROOM) return { ok: false, reason: 'full' };

  room.set(user.id, { id: user.id, name: user.name, clientId: user.clientId, joinedAt: Date.now() });
  userToRoom.set(user.id, roomId);
  return { ok: true, peers: listPeers(roomId, user.id) };
}

// Removes the user from their room (if any). → { roomId, user } or null
export function leave(userId) {
  const roomId = userToRoom.get(userId);
  if (!roomId) return null;
  userToRoom.delete(userId);
  const room = rooms.get(roomId);
  const user = room?.get(userId) ?? null;
  room?.delete(userId);
  if (room && room.size === 0) rooms.delete(roomId); // don't leak empty rooms
  return { roomId, user };
}

export function getRoomOf(userId) {
  return userToRoom.get(userId) ?? null;
}

// The other user in a 2-person room (or null).
export function getPeer(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  for (const u of room.values()) if (u.id !== userId) return u;
  return null;
}

export const publicUser = ({ id, name, clientId }) => ({ id, name, clientId });

export function listPeers(roomId, exceptUserId) {
  const room = rooms.get(roomId);
  // Only public fields go to clients.
  return room ? [...room.values()].filter((u) => u.id !== exceptUserId).map(publicUser) : [];
}

export function stats() {
  return { rooms: rooms.size, users: userToRoom.size };
}
