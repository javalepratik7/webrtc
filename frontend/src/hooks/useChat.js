// Chat over any RTCDataChannel (used by Manual Signaling now, by Room in step 9).
//
//   const chat = useChat(channel, connectionState, { onData });   // channel: RTCDataChannel | null
//   chat.sendJson(obj)   send any other message type; the peer's onData(obj) receives it
//   chat.state     'none' | 'connecting' | 'open' | 'closing' | 'closed'
//   chat.messages  [{ id, from: 'me' | 'peer' | 'system', text, time }]
//   chat.send(text) → true if sent
//   chat.notifyTyping()  call on every keystroke (throttled: at most one message / 2 s)
//   chat.peerTyping      true while the peer is typing (cleared after 3 s of silence or on their message)
//
// connectionState (pc.connectionState) is needed because a channel can keep saying
// readyState "open" after its connection has FAILED (peer's tab closed), and
// dc.close() / pc.close() change readyState WITHOUT firing events.
//
// Wire format: JSON { type: 'chat', text, ts } and { type: 'typing' }. The typed
// envelope lets us add message types without breaking older ones.
import { useCallback, useEffect, useRef, useState } from 'react';

const TYPING_SEND_INTERVAL_MS = 2000;
const TYPING_TIMEOUT_MS = 3000;

let nextId = 1;

export default function useChat(channel, connectionState, { onData } = {}) {
  const [messages, setMessages] = useState([]);
  const [state, setState] = useState(channel?.readyState ?? 'none');
  const [peerTyping, setPeerTyping] = useState(false);
  const typingTimer = useRef(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const lastTypingSent = useRef(0);

  const add = useCallback((from, text) => {
    setMessages((m) => [...m, { id: nextId++, from, text, time: new Date() }]);
  }, []);

  useEffect(() => {
    if (!channel) {
      setState('none');
      return undefined;
    }
    setState(channel.readyState);
    // The channel may already be open when we get it (e.g. callee's ondatachannel).
    if (channel.readyState === 'open') add('system', `Data channel "${channel.label}" open`);

    const onOpen = () => {
      setState('open');
      add('system', `Data channel "${channel.label}" open`);
    };
    const onClose = () => {
      setState('closed');
      add('system', 'Data channel closed');
    };
    const onMessage = (e) => {
      let text = String(e.data);
      try {
        const msg = JSON.parse(e.data);
        if (msg?.type === 'typing') {
          setPeerTyping(true);
          clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setPeerTyping(false), TYPING_TIMEOUT_MS);
          return;
        }
        if (msg?.type && msg.type !== 'chat') {
          onDataRef.current?.(msg); // app-level message (e.g. media-state)
          return;
        }
        if (msg?.type === 'chat') text = msg.text;
      } catch {
        // not JSON: show the raw text
      }
      clearTimeout(typingTimer.current);
      setPeerTyping(false);
      add('peer', text);
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('message', onMessage);
      clearTimeout(typingTimer.current);
      setPeerTyping(false);
    };
  }, [channel, add]);

  const dead = connectionState === 'failed' || connectionState === 'closed';
  useEffect(() => {
    if (dead && channel) add('system', `Connection ${connectionState}: the chat is no longer delivered`);
  }, [dead]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(
    (text) => {
      if (dead || !channel || channel.readyState !== 'open' || !text.trim()) return false;
      channel.send(JSON.stringify({ type: 'chat', text, ts: Date.now() }));
      add('me', text);
      lastTypingSent.current = 0; // next keystroke announces typing again
      return true;
    },
    [channel, add, dead],
  );

  const sendJson = useCallback(
    (obj) => {
      if (dead || channel?.readyState !== 'open') return false;
      channel.send(JSON.stringify(obj));
      return true;
    },
    [channel, dead],
  );

  const notifyTyping = useCallback(() => {
    if (dead || channel?.readyState !== 'open') return;
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_INTERVAL_MS) return; // throttle
    lastTypingSent.current = now;
    channel.send(JSON.stringify({ type: 'typing' }));
  }, [channel, dead]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, state: dead && state !== 'none' ? 'closed' : state, send, sendJson, clear, notifyTyping, peerTyping: peerTyping && !dead };
}
