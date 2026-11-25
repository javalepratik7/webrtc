// Mute mic / camera off / switch camera / stats / hang up.
// Presentational: state comes from the local tracks, actions are callbacks.
// onToggleStats is optional (no Stats button without it); hangUpLabel defaults to "Hang up".
export default function CallControls({
  micOn,
  camOn,
  hasMic,
  hasCam,
  canSwitchCamera,
  statsOn,
  onToggleMic,
  onToggleCam,
  onSwitchCamera,
  onToggleStats,
  onHangUp,
  hangUpLabel = 'Hang up',
}) {
  return (
    <div className="call-controls" role="toolbar" aria-label="Call controls">
      <button onClick={onToggleMic} disabled={!hasMic} aria-pressed={!micOn} title="track.enabled = false: sends silence, mic stays open">
        {micOn ? '🎤 Mute' : '🔇 Unmute'}
      </button>
      <button onClick={onToggleCam} disabled={!hasCam} aria-pressed={!camOn} title="track.enabled = false: sends black frames, camera stays open">
        {camOn ? '📷 Camera off' : '🚫 Camera on'}
      </button>
      <button onClick={onSwitchCamera} disabled={!hasCam || !canSwitchCamera} title="Next camera, via sender.replaceTrack (no renegotiation)">
        🔄 Switch camera
      </button>
      {onToggleStats && (
        <button onClick={onToggleStats} aria-pressed={statsOn} title="getStats() every 2 s">
          📊 Stats
        </button>
      )}
      <button className="hangup" onClick={onHangUp}>
        📞 {hangUpLabel}
      </button>
    </div>
  );
}
