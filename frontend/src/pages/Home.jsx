import useBackendHealth from '../hooks/useBackendHealth.js';
import useLog from '../hooks/useLog.js';

const ROADMAP = [
  'Project setup',
  'HTTPS & LAN access',
  'Camera / mic (getUserMedia)',
  'Devices & controls',
  'Loopback peer connection',
  'SDP & ICE inspection',
  'Manual signaling (copy/paste)',
  'Socket.IO signaling server',
  'P2P data channel',
  'P2P video call',
];

export default function Home() {
  const { status, recheck } = useBackendHealth();
  const { log } = useLog();

  return (
    <div>
      <h1>WebRTC Lab</h1>
      <p>
        <span className={`badge badge-${status}`}>Backend: {status}</span>{' '}
        <button onClick={recheck}>Recheck</button>{' '}
        <button onClick={() => log('Hello from the Home page')}>Test log</button>
      </p>
      <div className="card">
        <h2>Roadmap</h2>
        <ol>
          {ROADMAP.map((step, i) => (
            <li key={step} className={i === 0 ? 'done' : ''}>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
