// Small chat UI. Presentational: pair it with useChat(channel, connectionState).
//   <ChatBox messages={chat.messages} state={chat.state} onSend={chat.send}
//            onTyping={chat.notifyTyping} peerTyping={chat.peerTyping} peerName="Phone" />
import { useEffect, useRef, useState } from 'react';

const time = (d) => d.toTimeString().slice(0, 8);

export default function ChatBox({ messages, state, onSend, onTyping, peerTyping, peerName = 'Peer', title = 'Chat (data channel)' }) {
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const open = state === 'open';

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e) => {
    e.preventDefault();
    if (onSend(text)) setText('');
  };

  return (
    <div className="card chat">
      <h2>
        {title} <span className={`badge badge-${open ? 'online' : 'checking'}`}>{state}</span>
      </h2>
      <ol className="chat-list" ref={listRef} aria-live="polite">
        {messages.length === 0 && <li className="chat-system">No messages yet.</li>}
        {messages.map((m) => (
          <li key={m.id} className={`chat-${m.from}`} aria-label={m.from === 'me' ? 'sent' : m.from === 'peer' ? 'received' : undefined}>
            {m.from === 'system' ? (
              <>
                {time(m.time)} · {m.text}
              </>
            ) : (
              <>
                <span className="chat-bubble">{m.text}</span>
                <span className="chat-time">{time(m.time)}</span>
              </>
            )}
          </li>
        ))}
      </ol>
      <p className="chat-typing" aria-live="polite">
        {peerTyping ? `${peerName} is typing…` : '\u00a0'}
      </p>
      <form className="chat-form" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onTyping?.();
          }}
          placeholder={open ? 'Type a message…' : 'Waiting for the data channel to open…'}
          disabled={!open}
          aria-label="Message"
        />
        <button className="primary" type="submit" disabled={!open || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
