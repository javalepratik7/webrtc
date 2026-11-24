// Shows the three things that must be true before WebRTC work can start:
//  1. The page is a secure context (HTTPS, or http://localhost)
//  2. navigator.mediaDevices exists (browsers hide it entirely on insecure origins)
//  3. The backend answers through the Vite proxy
import useBackendHealth from '../hooks/useBackendHealth.js';

function Check({ ok, label, detail }) {
  return (
    <li className="status-row">
      <span className={`badge ${ok ? 'badge-online' : 'badge-offline'}`}>{ok ? 'yes' : 'no'}</span>
      <span>
        <strong>{label}</strong>
        {detail && <span className="muted"> {detail}</span>}
      </span>
    </li>
  );
}

export default function StatusBadge() {
  const { status, recheck } = useBackendHealth();
  const secure = window.isSecureContext;
  const hasMediaDevices = Boolean(navigator.mediaDevices?.getUserMedia);

  return (
    <div className="card">
      <h2>Environment</h2>
      <p className="muted">
        Origin: <code>{window.location.origin}</code>
      </p>
      <ul className="status-list">
        <Check
          ok={secure}
          label="window.isSecureContext"
          detail={secure ? '' : '(open via https:// or http://localhost)'}
        />
        <Check
          ok={hasMediaDevices}
          label="navigator.mediaDevices"
          detail={hasMediaDevices ? '' : '(undefined: camera/mic APIs are hidden on insecure origins)'}
        />
        <li className="status-row">
          <span className={`badge badge-${status}`}>{status}</span>
          <span>
            <strong>Backend</strong> <span className="muted">(/api/health via Vite proxy)</span>{' '}
            <button onClick={recheck}>Recheck</button>
          </span>
        </li>
      </ul>
    </div>
  );
}
