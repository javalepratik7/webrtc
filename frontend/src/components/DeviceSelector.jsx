// Camera / mic / speaker dropdowns.
// Presentational: the device lists come from useDevices(); changes go up via onChange(kind, deviceId).
import { useState } from 'react';

// setSinkId (choose the output device of a media element) isn't everywhere (e.g. iOS Safari).
export const SINK_SUPPORTED = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

// Plays a 0.6 s beep on a specific speaker. Our local preview is muted (no echo),
// so without this you'd have no way to hear which speaker is selected.
async function playTestTone(sinkId) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const dest = ctx.createMediaStreamDestination(); // Web Audio → MediaStream
  osc.frequency.value = 440;
  gain.gain.value = 0.2;
  osc.connect(gain).connect(dest);

  const audio = new Audio();
  audio.srcObject = dest.stream;
  if (SINK_SUPPORTED) await audio.setSinkId(sinkId); // '' = system default
  await audio.play();
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
  osc.onended = () => {
    audio.srcObject = null;
    ctx.close();
  };
}

function DeviceSelect({ label, devices, value, onChange, fallbackName, disabled }) {
  return (
    <label className="device-select">
      <span className="muted small">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || devices.length === 0}>
        <option value="">Default</option>
        {devices
          // Chrome lists "default"/"communications" pseudo-devices. Our "" already means default.
          .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${fallbackName} ${i + 1}`}
            </option>
          ))}
      </select>
    </label>
  );
}

export default function DeviceSelector({ cameras, mics, speakers, hasLabels, selected, onChange, cameraDisabled }) {
  const [toneError, setToneError] = useState(null);

  const test = async () => {
    setToneError(null);
    try {
      await playTestTone(selected.speaker);
    } catch (err) {
      setToneError(`${err.name}: ${err.message}`);
    }
  };

  return (
    <div className="card device-selector">
      <h2>Devices</h2>
      {!hasLabels && (
        <p className="muted small">
          Device names are hidden until you grant camera/mic permission. Press “Start camera” first.
        </p>
      )}
      <div className="device-grid">
        <DeviceSelect
          label="Camera"
          devices={cameras}
          value={selected.video}
          onChange={(id) => onChange('video', id)}
          fallbackName="Camera"
          disabled={!hasLabels || cameraDisabled}
        />
        <DeviceSelect
          label="Microphone"
          devices={mics}
          value={selected.audio}
          onChange={(id) => onChange('audio', id)}
          fallbackName="Microphone"
          disabled={!hasLabels}
        />
        <div className="device-select">
          <DeviceSelect
            label="Speaker"
            devices={speakers}
            value={selected.speaker}
            onChange={(id) => onChange('speaker', id)}
            fallbackName="Speaker"
            disabled={!SINK_SUPPORTED}
          />
          <button onClick={test}>Play test tone</button>
        </div>
      </div>
      {!SINK_SUPPORTED && (
        <p className="muted small">This browser doesn’t support setSinkId: audio always plays on the system default output.</p>
      )}
      {SINK_SUPPORTED && speakers.length === 0 && (
        <p className="muted small">No speakers listed (Firefox only lists outputs after selectAudioOutput()).</p>
      )}
      {toneError && <p className="err small">{toneError}</p>}
    </div>
  );
}
