// Shared, app-wide event log.
// WebRTC is a chain of async events (getUserMedia resolves, onicecandidate fires,
// connectionState changes...). Seeing them in order, with timestamps, ON SCREEN
// is the fastest way to understand what's going on, so every page writes here.
import { createContext, useCallback, useMemo, useState } from 'react';

export const LogContext = createContext(null);

const MAX_ENTRIES = 500; // keep memory bounded on long sessions

let nextId = 1;

function timestamp() {
  const d = new Date();
  // HH:MM:SS.mmm: milliseconds matter when events fire close together
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function LogProvider({ children }) {
  const [entries, setEntries] = useState([]);

  // level: 'info' | 'success' | 'warn' | 'error'
  const log = useCallback((message, level = 'info') => {
    const entry = { id: nextId++, time: timestamp(), level, message: String(message) };
    setEntries((prev) => [...prev, entry].slice(-MAX_ENTRIES));
    // Mirror to the devtools console too, so you can expand objects there.
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${entry.time}] ${entry.message}`);
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  // Memoized so consumers only re-render when entries actually change.
  const value = useMemo(() => ({ entries, log, clear }), [entries, log, clear]);

  return <LogContext.Provider value={value}>{children}</LogContext.Provider>;
}
