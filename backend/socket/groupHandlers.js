// Group (full-mesh) room + signaling events for one socket. Step 11.
//
// Client → server
//   group:join    { roomId, name }       ack → { ok, roomId, you, participants } | { ok:false, error }
//   group:leave                          ack → { ok }
//   group:signal  { to, type, payload }  ack → { ok } | { ok:false, error }
//
// Server → client
//   group:participant-joined  { socketId, name, joinedAt }   someone new arrived (they will send YOU an offer)
//   group:participant-left    { socketId, name, reason }     someone left or disconnected
//   group:signal              { from, type, payload }        relayed from ONE participant, to ONE participant
//
// Why the 1:1 relay ("send to the other user in the room") is not enough anymore:
//   In a mesh, every pair of users has its OWN RTCPeerConnection, with its own SDP
//   (ICE ufrag/pwd, DTLS fingerprint, m-lines) and its own ICE candidates. With 4
//   users, C runs three separate negotiations at once (C↔A, C↔B, C↔D). An offer C
//   made for A must reach A and nobody else: if B applied it, B would answer an
//   offer meant for a different connection, and A would never get its offer.
//   So each message needs a destination (`to`), and the receiver needs `from` to
//   pick the right connection out of its Map. Broadcasting to the room
//   (socket.to(roomId)) would be wrong for every signaling message.
//
// The server still never parses `payload`. It only checks that `to` is in the
// SAME group room as the sender, so a client can't use us to message arbitrary sockets.
import logger from '../utils/logger.js';
import * as groups from '../services/groupRoomService.js';

const short = (id) => (typeof id === 'string' ? id.slice(0, 6) : '?');
const MAX_TYPE_LENGTH = 32;
// Socket.IO room names are shared with the 1:1 rooms: prefix them so
// "test" (1:1) and "test" (group) never receive each other's broadcasts.
const ioRoom = (roomId) => `group:${roomId}`;

const reply = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

export default function registerGroupHandlers(io, socket) {
  const who = () => `${short(socket.id)} (${socket.data.groupName ?? '?'})`;

  // Shared by group:leave, switching rooms and disconnect.
  function leaveCurrentGroup(reason) {
    const left = groups.leave(socket.id);
    if (!left) return;
    socket.leave(ioRoom(left.roomId));
    socket.to(ioRoom(left.roomId)).emit('group:participant-left', { socketId: socket.id, name: left.user?.name, reason });
    logger.info(`group "${left.roomId}": ${who()} left (${reason}) | ${JSON.stringify(groups.stats())}`);
  }

  socket.on('group:join', ({ roomId, name } = {}, ack) => {
    const error = groups.validateRoomId(roomId);
    if (error) return reply(ack, { ok: false, error });

    const current = groups.getRoomOf(socket.id);
    if (current && current !== roomId) leaveCurrentGroup('switched-room');

    socket.data.groupName = groups.cleanName(name);
    const result = groups.join(roomId, { socketId: socket.id, name: socket.data.groupName });
    if (!result.ok) {
      logger.warn(`group "${roomId}": ${who()} rejected, room full (${groups.MAX_USERS_PER_GROUP})`);
      return reply(ack, { ok: false, error: 'room-full' });
    }

    socket.join(ioRoom(roomId));
    // ORDER MATTERS: the others hear "participant-joined" BEFORE the newcomer gets
    // its ack. The newcomer only sends offers after the ack, and Socket.IO keeps
    // per-connection order, so every existing user knows the newcomer's name
    // before its offer arrives.
    socket.to(ioRoom(roomId)).emit('group:participant-joined', result.you);
    logger.info(
      `group "${roomId}": ${who()} joined, existing: [${result.participants.map((p) => p.name).join(', ')}] → it will send ${result.participants.length} offer(s) | ${JSON.stringify(groups.stats())}`,
    );
    return reply(ack, { ok: true, roomId, you: result.you, participants: result.participants });
  });

  socket.on('group:leave', (ack) => {
    leaveCurrentGroup('left');
    reply(ack, { ok: true });
  });

  socket.on('group:signal', ({ to, type, payload } = {}, ack) => {
    if (typeof type !== 'string' || !type || type.length > MAX_TYPE_LENGTH) {
      return reply(ack, { ok: false, error: 'invalid-type' });
    }
    const roomId = groups.getRoomOf(socket.id);
    if (!roomId) return reply(ack, { ok: false, error: 'not-in-room' });
    const target = typeof to === 'string' && to !== socket.id ? groups.getParticipant(roomId, to) : null;
    if (!target) {
      // Usually a race: the target left while our message was in flight.
      logger.warn(`group signal "${type}" from ${who()} → ${short(to)} dropped: not in "${roomId}"`);
      return reply(ack, { ok: false, error: 'no-such-participant' });
    }

    // Unicast: io.to(<socket id>) reaches exactly that one socket.
    io.to(target.socketId).emit('group:signal', { from: socket.id, type, payload });
    const size = payload === undefined ? 0 : JSON.stringify(payload).length;
    logger.info(`group signal "${type}" ${who()} → ${short(target.socketId)} (${target.name}) [${size} B] in "${roomId}"`);
    return reply(ack, { ok: true });
  });

  socket.on('disconnect', () => leaveCurrentGroup('disconnected'));
}
