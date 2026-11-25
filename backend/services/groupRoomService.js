// In-memory GROUP rooms for the full-mesh page (steps 11–13). Max 6 users per room.
//
// Separate from roomService.js (the 1:1 rooms): different limits, different
// events, and a socket can't accidentally end up in both kinds of room logic.
//
//   rooms:         roomId   → Map(socketId → { socketId, clientId, name, joinedAt })
//   socketToRoom:  socketId → roomId   (lets disconnect find the room quickly)
//
// clientId (step 13) = the browser TAB's id (crypto.randomUUID(), survives socket
// reconnects). The socket id changes on every reconnect; the clientId doesn't. Peers
// address each other by clientId, so a reconnect doesn't look like a new person.
//
// Why 6? In a mesh every user keeps N−1 peer connections and uploads N−1 copies
// of their camera. 6 users = 15 connections in the room and 5 uploads per
// laptop/phone: about the practical ceiling (Webrtc.md §20.1, measured in step 13).
export { validateRoomId, cleanName, cleanClientId } from './roomService.js';

export const MAX_USERS_PER_GROUP = 6;

const rooms = new Map();
const socketToRoom = new Map();

const toPublic = ({ socketId, clientId, name, joinedAt }) => ({ socketId, clientId, name, joinedAt });

// → { ok: true, you, participants: [everyone ELSE, oldest first], replaced: oldSocketId | null }
//   | { ok: false, reason: 'full' }
// If the same TAB (clientId) is still listed under an old socket (its reconnect
// beat the server's ping timeout), that stale entry is replaced, not duplicated.
export function join(roomId, { socketId, clientId, name }) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  let replaced = null;
  let joinedAt = Date.now();
  if (!room.has(socketId)) {
    const stale = clientId && [...room.values()].find((u) => u.clientId === clientId);
    if (stale) {
      replaced = stale.socketId;
      joinedAt = stale.joinedAt; // same person: keep their place in the join order
      room.delete(stale.socketId);
      socketToRoom.delete(stale.socketId);
    } else if (room.size >= MAX_USERS_PER_GROUP) {
      return { ok: false, reason: 'full' };
    }
    room.set(socketId, { socketId, clientId, name, joinedAt });
    socketToRoom.set(socketId, roomId);
  }
  return { ok: true, you: toPublic(room.get(socketId)), participants: listParticipants(roomId, socketId), replaced };
}

// Removes the socket from its group room (if any). → { roomId, user } | null
export function leave(socketId) {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return null;
  socketToRoom.delete(socketId);
  const room = rooms.get(roomId);
  const user = room?.get(socketId) ?? null;
  room?.delete(socketId);
  if (room && room.size === 0) rooms.delete(roomId); // don't leak empty rooms
  return { roomId, user: user && toPublic(user) };
}

export function getRoomOf(socketId) {
  return socketToRoom.get(socketId) ?? null;
}

// Look a participant up by the TAB id peers use to address each other.
export function getParticipantByClientId(roomId, clientId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  for (const u of room.values()) if (u.clientId === clientId) return toPublic(u);
  return null;
}

// Map keeps insertion order, so this is in join order (oldest first).
export function listParticipants(roomId, exceptSocketId) {
  const room = rooms.get(roomId);
  return room ? [...room.values()].filter((u) => u.socketId !== exceptSocketId).map(toPublic) : [];
}

export function stats() {
  let connections = 0;
  for (const room of rooms.values()) connections += (room.size * (room.size - 1)) / 2;
  return { groups: rooms.size, users: socketToRoom.size, meshConnections: connections };
}
