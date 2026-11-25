// In-memory GROUP rooms for the full-mesh page (step 11). Max 6 users per room.
//
// Separate from roomService.js (the 1:1 rooms): different limits, different
// events, and a socket can't accidentally end up in both kinds of room logic.
//
//   rooms:         roomId   → Map(socketId → { socketId, name, joinedAt })
//   socketToRoom:  socketId → roomId   (lets disconnect find the room quickly)
//
// Why 6? In a mesh every user keeps N−1 peer connections and (later, with video)
// uploads N−1 copies of their camera. 6 users = 15 connections in the room and
// 5 uploads per laptop/phone: about the practical ceiling (Webrtc.md §20.1).
export { validateRoomId, cleanName } from './roomService.js';

export const MAX_USERS_PER_GROUP = 6;

const rooms = new Map();
const socketToRoom = new Map();

const toPublic = ({ socketId, name, joinedAt }) => ({ socketId, name, joinedAt });

// → { ok: true, you, participants: [everyone ELSE, oldest first] } | { ok: false, reason: 'full' }
export function join(roomId, { socketId, name }) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  if (!room.has(socketId)) {
    if (room.size >= MAX_USERS_PER_GROUP) return { ok: false, reason: 'full' };
    room.set(socketId, { socketId, name, joinedAt: Date.now() });
    socketToRoom.set(socketId, roomId);
  }
  return { ok: true, you: toPublic(room.get(socketId)), participants: listParticipants(roomId, socketId) };
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

export function getParticipant(roomId, socketId) {
  const u = rooms.get(roomId)?.get(socketId);
  return u ? toPublic(u) : null;
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
