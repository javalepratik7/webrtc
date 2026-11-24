// Room + signaling events for one socket.
//
// Client → server
//   join-room   { roomId, name }       ack → { ok, roomId, you, peers } | { ok:false, error }
//   leave-room                          ack → { ok }
//   signal      { type, payload }      ack → { ok } | { ok:false, error:'no-peer' }
//
// Server → client
//   room-full   { roomId }             the room already has 2 users
//   peer-joined { id, name }           the other user arrived
//   peer-left   { id, name, reason }   the other user left or disconnected
//   signal      { from, type, payload } relayed from the other user, UNCHANGED
//
// The server never parses `payload`. Offer, answer, candidate, ping... it's all
// opaque text to be delivered to the other user in the same room.
import logger from '../utils/logger.js';
import * as rooms from '../services/roomService.js';

const short = (id) => id.slice(0, 6);
const MAX_TYPE_LENGTH = 32;

// Socket.IO acks are optional on the client side; only call one if provided.
const reply = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

export default function registerRoomHandlers(io, socket) {
  const who = () => `${short(socket.id)} (${socket.data.name ?? '?'})`;

  // Shared by leave-room and disconnect.
  function leaveCurrentRoom(reason) {
    const left = rooms.leave(socket.id);
    if (!left) return;
    socket.leave(left.roomId);
    socket.to(left.roomId).emit('peer-left', { id: socket.id, name: left.user?.name, reason });
    logger.info(`room "${left.roomId}": ${who()} left (${reason}) | ${JSON.stringify(rooms.stats())}`);
  }

  socket.on('join-room', ({ roomId, name } = {}, ack) => {
    const error = rooms.validateRoomId(roomId);
    if (error) return reply(ack, { ok: false, error });

    // Switching rooms: leave the old one first.
    const current = rooms.getRoomOf(socket.id);
    if (current && current !== roomId) leaveCurrentRoom('switched-room');

    socket.data.name = rooms.cleanName(name);
    const result = rooms.join(roomId, { id: socket.id, name: socket.data.name });

    if (!result.ok) {
      logger.warn(`room "${roomId}": ${who()} rejected, room full`);
      socket.emit('room-full', { roomId });
      return reply(ack, { ok: false, error: 'room-full' });
    }

    socket.join(roomId); // Socket.IO's own room, used for socket.to(roomId)
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: socket.data.name });
    logger.info(`room "${roomId}": ${who()} joined, peers: ${result.peers.length} | ${JSON.stringify(rooms.stats())}`);
    return reply(ack, { ok: true, roomId, you: { id: socket.id, name: socket.data.name }, peers: result.peers });
  });

  socket.on('leave-room', (ack) => {
    leaveCurrentRoom('left');
    reply(ack, { ok: true });
  });

  socket.on('signal', ({ type, payload } = {}, ack) => {
    if (typeof type !== 'string' || !type || type.length > MAX_TYPE_LENGTH) {
      return reply(ack, { ok: false, error: 'invalid-type' });
    }
    const roomId = rooms.getRoomOf(socket.id);
    const peer = roomId && rooms.getPeer(roomId, socket.id);
    if (!peer) {
      logger.warn(`signal "${type}" from ${who()} dropped: no peer in room`);
      return reply(ack, { ok: false, error: 'no-peer' });
    }

    // Relay as-is, only to the other user. Log the TYPE and size, never the
    // content: SDP contains IP addresses and ICE credentials.
    io.to(peer.id).emit('signal', { from: socket.id, type, payload });
    const size = payload === undefined ? 0 : JSON.stringify(payload).length;
    logger.info(`signal "${type}" ${who()} → ${short(peer.id)} (${peer.name}) [${size} B] in "${roomId}"`);
    return reply(ack, { ok: true });
  });

  socket.on('disconnect', () => leaveCurrentRoom('disconnected'));
}
