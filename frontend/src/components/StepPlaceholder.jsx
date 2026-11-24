// Shared layout for pages that aren't built yet: title, which roadmap steps
// the page covers, and what it will do. Also logs that the page mounted,
// which proves the shared logger works on every page.
import { useEffect } from 'react';
import useLog from '../hooks/useLog.js';

export default function StepPlaceholder({ title, steps, children }) {
  const { log } = useLog();

  useEffect(() => {
    log(`${title} page mounted`);
  }, [log, title]);

  return (
    <div>
      <h1>{title}</h1>
      <p className="muted">Roadmap: {steps}</p>
      <div className="card">{children}</div>
    </div>
  );
}
