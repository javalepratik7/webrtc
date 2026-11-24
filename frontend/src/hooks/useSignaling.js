// Room membership + message relay over the shared Socket.IO client.
//
//   const sig = useSignaling({ onSignal, onPeerJoined, onPeerLeft });
//   await sig.join('my-room', 'Laptop')   → { ok, peers } | { ok:false, error }
//   sig.leave()
//   await sig.send('ping', { sentAt })     → { ok } | { ok:false, error:'no-peer' }
//   sig.status   'disconnected' | 'connecting' | 'connected'
//   sig.room     { id, you, peers } | null
//
// StrictMode: the effect below runs mount → cleanup → mount in dev. Every
// listener added in setup is removed in cleanup (socket.off with the SAME
// function), so nothing is registered twice. The socket itself is a module-level
// singleton and is NOT disconnected on cleanup. Reconnecting on every fake
// unmount would make the server see connect/disconnect/connect.
import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../services/socket.js';
import useLog from './useLog.js';

const ACK_TIMEOUT_MS = 5000;

export default function useSignaling({ onSignal, onPeerJoined, onPeerLeft } = {}) {
  const { log } = useLog();
  const [status, setStatus] = useState(socket.connected ? 'connected' : 'connecting');
  const [transport, setTransport] = useState(socket.io.engine?.transport?.name ?? null);
  const [socketId, setSocketId] = useState(socket.id ?? null);
  const [room, setRoom] = useState(null);
  const [error, setError] = useState(null);

  // Latest callbacks in refs: the page can pass new inline functions on every
  // render without re-registering socket listeners.
  const handlers = useRef({ onSignal, onPeerJoined, onPeerLeft });
  handlers.current = { onSignal, onPeerJoined, onPeerLeft };

  // What we joined (id + name), so we can re-join after a reconnect.
  const joinedRef = useRef(null);

  const doJoin = useCallback(
    async (roomId, name) => {
      setError(null);
      let res;
      try {
        res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('join-room', { roomId, name });
      } catch {
        res = { ok: false, error: 'No answer from the server (timeout).' };
      }
      if (res.ok) {
        joinedRef.current = { roomId, name };
        setRoom({ id: res.roomId, you: res.you, peers: res.peers });
        log(
          `Joined room "${res.roomId}" as ${res.you.name}; ${res.peers.length ? `peer already here: ${res.peers.map((p) => p.name).join(', ')}` : 'waiting for a peer'}`,
          'success',
        );
      } else {
        joinedRef.current = null;
        setRoom(null);
        const msg = res.error === 'room-full' ? `Room "${roomId}" is full (max 2 people).` : res.error;
        setError(msg);
        log(`Join failed: ${msg}`, 'error');
      }
      return res;
    },
    [log],
  );

  useEffect(() => {
    const onUpgrade = (t) => {
      setTransport(t.name);
      log(`Socket transport upgraded to ${t.name}`);
    };
    // Each (re)connection creates a new engine, so attach the upgrade listener per connection.
    const watchUpgrade = () => {
      const engine = socket.io.engine;
      if (engine && engine.transport.name !== 'websocket') engine.once('upgrade', onUpgrade);
    };

    const onConnect = () => {
      setStatus('connected');
      setSocketId(socket.id);
      setTransport(socket.io.engine.transport.name);
      watchUpgrade();
      log(`Socket connected (${socket.id.slice(0, 6)}) via ${socket.io.engine.transport.name}`, 'success');
      // The server forgets everything on restart/reconnect, so re-join the room we were in.
      if (joinedRef.current) {
        log(`Re-joining room "${joinedRef.current.roomId}" after reconnect`);
        doJoin(joinedRef.current.roomId, joinedRef.current.name);
      }
    };
    const onDisconnect = (reason) => {
      setStatus('disconnected');
      setRoom((r) => (r ? { ...r, peers: [] } : r));
      log(`Socket disconnected: ${reason}`, 'warn');
    };
    const onConnectError = (err) => {
      setStatus('disconnected');
      log(`Socket connect error: ${err.message}`, 'error');
    };
    const onReconnectAttempt = () => setStatus('connecting');

    const onPeerJoinedEvt = (peer) => {
      setRoom((r) => (r ? { ...r, peers: [...r.peers.filter((p) => p.id !== peer.id), peer] } : r));
      log(`peer-joined: ${peer.name} (${peer.id.slice(0, 6)})`, 'success');
      handlers.current.onPeerJoined?.(peer);
    };
    const onPeerLeftEvt = (peer) => {
      setRoom((r) => (r ? { ...r, peers: r.peers.filter((p) => p.id !== peer.id) } : r));
      log(`peer-left: ${peer.name ?? peer.id.slice(0, 6)} (${peer.reason})`, 'warn');
      handlers.current.onPeerLeft?.(peer);
    };
    const onRoomFull = ({ roomId }) => log(`room-full: "${roomId}"`, 'warn');
    const onSignalEvt = (msg) => handlers.current.onSignal?.(msg);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.io.on('reconnect_attempt', onReconnectAttempt); // manager-level event
    socket.on('peer-joined', onPeerJoinedEvt);
    socket.on('peer-left', onPeerLeftEvt);
    socket.on('room-full', onRoomFull);
    socket.on('signal', onSignalEvt);
    if (socket.connected) {
      watchUpgrade(); // already connected (e.g. came back to this page): maybe still polling
    } else {
      setStatus('connecting');
      socket.connect(); // no-op if already connecting
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.off('peer-joined', onPeerJoinedEvt);
      socket.off('peer-left', onPeerLeftEvt);
      socket.off('room-full', onRoomFull);
      socket.off('signal', onSignalEvt);
      socket.io.engine?.off('upgrade', onUpgrade);
      // Leaving the page = leaving the room (the socket stays connected for reuse).
      if (joinedRef.current) {
        socket.emit('leave-room');
        joinedRef.current = null;
      }
    };
  }, [log, doJoin]);

  const join = useCallback((roomId, name) => doJoin(roomId.trim(), name), [doJoin]);

  const leave = useCallback(async () => {
    joinedRef.current = null;
    setRoom(null);
    setError(null);
    try {
      await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('leave-room');
    } catch {
      // disconnected: the server already dropped us
    }
    log('Left the room');
  }, [log]);

  const send = useCallback(
    async (type, payload) => {
      try {
        const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('signal', { type, payload });
        if (!res.ok) log(`signal "${type}" not delivered: ${res.error}`, 'warn');
        return res;
      } catch {
        log(`signal "${type}": no ack from server (timeout)`, 'error');
        return { ok: false, error: 'timeout' };
      }
    },
    [log],
  );

  return { status, transport, socketId, room, error, join, leave, send };
}
