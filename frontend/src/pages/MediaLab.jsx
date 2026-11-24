// Steps 3–4: capture camera + mic, switch devices live, constraints, mute,
// audio processing, screen sharing and speaker selection.
import { useState } from 'react';
import useLocalMedia, { VIDEO_PRESETS } from '../hooks/useLocalMedia.js';
import useDevices from '../hooks/useDevices.js';
import VideoTile from '../components/VideoTile.jsx';
import MicLevel from '../components/MicLevel.jsx';
import DeviceSelector from '../components/DeviceSelector.jsx';

// For seeing an OverconstrainedError on purpose: no webcam does 10000 px wide.
const IMPOSSIBLE_VIDEO = { width: { exact: 10000 } };

const PROCESSING = [
  ['echoCancellation', 'Echo cancellation (AEC)'],
  ['noiseSuppression', 'Noise suppression (NS)'],
  ['autoGainControl', 'Auto gain control (AGC)'],
];

const short = (id) => (id ? `${id.slice(0, 8)}…` : '-');

function SettingsList({ settings, keys }) {
  return (
    <dl className="settings-list">
      {keys.map(([key, fmt]) =>
        key in settings ? (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{fmt ? fmt(settings[key]) : String(settings[key])}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

const VIDEO_KEYS = [
  ['width'],
  ['height'],
  ['frameRate', (v) => v.toFixed(1)],
  ['aspectRatio', (v) => v.toFixed(3)],
  ['facingMode'],
  ['resizeMode'],
  ['displaySurface'],
  ['deviceId', short],
];
const AUDIO_KEYS = [
  ['echoCancellation'],
  ['noiseSuppression'],
  ['autoGainControl'],
  ['sampleRate'],
  ['channelCount'],
  ['latency', (v) => `${(v * 1000).toFixed(1)} ms`],
  ['deviceId', short],
];

export default function MediaLab() {
  const media = useLocalMedia();
  const { stream, tracks, error, status, screenSharing, prefs } = media;
  const devices = useDevices(stream);
  const [sinkId, setSinkId] = useState('');
  const busy = status === 'requesting';

  // The track objects are read at render time; `tracks` (state) is what triggers re-renders.
  const videoTrack = stream?.getVideoTracks()[0] ?? null;
  const audioTrack = stream?.getAudioTracks()[0] ?? null;
  const liveSnap = (kind) => tracks.find((t) => t.kind === kind && t.readyState === 'live');
  const videoSnap = liveSnap('video');
  const audioSnap = liveSnap('audio');

  const onDeviceChange = (kind, id) => {
    if (kind === 'speaker') setSinkId(id);
    else media.switchDevice(kind, id);
  };

  return (
    <div>
      <h1>Media Lab</h1>
      <p className="muted">Steps 3–4: getUserMedia, tracks, devices, constraints, screen sharing</p>

      <div className="toolbar">
        <button className="primary" onClick={() => media.start()} disabled={busy}>
          {stream ? 'Restart camera' : 'Start camera'}
        </button>
        <button onClick={media.stop} disabled={!stream && !busy}>
          Stop
        </button>
        <button onClick={() => media.start({ video: false })} disabled={busy}>
          Mic only
        </button>
        <button onClick={screenSharing ? media.stopScreenShare : media.startScreenShare} disabled={busy}>
          {screenSharing ? 'Stop sharing' : 'Share screen'}
        </button>
        <button onClick={() => media.start({ video: IMPOSSIBLE_VIDEO, audio: false })} disabled={busy}>
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
          <VideoTile
            stream={stream}
            muted
            mirrored={!screenSharing} // never mirror a screen: text would be backwards
            sinkId={sinkId}
            label={screenSharing ? 'Screen (not mirrored)' : 'Local preview (muted, mirrored)'}
            placeholder={stream && videoSnap && !videoSnap.enabled ? 'Camera off (track.enabled = false)' : null}
          />
          <MicLevel track={audioTrack} />

          <div className="toolbar toggles">
            <button onClick={() => media.toggleEnabled('audio')} disabled={!audioTrack} aria-pressed={audioSnap ? !audioSnap.enabled : false}>
              {audioSnap && !audioSnap.enabled ? '🔇 Unmute mic' : '🎤 Mute mic'}
            </button>
            <button onClick={() => media.toggleEnabled('video')} disabled={!videoTrack} aria-pressed={videoSnap ? !videoSnap.enabled : false}>
              {videoSnap && !videoSnap.enabled ? '📷 Camera on' : '🚫 Camera off'}
            </button>
          </div>

          <div className="card">
            <h2>Resolution</h2>
            <div className="toolbar">
              {Object.keys(VIDEO_PRESETS).map((p) => (
                <button
                  key={p}
                  className={prefs.preset === p ? 'primary' : undefined}
                  onClick={() => media.setVideoPreset(p)}
                  disabled={screenSharing}
                >
                  {p}
                </button>
              ))}
            </div>
            <p className="muted small">
              Asked for <code>{JSON.stringify(VIDEO_PRESETS[prefs.preset])}</code>
              {videoSnap && !screenSharing && (
                <>
                  {' '}
                  → got{' '}
                  <strong>
                    {videoSnap.settings.width}×{videoSnap.settings.height} @ {Math.round(videoSnap.settings.frameRate)} fps
                  </strong>
                </>
              )}
            </p>

            <h2>Audio processing</h2>
            {PROCESSING.map(([key, label]) => (
              <label key={key} className="checkbox">
                <input
                  type="checkbox"
                  checked={prefs.processing[key]}
                  onChange={(e) => media.setAudioProcessing({ [key]: e.target.checked })}
                />{' '}
                {label}
                {audioSnap && key in audioSnap.settings && (
                  <span className="muted small"> (actual: {String(audioSnap.settings[key])})</span>
                )}
              </label>
            ))}
          </div>
        </div>

        <div>
          <DeviceSelector
            cameras={devices.cameras}
            mics={devices.mics}
            speakers={devices.speakers}
            hasLabels={devices.hasLabels}
            selected={{
              video: videoSnap && !screenSharing ? videoSnap.settings.deviceId : prefs.videoDeviceId,
              audio: audioSnap ? audioSnap.settings.deviceId : prefs.audioDeviceId,
              speaker: sinkId,
            }}
            onChange={onDeviceChange}
            cameraDisabled={screenSharing}
          />

          <div className="card">
            <h2>What I actually got (getSettings)</h2>
            {!videoSnap && !audioSnap && <p className="muted">Nothing live.</p>}
            {videoSnap && (
              <>
                <h3>{screenSharing ? 'Screen' : 'Video'}</h3>
                <SettingsList settings={videoSnap.settings} keys={VIDEO_KEYS} />
              </>
            )}
            {audioSnap && (
              <>
                <h3>Audio</h3>
                <SettingsList settings={audioSnap.settings} keys={AUDIO_KEYS} />
              </>
            )}
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
    </div>
  );
}
