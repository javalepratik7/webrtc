// One person in the video grid: video, name, 🔇 when their mic is off, a
// placeholder when their camera is off, a green border while they speak.
//
//   <ParticipantTile id name stream isLocal micOn camOn speaking levelBars connection mirrored />
//
// Re-render rules (so the <video> never flickers or reattaches):
//   - memo(): the grid re-renders 4× a second (audio levels). A tile only
//     re-renders when ITS props change, and every prop is a primitive or a
//     stable object (`stream` is the same MediaStream for the whole connection).
//   - The <video> element is ALWAYS rendered (inside VideoTile). Camera off puts a
//     placeholder ON TOP of it instead of unmounting it, so turning the camera
//     back on needs no new element, no new srcObject, no play() again.
//   - VideoTile sets srcObject in an effect that depends on [stream] only.
import { memo } from 'react';
import VideoTile from './VideoTile.jsx';

const initials = (name) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function ParticipantTile({ name, stream, isLocal = false, micOn, camOn, speaking, levelBars = 0, connection, mirrored = false }) {
  const connecting = !isLocal && connection !== 'connected';
  let placeholder = null;
  if (!camOn || !stream) {
    placeholder = (
      <span className="tile-avatar" aria-label={`${name}: camera off`}>
        {initials(name) || '?'}
        <small>{!stream ? (isLocal ? 'no camera' : 'no video yet') : 'camera off'}</small>
      </span>
    );
  }

  return (
    <VideoTile
      stream={stream}
      muted={isLocal} // never play your own mic back; remote tiles play their audio
      mirrored={mirrored}
      className={`participant-tile${speaking ? ' speaking' : ''}`}
      label={isLocal ? `${name} (you)` : name}
      placeholder={placeholder}
    >
      {!micOn && (
        <span className="tile-muted" title="Microphone off" aria-label="microphone off">
          🔇
        </span>
      )}
      {micOn && levelBars > 0 && (
        <span className="tile-level" aria-hidden="true">
          {[1, 2, 3, 4].map((b) => (
            <i key={b} className={b <= levelBars ? 'on' : undefined} />
          ))}
        </span>
      )}
      {connecting && <span className="tile-status">{connection === 'none' ? 'waiting…' : connection}</span>}
    </VideoTile>
  );
}

export default memo(ParticipantTile);
