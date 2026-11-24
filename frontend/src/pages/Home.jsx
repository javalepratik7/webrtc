import StatusBadge from '../components/StatusBadge.jsx';
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
  const { log } = useLog();

  return (
    <div>
      <h1>WebRTC Lab</h1>
      <p>
        <button onClick={() => log('Hello from the Home page')}>Test log</button>
      </p>
      <StatusBadge />
      <div className="card">
        <h2>Roadmap</h2>
        <ol>
          {ROADMAP.map((step, i) => (
            <li key={step} className={i <= 5 ? 'done' : ''}>
              {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
