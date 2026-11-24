// Chat over any RTCDataChannel (used by Manual Signaling now, by Room in step 9).
//
//   const chat = useChat(channel, connectionState);   // channel: RTCDataChannel | null
//   chat.state     'none' | 'connecting' | 'open' | 'closing' | 'closed'
//   chat.messages  [{ id, from: 'me' | 'peer' | 'system', text, time }]
//   chat.send(text) → true if sent
//
// connectionState (pc.connectionState) is needed because a channel can keep saying
// readyState "open" after its connection has FAILED (peer's tab closed), and
// dc.close() / pc.close() change readyState WITHOUT firing events.
//
// Wire format: JSON { type: 'chat', text, ts }. Using a typed envelope from the
// start lets us add other message types later (typing, file chunks...).
import { useCallback, useEffect, useState } from 'react';

let nextId = 1;

export default function useChat(channel, connectionState) {
  const [messages, setMessages] = useState([]);
  const [state, setState] = useState(channel?.readyState ?? 'none');

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
        if (msg?.type === 'chat') text = msg.text;
      } catch {
        // not JSON: show the raw text
      }
      add('peer', text);
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('message', onMessage);
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
      return true;
    },
    [channel, add, dead],
  );

  const clear = useCallback(() => setMessages([]), []);

  return { messages, state: dead && state !== 'none' ? 'closed' : state, send, clear };
}
