// Live microphone level meter, built with the Web Audio API.
//
//   mic track ─▶ MediaStreamAudioSourceNode ─▶ AnalyserNode   (NOT connected to the speakers)
//
// Takes a TRACK, not a stream: createMediaStreamSource() locks onto the audio
// track the stream had at creation time and ignores later swaps. Keying the
// effect on the track rebuilds the graph whenever the mic is switched.
//
// Every animation frame we read the raw waveform samples from the analyser,
// compute their RMS (average loudness), convert to decibels and draw a bar.
// The bar is updated directly through a ref instead of React state, because
// re-rendering 60 times per second for a progress bar would be wasteful.
import { useEffect, useRef } from 'react';

const MIN_DB = -60; // treat anything quieter than this as silence

export default function MicLevel({ track }) {
  const barRef = useRef(null);
  const textRef = useRef(null);
  const hasAudio = Boolean(track);

  useEffect(() => {
    if (!track) return undefined;

    const ctx = new AudioContext();
    // Autoplay policy: a context can start "suspended". We're created right after
    // the Start click (a user gesture), so resume() is allowed.
    if (ctx.state === 'suspended') ctx.resume();

    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024; // the frame size we read: 1024 samples ≈ 21 ms at 48 kHz
    source.connect(analyser);
    // Deliberately NOT analyser.connect(ctx.destination): that would play the mic
    // through the speakers and cause feedback/echo.

    const samples = new Float32Array(analyser.fftSize);
    let rafId;

    const draw = () => {
      analyser.getFloatTimeDomainData(samples); // values in [-1, 1]
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
      const rms = Math.sqrt(sumSquares / samples.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity; // 0 dBFS = maximum
      const level = Math.min(1, Math.max(0, (db - MIN_DB) / -MIN_DB)); // map [-60, 0] dB → [0, 1]

      if (barRef.current) {
        barRef.current.style.width = `${(level * 100).toFixed(1)}%`;
        barRef.current.dataset.hot = level > 0.85 ? 'true' : 'false';
      }
      if (textRef.current) textRef.current.textContent = Number.isFinite(db) ? `${db.toFixed(0)} dB` : '-∞ dB';
      rafId = requestAnimationFrame(draw);
    };
    draw();

    // Cleanup: stop the loop and close the context. Closing the context does NOT
    // stop the mic track (the hook owns that); it only frees the audio graph.
    return () => {
      cancelAnimationFrame(rafId);
      source.disconnect();
      ctx.close();
      if (barRef.current) barRef.current.style.width = '0%';
      if (textRef.current) textRef.current.textContent = '';
    };
  }, [track]);

  return (
    <div className="mic-level">
      <span className="muted">Mic</span>
      <div className="mic-level-track">
        <div ref={barRef} className="mic-level-bar" style={{ width: 0 }} />
      </div>
      {/* Written imperatively by the draw loop, so React must never render children into it. */}
      <span ref={textRef} className="mic-level-text muted" hidden={!hasAudio} />
      {!hasAudio && <span className="mic-level-text muted">no audio</span>}
    </div>
  );
}
