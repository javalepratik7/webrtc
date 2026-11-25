// SFU signaling (step 14). Every client → server request uses a Socket.IO
// ACKNOWLEDGEMENT callback: mediasoup-client works request/response ("give me a
// transport" → here it is), so each event replies { ok: true, ...data } or { ok: false, error }.
//
// Client → server (all with ack)
//   sfu:join             { roomId, name }                                  → { roomId, peerId, routerRtpCapabilities, peers, producers }
//   sfu:createTransport  { direction: 'send' | 'recv' }                    → { id, iceParameters, iceCandidates, dtlsParameters }
//   sfu:connectTransport { transportId, dtlsParameters }                   → {}
//   sfu:produce          { transportId, kind, rtpParameters, appData }     → { id }          (+ broadcast sfu:new-producer)
//   sfu:consume          { transportId, producerId, rtpCapabilities }      → { id, producerId, kind, rtpParameters, … } (PAUSED)
//   sfu:resumeConsumer   { consumerId }                                    → {}
//   sfu:closeProducer    { producerId }                                    → {}              (e.g. stop screen share)
//   sfu:leave                                                              → {}
//
// Server → client
//   sfu:peer-joined      { peerId, name }
//   sfu:peer-left        { peerId, name }
//   sfu:new-producer     { producerId, peerId, name, kind, source }        someone started sending a track → consume it
//   sfu:producer-closed  { consumerId, producerId, peerId }                a track you receive is gone → close it
//   sfu:room-closed      { roomId, reason }                                the worker died: re-join
//
// Compared with steps 8–13 the server is no longer a dumb relay: it is the OTHER
// END of every connection. Nothing is forwarded peer-to-peer; the browser talks
// to mediasoup, and mediasoup forwards RTP between transports.
import logger from '../utils/logger.js';
import { validateRoomId, cleanName } from '../services/roomService.js';
import { workersReady } from '../mediasoup/workers.js';
import { getOrCreateRoom, closeIfEmpty } from '../mediasoup/sfuRoom.js';

const short = (id) => String(id).slice(0, 6);
const ioRoom = (roomId) => `sfu:${roomId}`; // not shared with the 1:1 / group Socket.IO rooms

const reply = (ack, data) => {
  if (typeof ack === 'function') ack(data);
};

export default function registerSfuHandlers(io, socket) {
  let room = null; // the SfuRoom this socket is in

  // The room can close under us (worker died). Forget it AND leave its Socket.IO
  // room: otherwise a NEW room with the same name would broadcast to this socket.
  const onRoomClose = () => {
    if (!room?.closed) return;
    socket.leave(ioRoom(room.id));
    room = null;
  };
  const who = () => `${short(socket.id)} (${socket.data.sfuName ?? '?'})`;
  // Rooms talk to clients through this: one socket = one peer.
  const notify = (peerId, event, data) => io.to(peerId).emit(event, data);

  const currentRoom = () => {
    if (!room) throw new Error('not in an SFU room (sfu:join first)');
    if (room.closed) throw new Error('the room was closed, join again');
    return room;
  };

  // Every handler: validate → do → ack. Errors become { ok:false, error } (and a log line).
  const handle = (event, fn) =>
    socket.on(event, async (data, ack) => {
      if (typeof data === 'function') [ack, data] = [data, {}];
      try {
        const result = await fn(data ?? {});
        reply(ack, { ok: true, ...result });
      } catch (err) {
        logger.warn(`${event} from ${who()} failed: ${err.message}`);
        reply(ack, { ok: false, error: err.message });
      }
    });

  function leave(reason) {
    if (!room) return;
    const r = room;
    room = null;
    r.off('close', onRoomClose);
    const peer = r.removePeer(socket.id); // closes its transports → producers → others' consumers
    socket.leave(ioRoom(r.id));
    if (peer && !r.closed) socket.to(ioRoom(r.id)).emit('sfu:peer-left', { peerId: socket.id, name: peer.name, reason });
    closeIfEmpty(r);
  }

  handle('sfu:join', async ({ roomId, name }) => {
    const error = validateRoomId(roomId);
    if (error) throw new Error(error);
    if (!workersReady()) throw new Error('the SFU is not available (mediasoup workers not running)');
    if (room && room.id !== roomId) leave('switched-room');

    socket.data.sfuName = cleanName(name);
    let r = await getOrCreateRoom(roomId, notify);
    // The last peer may have left (→ room closed as empty) while we were waiting.
    if (r.closed) r = await getOrCreateRoom(roomId, notify);
    const isNew = !r.peers.has(socket.id);
    r.addPeer(socket.id, socket.data.sfuName); // throws if full
    if (room !== r) {
      room = r;
      r.on('close', onRoomClose);
    }
    socket.join(ioRoom(roomId));
    if (isNew) socket.to(ioRoom(roomId)).emit('sfu:peer-joined', { peerId: socket.id, name: socket.data.sfuName });
    logger.info(`sfu "${roomId}": ${who()} joined (${r.peers.size} peer(s), ${r.producers.size} producer(s) to consume)`);
    return {
      roomId,
      peerId: socket.id,
      // Step 1 on the client: device.load({ routerRtpCapabilities }).
      routerRtpCapabilities: r.router.rtpCapabilities,
      peers: r.listPeers(socket.id),
      producers: r.listProducers(socket.id),
    };
  });

  handle('sfu:createTransport', async ({ direction }) => currentRoom().createTransport(socket.id, direction));

  handle('sfu:connectTransport', async ({ transportId, dtlsParameters }) => {
    await currentRoom().connectTransport(socket.id, transportId, dtlsParameters);
    return {};
  });

  handle('sfu:produce', async ({ transportId, kind, rtpParameters, appData }) => {
    const r = currentRoom();
    const producer = await r.produce(socket.id, { transportId, kind, rtpParameters, appData });
    // Everyone else should now consume it.
    socket.to(ioRoom(r.id)).emit('sfu:new-producer', {
      producerId: producer.id,
      peerId: socket.id,
      name: socket.data.sfuName,
      kind: producer.kind,
      source: producer.appData.source,
    });
    return { id: producer.id };
  });

  handle('sfu:consume', async ({ transportId, producerId, rtpCapabilities }) =>
    currentRoom().consume(socket.id, { transportId, producerId, rtpCapabilities }),
  );

  handle('sfu:resumeConsumer', async ({ consumerId }) => {
    await currentRoom().resumeConsumer(socket.id, consumerId);
    return {};
  });

  handle('sfu:closeProducer', async ({ producerId }) => {
    currentRoom().closeProducer(socket.id, producerId);
    return {};
  });

  handle('sfu:leave', async () => {
    leave('left');
    return {};
  });

  socket.on('disconnect', () => leave('disconnected'));
}
