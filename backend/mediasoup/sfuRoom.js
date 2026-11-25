// SFU rooms (step 14). One Room = one mediasoup Router (on one worker) + its peers.
//
//   Room
//   ├── router            the codecs of this room; routes RTP between transports
//   └── peers: Map(peerId → Peer)          peerId = socket id
//        Peer
//        ├── transports: Map   normally 2 WebRtcTransports: 'send' (browser → SFU) and 'recv' (SFU → browser)
//        ├── producers:  Map   tracks this peer SENDS   (on its send transport)
//        └── consumers:  Map   tracks this peer RECEIVES (on its recv transport), one per (other peer's producer)
//
// Ownership = cleanup order. Closing a transport closes its producers/consumers.
// Closing a producer closes every consumer of it (in OTHER peers) and fires
// 'producerclose' on them, which is how the others learn "that track is gone".
// Closing the router closes everything in the room.
//
// No Socket.IO in here: the room reports to clients through notify(peerId, event, data),
// and emits 'close' (reason) so the signaling layer can forget it.
import { EventEmitter } from 'node:events';
import logger from '../utils/logger.js';
import msConfig from './config.js';
import { getNextWorker } from './workers.js';

const short = (id) => String(id).slice(0, 6);
const SOURCES = new Set(['mic', 'camera', 'screen']);

export class SfuRoom extends EventEmitter {
  constructor(id, router, notify) {
    super();
    this.id = id;
    this.router = router;
    this.notify = notify; // (peerId, event, data) → void
    this.peers = new Map();
    this.producers = new Map(); // producerId → { producer, peerId }: quick lookup for consume()
    this.closed = false;

    // The worker process died → this router and everything on it are gone.
    router.on('workerclose', () => this.close('mediasoup worker died'));
  }

  static async create(id, notify) {
    const worker = getNextWorker();
    const router = await worker.createRouter({ mediaCodecs: msConfig.router.mediaCodecs, appData: { roomId: id } });
    logger.info(`sfu "${id}": router ${short(router.id)} created on worker #${worker.appData.slot} (pid ${worker.pid})`);
    return new SfuRoom(id, router, notify);
  }

  // ---- peers ---------------------------------------------------------------

