// Group chat UI for the mesh. Presentational: pair it with useMeshRoom.
//   <GroupChat messages={mesh.messages} openCount={2} peerCount={3} onSend={mesh.sendChat} />
// Each sent message shows "→ 2/3": how many data channels it actually went out on.
import { useEffect, useRef, useState } from 'react';

const time = (d) => d.toTimeString().slice(0, 8);

export default function GroupChat({ messages, openCount, peerCount, onSend }) {
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const canSend = openCount > 0;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e) => {
    e.preventDefault();
    if (onSend(text) > 0) setText('');
  };

  return (
    <div className="card chat">
      <h2>
        Group chat{' '}
        <span className={`badge badge-${canSend && openCount === peerCount ? 'online' : 'checking'}`}>
          {openCount}/{peerCount} channels open
        </span>
      </h2>
      <ol className="chat-list group-chat-list" ref={listRef} aria-live="polite">
        {messages.length === 0 && <li className="chat-system">No messages yet.</li>}
        {messages.map((m) =>
          m.from === 'system' ? (
            <li key={m.id} className="chat-system">
              {time(m.time)} · {m.text}
            </li>
          ) : (
            <li key={m.id} className={`chat-${m.from}`}>
              {m.from === 'peer' && <span className="chat-author">{m.name}</span>}
              <span className="chat-bubble">{m.text}</span>
              <span className="group-chat-meta">
                {time(m.time)}
                {m.from === 'me' && ` · sent over ${m.sentTo}/${m.of} channel${m.of === 1 ? '' : 's'}`}
              </span>
            </li>
          ),
        )}
      </ol>
      <form className="chat-form" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={canSend ? 'Message everyone…' : 'Waiting for a data channel to open…'}
          disabled={!canSend}
          aria-label="Message"
        />
        <button className="primary" type="submit" disabled={!canSend || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
