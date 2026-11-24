// Convenience hook: const { log } = useLog();
// Throws a clear error if used outside <LogProvider>, instead of a confusing
// "cannot read property of null" later.
import { useContext } from 'react';
import { LogContext } from '../context/LogContext.jsx';

export default function useLog() {
  const ctx = useContext(LogContext);
  if (!ctx) throw new Error('useLog must be used inside <LogProvider>');
  return ctx;
}