  addPeer(peerId, name) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);
    if (this.peers.size >= msConfig.maxPeersPerRoom) throw new Error(`room is full (max ${msConfig.maxPeersPerRoom})`);
    const peer = { id: peerId, name, joinedAt: Date.now(), transports: new Map(), producers: new Map(), consumers: new Map() };
    this.peers.set(peerId, peer);
    return peer;
  }

  getPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('not in this room');
    return peer;
  }

  // Closing the transports closes everything this peer sent and received. The
  // other peers' consumers of its producers fire 'producerclose' → they are told.
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    const counts = `${peer.transports.size} transport(s), ${peer.producers.size} producer(s), ${peer.consumers.size} consumer(s)`;
    for (const transport of peer.transports.values()) transport.close();
    this.peers.delete(peerId);
    logger.info(`sfu "${this.id}": ${peer.name} removed (closed ${counts}); ${this.peers.size} peer(s) left`);
    return peer;
  }

  listPeers(exceptPeerId) {
    return [...this.peers.values()].filter((p) => p.id !== exceptPeerId).map(({ id, name, joinedAt }) => ({ peerId: id, name, joinedAt }));
  }

  // Everything already being sent in the room, so a newcomer can consume it.
  listProducers(exceptPeerId) {
    const list = [];
    for (const [producerId, { producer, peerId }] of this.producers) {
      if (peerId === exceptPeerId) continue;
      list.push({ producerId, peerId, name: this.peers.get(peerId)?.name, kind: producer.kind, source: producer.appData.source });
    }
    return list;
  }

  // ---- transports ------------------------------------------------------------

  // A WebRtcTransport is the server end of ONE RTCPeerConnection-like link:
  // its own ICE (lite) + DTLS + SRTP. Returns what mediasoup-client needs to build
  // the browser side (device.createSendTransport / createRecvTransport).
  async createTransport(peerId, direction) {
    if (direction !== 'send' && direction !== 'recv') throw new Error('direction must be "send" or "recv"');
    const peer = this.getPeer(peerId);
    // At most one per direction: a client that retries replaces its old one.
    for (const t of peer.transports.values()) if (t.appData.direction === direction) t.close();

    const transport = await this.router.createWebRtcTransport({
      ...msConfig.webRtcTransport,
      appData: { peerId, direction },
    });
    if (direction === 'send') await transport.setMaxIncomingBitrate(msConfig.maxIncomingBitrate);
    peer.transports.set(transport.id, transport);

    transport.on('icestatechange', (s) => logger.info(`sfu "${this.id}": ${peer.name} ${direction} transport ICE → ${s}`));
    transport.on('dtlsstatechange', (s) => {
      logger.info(`sfu "${this.id}": ${peer.name} ${direction} transport DTLS → ${s}`);
      if (s === 'failed' || s === 'closed') transport.close();
    });
    transport.observer.on('close', () => peer.transports.delete(transport.id));

    logger.info(
      `sfu "${this.id}": ${peer.name} ${direction} transport ${short(transport.id)} → candidates ${transport.iceCandidates.map((c) => `${c.protocol} ${c.address}:${c.port}`).join(', ')}`,
    );
    return {
      id: transport.id,
      direction,
      iceParameters: transport.iceParameters, // ufrag + password
      iceCandidates: transport.iceCandidates, // where to send: announcedIp:port (UDP, TCP)
      dtlsParameters: transport.dtlsParameters, // role + certificate fingerprints
    };
  }

  getTransport(peer, transportId, direction) {
    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error('unknown transport');
    if (direction && transport.appData.direction !== direction) throw new Error(`transport is not a ${direction} transport`);
    return transport;
  }

  // The browser's DTLS fingerprint + role (from mediasoup-client's 'connect' event).
  // After this the server can verify the browser's certificate in the DTLS handshake.
  async connectTransport(peerId, transportId, dtlsParameters) {
    const peer = this.getPeer(peerId);
    await this.getTransport(peer, transportId).connect({ dtlsParameters });
  }

  // ---- producers (what a peer sends) ------------------------------------------

  async produce(peerId, { transportId, kind, rtpParameters, appData = {} }) {
    const peer = this.getPeer(peerId);
    const transport = this.getTransport(peer, transportId, 'send');
    const source = SOURCES.has(appData?.source) ? appData.source : kind === 'audio' ? 'mic' : 'camera';
    const producer = await transport.produce({ kind, rtpParameters, appData: { peerId, source } });

    peer.producers.set(producer.id, producer);
    this.producers.set(producer.id, { producer, peerId });
    producer.observer.on('close', () => {
      peer.producers.delete(producer.id);
      this.producers.delete(producer.id);
    });
    logger.info(`sfu "${this.id}": ${peer.name} produces ${kind}/${source} ${short(producer.id)} (${producer.rtpParameters.codecs[0]?.mimeType})`);
    return producer;
  }

  closeProducer(peerId, producerId) {
    const peer = this.getPeer(peerId);
    const producer = peer.producers.get(producerId);
    if (!producer) throw new Error('unknown producer');
    producer.close(); // → every consumer of it fires 'producerclose'
  }

  // ---- consumers (what a peer receives) ---------------------------------------

  // rtpCapabilities = what the RECEIVING browser can decode (device.rtpCapabilities).
  async consume(peerId, { transportId, producerId, rtpCapabilities }) {
    const peer = this.getPeer(peerId);
    const transport = this.getTransport(peer, transportId, 'recv');
    const entry = this.producers.get(producerId);
    if (!entry) throw new Error('unknown producer (already closed?)');
    if (entry.peerId === peerId) throw new Error('cannot consume your own producer');
    // The SFU never transcodes: the receiver must support the codec the sender chose.
    if (!this.router.canConsume({ producerId, rtpCapabilities })) throw new Error('your device cannot decode this producer');

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // see notes/step14.md: start paused, resume once the client is ready
      appData: { peerId, producerPeerId: entry.peerId },
    });
    peer.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => peer.consumers.delete(consumer.id));
    // The sender stopped this track or left: tell THIS receiver to drop it.
    consumer.on('producerclose', () => {
      this.notify(peerId, 'sfu:producer-closed', { consumerId: consumer.id, producerId, peerId: entry.peerId });
    });

    const from = this.peers.get(entry.peerId)?.name;
    logger.info(`sfu "${this.id}": ${peer.name} consumes ${consumer.kind} of ${from} (${consumer.type}, paused) ${short(consumer.id)}`);
    return {
      id: consumer.id,
      producerId,
      producerPeerId: entry.peerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters, // codec, SSRC, header extensions the browser will receive
      type: consumer.type, // 'simple' | 'simulcast' | 'svc'
      producerPaused: consumer.producerPaused,
      source: entry.producer.appData.source,
    };
  }

  async resumeConsumer(peerId, consumerId) {
    const peer = this.getPeer(peerId);
    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new Error('unknown consumer');
    await consumer.resume();
    // A video receiver joining mid-stream needs a keyframe to start decoding:
    // mediasoup asks the producer for one when a video consumer is resumed.
  }

  // ---- lifecycle --------------------------------------------------------------

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const peerId of this.peers.keys()) this.notify(peerId, 'sfu:room-closed', { roomId: this.id, reason });
    this.peers.clear();
    this.producers.clear();
    if (!this.router.closed) this.router.close(); // closes every transport/producer/consumer in it
    if (rooms.get(this.id) === this) rooms.delete(this.id);
    this.emit('close', reason);
    logger.warn(`sfu "${this.id}": room closed (${reason})`);
  }

  stats() {
    const peers = [...this.peers.values()];
    return {
      roomId: this.id,
      peers: peers.length,
      transports: peers.reduce((n, p) => n + p.transports.size, 0),
      producers: this.producers.size,
      consumers: peers.reduce((n, p) => n + p.consumers.size, 0),
    };
  }
}

// ---- registry: roomId → SfuRoom ---------------------------------------------

const rooms = new Map();
const creating = new Map(); // roomId → Promise<SfuRoom>: two simultaneous joins must not create two routers

export async function getOrCreateRoom(roomId, notify) {
  const existing = rooms.get(roomId);
  if (existing && !existing.closed) return existing;
  if (!creating.has(roomId)) {
    creating.set(
      roomId,
      SfuRoom.create(roomId, notify)
        .then((room) => {
          rooms.set(roomId, room);
          return room;
        })
        .finally(() => creating.delete(roomId)),
    );
  }
  return creating.get(roomId);
}

// Called after a peer leaves: an empty room releases its router.
export function closeIfEmpty(room) {
  if (room && !room.closed && room.peers.size === 0) room.close('empty');
}

export function sfuStats() {
  return [...rooms.values()].map((r) => r.stats());
}
