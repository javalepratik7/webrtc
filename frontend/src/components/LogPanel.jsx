// Renders the shared log at the bottom of every page and auto-scrolls to the newest entry.
import { useEffect, useRef } from 'react';
import useLog from '../hooks/useLog.js';

export default function LogPanel() {
  const { entries, clear } = useLog();
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [entries]);

  return (
    <section className="log-panel">
      <header>
        <strong>Event log</strong>
        <span className="muted">{entries.length} entries</span>
        <button onClick={clear}>Clear</button>
      </header>
      <ol>
        {entries.length === 0 && <li className="muted">No events yet.</li>}
        {entries.map((e) => (
          <li key={e.id} className={`log-${e.level}`}>
            <span className="log-time">{e.time}</span> {e.message}
          </li>
        ))}
        <li ref={bottomRef} aria-hidden="true" />
      </ol>
    </section>
  );
}
