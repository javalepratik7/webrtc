// Owns the local camera/mic MediaStream.
//
//   const { stream, tracks, error, status, start, stop } = useLocalMedia();
//
// - start(constraints): calls getUserMedia (stopping any previous stream first)
// - stop(): stops every track, which releases the device (camera light goes off)
// - tracks: a plain-object SNAPSHOT of each track (kind, label, readyState, enabled...)
// - error: { name, message, hint } or null
// - status: 'idle' | 'requesting' | 'live'
//
// All tracks are stopped automatically when the component using the hook unmounts.
import { useCallback, useEffect, useRef, useState } from 'react';
import useLog from './useLog.js';

// What each getUserMedia error name means, in plain words.
const ERROR_HINTS = {
  NotAllowedError:
    'Permission denied. You (or the browser/OS) blocked camera/mic access. Click the camera icon in the address bar to allow it, then try again.',
  NotFoundError:
    'No matching device. There is no camera/microphone, or it is disabled in the OS.',
  NotReadableError:
    'The device exists but could not be opened. Another app (Zoom, OBS, another browser) is probably using it, or there is a hardware/driver problem.',
  OverconstrainedError:
    'No device can satisfy the constraints (e.g. an `exact` resolution or deviceId that does not exist).',
  SecurityError: 'Media access is disabled on this page (insecure context or a Permissions-Policy).',
  AbortError: 'The request was aborted by the browser for an unspecified reason.',
  TypeError: 'Invalid constraints: at least one of audio/video must be requested.',
};

function describeError(err) {
  const name = err?.name || 'Error';
  let message = err?.message || String(err);
  // OverconstrainedError tells you WHICH constraint failed.
  if (name === 'OverconstrainedError' && err.constraint) {
    message = `Constraint "${err.constraint}" cannot be satisfied. ${message}`;
  }
  return { name, message, hint: ERROR_HINTS[name] || 'Unexpected error, see the console.' };
}

// MediaStreamTrack objects are mutable browser objects: React can't see
// track.readyState change. So we copy the fields we display into plain objects
// and re-snapshot whenever something happens.
function snapshot(stream) {
  if (!stream) return [];
  return stream.getTracks().map((t) => ({
    id: t.id,
    kind: t.kind,
    label: t.label,
    readyState: t.readyState,
    enabled: t.enabled,
    muted: t.muted,
  }));
}

function stopAll(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export default function useLocalMedia() {
  const { log } = useLog();
  const [stream, setStream] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('idle');

  // Refs, not state, because cleanup code needs the CURRENT values synchronously.
  const streamRef = useRef(null);
  // Incremented by every start/stop/unmount. A getUserMedia call that resolves
  // after its number is outdated must throw its stream away (see stop() and the
  // unmount cleanup), otherwise the camera stays on with nobody owning it.
  const requestIdRef = useRef(0);

  const stop = useCallback(() => {
    requestIdRef.current++; // cancel any in-flight start()
    const current = streamRef.current;
    if (!current) {
      setStatus('idle');
      return;
    }
    stopAll(current);
    streamRef.current = null;
    // track.stop() does NOT fire 'ended', so snapshot manually: the table now shows readyState "ended".
    setTracks(snapshot(current));
    setStream(null);
    setStatus('idle');
    log('Stopped all tracks (devices released)', 'success');
  }, [log]);

  const start = useCallback(
    async (constraints) => {
      // Release the previous stream first (also needed on some phones,
      // which can't open the same camera twice).
      if (streamRef.current) {
        stopAll(streamRef.current);
        streamRef.current = null;
        setStream(null);
      }
      const myRequest = ++requestIdRef.current;
      setError(null);
      setStatus('requesting');
      log(`getUserMedia(${JSON.stringify(constraints)})`);

      try {
        const newStream = await navigator.mediaDevices.getUserMedia(constraints);

        if (myRequest !== requestIdRef.current) {
          // stop() was pressed, start() was called again, or we unmounted while
          // the permission prompt was open. Nobody wants this stream anymore.
          stopAll(newStream);
          log('Discarded a stream that arrived after it was no longer wanted', 'warn');
          return;
        }

        streamRef.current = newStream;
        setStream(newStream);
        setTracks(snapshot(newStream));
        setStatus('live');
        const summary = newStream
          .getTracks()
          .map((t) => `${t.kind}: "${t.label}"`)
          .join(', ');
        log(`Got MediaStream ${newStream.id.slice(0, 8)}… with ${summary}`, 'success');
      } catch (err) {
        if (myRequest !== requestIdRef.current) return; // outdated: ignore
        const info = describeError(err);
        setError(info);
        setStatus('idle');
        log(`${info.name}: ${info.message}`, 'error');
      }
    },
    [log],
  );

  // Keep the track table in sync with things that happen OUTSIDE our code:
  // unplugging the camera or revoking permission fires 'ended'; the OS
  // pausing a device fires 'mute' / 'unmute'.
  useEffect(() => {
    if (!stream) return undefined;
    const refresh = (e) => {
      log(`Track ${e.target.kind} "${e.target.label}": ${e.type}`, e.type === 'ended' ? 'warn' : 'info');
      setTracks(snapshot(stream));
    };
    const events = ['ended', 'mute', 'unmute'];
    const list = stream.getTracks();
    list.forEach((t) => events.forEach((ev) => t.addEventListener(ev, refresh)));
    return () => list.forEach((t) => events.forEach((ev) => t.removeEventListener(ev, refresh)));
  }, [stream, log]);

  // Unmount (navigating away from the page): release the devices.
  // In StrictMode dev this cleanup also runs once right after the first mount.
  // That's harmless: nothing has started yet, so it just bumps requestId.
  useEffect(() => {
    return () => {
      requestIdRef.current++;
      stopAll(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  return { stream, tracks, error, status, start, stop };
}
