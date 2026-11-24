// Steps 5–6: Connection Inspector.
// Two RTCPeerConnections in one tab (A → B), then inspect what they produced:
// SDP offer/answer, ICE candidates, state machines and getStats().
import { useCallback, useEffect, useState } from 'react';
import useLoopback from '../hooks/useLoopback.js';
import VideoTile from '../components/VideoTile.jsx';
import SdpViewer from '../components/SdpViewer.jsx';
import CandidateTable from '../components/CandidateTable.jsx';
import StatsPanel from '../components/StatsPanel.jsx';

const STATE_ROWS = [
  ['signaling', 'signalingState'],
  ['iceGathering', 'iceGatheringState'],
  ['iceConnection', 'iceConnectionState'],
  ['connection', 'connectionState'],
];

const GOOD = new Set(['stable', 'complete', 'connected', 'completed']);
const BAD = new Set(['failed', 'disconnected', 'closed']);
const stateClass = (v) => (GOOD.has(v) ? 'ok' : BAD.has(v) ? 'err' : '');

export default function Loopback() {
  const lb = useLoopback();
  const [opts, setOpts] = useState({ audio: false, video: true, data: true, useStun: true, trickle: true });
  const [stats, setStats] = useState(null);
  const [autoStats, setAutoStats] = useState(false);
  const nothingSelected = !opts.audio && !opts.video && !opts.data;
  const connected = lb.states.A.connection === 'connected';

  const toggle = (key) => (e) => setOpts((o) => ({ ...o, [key]: e.target.checked }));

  const refreshStats = useCallback(async () => {
    const s = await lb.getStats();
    if (s) setStats(s);
  }, [lb.getStats]); // eslint-disable-line react-hooks/exhaustive-deps

  // Optional 1 s auto-refresh (also gives meaningful kbps numbers).
  useEffect(() => {
    if (!autoStats || !lb.running) return undefined;
    const id = setInterval(refreshStats, 1000);
    return () => clearInterval(id);
  }, [autoStats, lb.running, refreshStats]);

  const connect = () => {
    setStats(null);
    lb.connect(opts);
  };

  return (
    <div>
      <h1>Connection Inspector</h1>
      <p className="muted">Steps 5–6: loopback RTCPeerConnection (A → B in one tab), SDP, ICE candidates, getStats()</p>

      <div className="card">
        <div className="toolbar">
          <label className="checkbox inline">
            <input type="checkbox" checked={opts.audio} onChange={toggle('audio')} disabled={lb.running} /> audio
          </label>
          <label className="checkbox inline">
            <input type="checkbox" checked={opts.video} onChange={toggle('video')} disabled={lb.running} /> video
          </label>
          <label className="checkbox inline">
            <input type="checkbox" checked={opts.data} onChange={toggle('data')} disabled={lb.running} /> data channel
          </label>
          <label className="checkbox inline" title="Without STUN only host candidates are gathered">
            <input type="checkbox" checked={opts.useStun} onChange={toggle('useStun')} disabled={lb.running} /> STUN
            (stun.l.google.com)
          </label>
          <label className="checkbox inline" title="Unticked: wait for ALL candidates, then send them inside the SDP (vanilla ICE)">
            <input type="checkbox" checked={opts.trickle} onChange={toggle('trickle')} disabled={lb.running} /> trickle ICE
          </label>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="primary" onClick={connect} disabled={nothingSelected || lb.running}>
            Connect
          </button>
          <button onClick={lb.close} disabled={!lb.running}>
            Hang up
          </button>
          <button onClick={refreshStats} disabled={!lb.running}>
            Stats
          </button>
          <label className="checkbox inline">
            <input type="checkbox" checked={autoStats} onChange={(e) => setAutoStats(e.target.checked)} /> auto-refresh 1 s
          </label>
          {nothingSelected && <span className="muted small">Pick at least one: with nothing to negotiate, the SDP has no m-sections and ICE never starts.</span>}
        </div>
        {lb.error && (
          <div className="alert" role="alert" style={{ marginTop: '1rem', marginBottom: 0 }}>
            {lb.error}
          </div>
        )}
      </div>

      <div className="inspector-grid">
        <div className="card">
          <h2>State machines</h2>
          <table className="track-table">
            <thead>
              <tr>
                <th>state</th>
                <th>A (caller)</th>
                <th>B (callee)</th>
              </tr>
            </thead>
            <tbody>
              {STATE_ROWS.map(([key, name]) => (
                <tr key={key}>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td className={stateClass(lb.states.A[key])}>{lb.states.A[key]}</td>
                  <td className={stateClass(lb.states.B[key])}>{lb.states.B[key]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(lb.localStream || lb.remoteStream) && (
          <div className="loopback-videos">
            <VideoTile stream={lb.localStream} muted mirrored label="A: local" />
            {/* Muted too: in a loopback, the "remote" audio is your own mic → instant feedback. */}
            <VideoTile stream={lb.remoteStream} muted label="B: received over RTCPeerConnection" />
          </div>
        )}
      </div>

      <div className="card">
        <h2>Stats {connected ? '' : <span className="muted small">(connect first)</span>}</h2>
        <StatsPanel stats={stats} />
      </div>

      <CandidateTable candidates={lb.candidates} stunUsed={opts.useStun} trickle={opts.trickle} done={connected} />
      <SdpViewer sdp={lb.sdp} label={lb.label} />
    </div>
  );
}
