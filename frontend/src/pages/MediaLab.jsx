// Step 3: capture camera + mic with getUserMedia, preview it, inspect the tracks.
// (Step 4 will add device selection, constraints and mute/unmute here.)
import useLocalMedia from '../hooks/useLocalMedia.js';
import VideoTile from '../components/VideoTile.jsx';
import MicLevel from '../components/MicLevel.jsx';

// Theory §4.1: `ideal` = "try to get this", the browser picks the closest match.
const DEFAULT_CONSTRAINTS = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  audio: { echoCancellation: true, noiseSuppression: true },
};

// For seeing an OverconstrainedError on purpose: no webcam does 10000 px wide.
const IMPOSSIBLE_CONSTRAINTS = { video: { width: { exact: 10000 } } };

export default function MediaLab() {
  const { stream, tracks, error, status, start, stop } = useLocalMedia();
  const busy = status === 'requesting';

  return (
    <div>
      <h1>Media Lab</h1>
      <p className="muted">Step 3: getUserMedia, MediaStream &amp; MediaStreamTrack</p>

      <div className="toolbar">
        <button className="primary" onClick={() => start(DEFAULT_CONSTRAINTS)} disabled={busy}>
          {stream ? 'Restart camera' : 'Start camera'}
        </button>
        <button onClick={stop} disabled={!stream && !busy}>
          Stop
        </button>
        <button onClick={() => start({ audio: true })} disabled={busy}>
          Mic only
        </button>
        <button onClick={() => start(IMPOSSIBLE_CONSTRAINTS)} disabled={busy}>
          Try impossible constraints
        </button>
        <span className={`badge badge-${status === 'live' ? 'online' : 'checking'}`}>{status}</span>
      </div>

      {error && (
        <div className="alert" role="alert">
          <strong>{error.name}</strong>: {error.hint}
          <div className="muted small">{error.message}</div>
        </div>
      )}

      <div className="media-grid">
        <div>
          <VideoTile stream={stream} muted mirrored label="Local preview (muted, mirrored)" />
          <MicLevel stream={stream} />
        </div>

        <div className="card">
          <h2>Tracks</h2>
          {stream && (
            <p className="muted small">
              MediaStream <code>{stream.id}</code>
            </p>
          )}
          {tracks.length === 0 ? (
            <p className="muted">No tracks yet. Press “Start camera”.</p>
          ) : (
            <table className="track-table">
              <thead>
                <tr>
                  <th>kind</th>
                  <th>label</th>
                  <th>readyState</th>
                  <th>enabled</th>
                  <th>muted</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => (
                  <tr key={t.id}>
                    <td>{t.kind}</td>
                    <td>{t.label || <span className="muted">(no label)</span>}</td>
                    <td className={t.readyState === 'live' ? 'ok' : 'err'}>{t.readyState}</td>
                    <td>{String(t.enabled)}</td>
                    <td>{String(t.muted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
