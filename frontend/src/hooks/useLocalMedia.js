// Owns the local camera/mic (and screen) MediaStream.
//
//   const media = useLocalMedia();
//   media.start({ video: true, audio: true })  // true = "use my current preferences"
//   media.stop()
//   media.switchDevice('video' | 'audio', deviceId)   // live, replaces the track in the stream
//   media.setVideoPreset('360p' | '720p' | '1080p')  // live, via applyConstraints
//   media.setAudioProcessing({ echoCancellation, noiseSuppression, autoGainControl })
//   media.toggleEnabled('video' | 'audio')           // mute / camera off (track.enabled)
//   media.startScreenShare() / media.stopScreenShare()
//
// State: stream, tracks (plain snapshots incl. getSettings()), error, status,
//        screenSharing, prefs.
//
// Design: ONE MediaStream object lives for the whole session. Switching camera,
// mic or screen removes the old track from it and adds the new one, which is
// exactly what we'll do on the RTCPeerConnection later with sender.replaceTrack().
// All tracks are stopped automatically on unmount.
import { useCallback, useEffect, useRef, useState } from 'react';
import useLog from './useLog.js';

// `ideal` = what we'd like, `max` = never more than this. Together: "720p, or
// the closest thing below it". (Only exact/min/max can fail; ideal never does.)
export const VIDEO_PRESETS = {
  '360p': { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 } },
  '720p': { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } },
  '1080p': { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } },
};

const DEFAULT_PREFS = {
  videoDeviceId: '', // '' = let the browser choose
  audioDeviceId: '',
  preset: '720p',
  processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

const ERROR_HINTS = {
  NotAllowedError:
    'Permission denied. You (or the browser/OS) blocked access. Click the camera icon in the address bar to allow it, then try again.',
  NotFoundError: 'No matching device. There is no camera/microphone, or it is disabled in the OS.',
  NotReadableError:
    'The device exists but could not be opened. Another app (Zoom, OBS, another browser) is probably using it, or there is a hardware/driver problem.',
  OverconstrainedError:
    'No device can satisfy the constraints (e.g. an `exact` resolution or deviceId that does not exist).',
  SecurityError: 'Media access is disabled on this page (insecure context or a Permissions-Policy).',
  AbortError: 'The request was aborted by the browser for an unspecified reason.',
  TypeError: 'Invalid constraints: at least one of audio/video must be requested.',
};

function describeError(err, context) {
  const name = err?.name || 'Error';
  let message = err?.message || String(err);
  if (name === 'OverconstrainedError' && err.constraint) {
    message = `Constraint "${err.constraint}" cannot be satisfied. ${message}`;
  }
  let hint = ERROR_HINTS[name] || 'Unexpected error, see the console.';
  if (context === 'screen' && name === 'NotAllowedError') {
    hint = 'Screen sharing was cancelled in the picker (or blocked). Nothing changed.';
  }
  return { name, message, hint };
}

// Track objects are mutable browser objects React can't observe, so we copy what
// we display (including getSettings(), i.e. what we ACTUALLY got) into plain objects.
function snapshot(stream) {
  if (!stream) return [];
  return stream.getTracks().map((t) => ({
    id: t.id,
    kind: t.kind,
    label: t.label,
    readyState: t.readyState,
    enabled: t.enabled,
    muted: t.muted,
    settings: { ...t.getSettings() },
  }));
}

function stopAll(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

function buildVideo(prefs) {
  return {
    ...VIDEO_PRESETS[prefs.preset],
    frameRate: { ideal: 30 },
    ...(prefs.videoDeviceId && { deviceId: { exact: prefs.videoDeviceId } }),
  };
}

function buildAudio(prefs) {
  return {
    ...prefs.processing,
    ...(prefs.audioDeviceId && { deviceId: { exact: prefs.audioDeviceId } }),
  };
}

// getUserMedia for ONE kind, returning just the track.
async function getTrack(kind, constraints) {
  const s = await navigator.mediaDevices.getUserMedia({ [kind]: constraints });
  return s.getTracks()[0];
}

export default function useLocalMedia() {
  const { log } = useLog();
  const [stream, setStream] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('idle'); // 'idle' | 'requesting' | 'live'
  const [screenSharing, setScreenSharing] = useState(false);
  const [prefs, setPrefsState] = useState(DEFAULT_PREFS);

  // Refs hold the CURRENT values for async code and cleanup (state would be stale in closures).
  const streamRef = useRef(null);
  const prefsRef = useRef(DEFAULT_PREFS);
  // Bumped by start/stop/unmount. Async work that finishes after its id is outdated
  // must stop whatever it acquired, or the device stays on with nobody owning it.
  const requestIdRef = useRef(0);
  // While screen sharing: { track, hadCamera, cameraEnabled } to restore the camera afterwards.
  const screenRef = useRef(null);

  const setPrefs = useCallback((patch) => {
    prefsRef.current = { ...prefsRef.current, ...patch };
    setPrefsState(prefsRef.current);
  }, []);

  // Re-read the tracks after any change (the stream object itself stays the same).
  const refresh = useCallback(() => setTracks(snapshot(streamRef.current)), []);

  const fail = useCallback(
    (err, context) => {
      const info = describeError(err, context);
      setError(info);
      log(`${info.name}: ${info.message}`, 'error');
    },
    [log],
  );

  const currentTrack = (kind) => streamRef.current?.getTracks().find((t) => t.kind === kind) ?? null;

  // ---- start / stop -------------------------------------------------------

  const stop = useCallback(() => {
    requestIdRef.current++;
    screenRef.current = null;
    setScreenSharing(false);
    const current = streamRef.current;
    if (!current) {
      setStatus('idle');
      return;
    }
    stopAll(current);
    streamRef.current = null;
    setTracks(snapshot(current)); // track.stop() doesn't fire 'ended': snapshot shows "ended" now
    setStream(null);
    setStatus('idle');
    log('Stopped all tracks (devices released)', 'success');
  }, [log]);

  const start = useCallback(
    async ({ video = true, audio = true } = {}) => {
      if (streamRef.current) {
        stopAll(streamRef.current);
        streamRef.current = null;
        setStream(null);
      }
      screenRef.current = null;
      setScreenSharing(false);
      const p = prefsRef.current;
      const constraints = {
        video: video === true ? buildVideo(p) : video,
        audio: audio === true ? buildAudio(p) : audio,
      };
      const myRequest = ++requestIdRef.current;
      setError(null);
      setStatus('requesting');
      log(`getUserMedia(${JSON.stringify(constraints)})`);

      try {
        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (myRequest !== requestIdRef.current) {
          stopAll(newStream);
          log('Discarded a stream that arrived after it was no longer wanted', 'warn');
          return;
        }
        streamRef.current = newStream;
        setStream(newStream);
        refresh();
        setStatus('live');
        const summary = newStream
          .getTracks()
          .map((t) => `${t.kind}: "${t.label}"`)
          .join(', ');
        log(`Got MediaStream ${newStream.id.slice(0, 8)}… with ${summary}`, 'success');
      } catch (err) {
        if (myRequest !== requestIdRef.current) return;
        setStatus('idle');
        fail(err);
      }
    },
    [log, fail, refresh],
  );

  // ---- replacing a track inside the stream -------------------------------

  // Get a new track of `kind` and swap it into the stream in place of the old one.
  // Returns true on success. Throws on getUserMedia errors.
  // releaseFirst: stop the old track BEFORE opening the new one. Needed when
  // changing audio processing: while the old track is open, Chrome may hand back
  // the same underlying source with its OLD echoCancellation/NS/AGC settings.
  const replaceTrack = useCallback(
    async (kind, constraints, { releaseFirst = false } = {}) => {
      const target = streamRef.current;
      if (!target) return false;
      const myRequest = requestIdRef.current;
      const old = currentTrack(kind);
      if (old && releaseFirst) old.stop();

      let fresh;
      try {
        // Try to open the new device BEFORE releasing the old one, so a failure
        // leaves the user with a working camera/mic.
        fresh = await getTrack(kind, constraints);
      } catch (err) {
        // Many phones can't open two cameras at once → NotReadableError.
        // Fallback: release the old one first, then retry.
        if (old && !releaseFirst && err.name === 'NotReadableError') {
          log(`Couldn't open a second ${kind} device while the first is open; releasing it and retrying`, 'warn');
          old.stop();
          fresh = await getTrack(kind, constraints);
        } else {
          throw err;
        }
      }

      if (myRequest !== requestIdRef.current || streamRef.current !== target) {
        fresh.stop(); // stop()/start()/unmount happened meanwhile
        return false;
      }

      fresh.enabled = old ? old.enabled : true; // keep "muted"/"camera off" across switches
      if (old) {
        target.removeTrack(old);
        old.stop();
      }
      target.addTrack(fresh);
      refresh();
      log(`Replaced ${kind} track → "${fresh.label}"`, 'success');
      return true;
    },
    [log, refresh],
  );

  // ---- public controls -----------------------------------------------------

  const switchDevice = useCallback(
    async (kind, deviceId) => {
      setPrefs(kind === 'video' ? { videoDeviceId: deviceId } : { audioDeviceId: deviceId });
      // No stream yet, or the video slot is busy with the screen: just remember it for later.
      if (!streamRef.current || (kind === 'video' && screenRef.current)) return;
      const constraints = kind === 'video' ? buildVideo(prefsRef.current) : buildAudio(prefsRef.current);
      setError(null);
      try {
        await replaceTrack(kind, constraints);
      } catch (err) {
        fail(err);
      }
    },
    [setPrefs, replaceTrack, fail],
  );

  const setVideoPreset = useCallback(
    async (preset) => {
      const previous = prefsRef.current.preset;
      setPrefs({ preset });
      const track = currentTrack('video');
      if (!track || screenRef.current) return; // applied on next start / after screen share
      setError(null);
      try {
        // No new getUserMedia needed: the same track is reconfigured in place.
        await track.applyConstraints(buildVideo(prefsRef.current));
        const s = track.getSettings();
        log(`applyConstraints(${preset}) → got ${s.width}×${s.height} @ ${Math.round(s.frameRate)} fps`, 'success');
      } catch (err) {
        setPrefs({ preset: previous });
        fail(err);
      }
      refresh();
    },
    [setPrefs, log, fail, refresh],
  );

  const setAudioProcessing = useCallback(
    async (patch) => {
      setPrefs({ processing: { ...prefsRef.current.processing, ...patch } });
      const track = currentTrack('audio');
      if (!track) return;
      const wanted = prefsRef.current.processing;
      setError(null);
      try {
        await track.applyConstraints(buildAudio(prefsRef.current));
        // Some browsers resolve applyConstraints without actually changing audio
        // processing on a live track. Verify with getSettings(); if it didn't stick,
        // reopen the mic with the new constraints instead.
        const s = track.getSettings();
        const notApplied = Object.keys(wanted).filter((k) => k in s && s[k] !== wanted[k]);
        if (notApplied.length) {
          log(`applyConstraints didn't change ${notApplied.join(', ')}; reopening the mic`, 'warn');
          await replaceTrack('audio', buildAudio(prefsRef.current), { releaseFirst: true });
        } else {
          log(`applyConstraints(${JSON.stringify(patch)}) applied on the live mic track`, 'success');
        }
      } catch (err) {
        fail(err);
      }
      refresh();
    },
    [setPrefs, replaceTrack, log, fail, refresh],
  );

  const toggleEnabled = useCallback(
    (kind) => {
      const track = currentTrack(kind);
      if (!track) return;
      // enabled=false: the track keeps running and the device stays open, but it
      // produces black frames / silence. Instant and reversible (unlike stop()).
      track.enabled = !track.enabled;
      log(`${kind} track enabled = ${track.enabled}`);
      refresh();
    },
    [log, refresh],
  );

  const stopScreenShare = useCallback(async () => {
    const share = screenRef.current;
    if (!share) return;
    screenRef.current = null;
    setScreenSharing(false);
    const target = streamRef.current;
    share.track.stop();
    target?.removeTrack(share.track);
    log('Screen sharing stopped');

    if (target && share.hadCamera) {
      try {
        const myRequest = requestIdRef.current;
        const cam = await getTrack('video', buildVideo(prefsRef.current));
        if (myRequest !== requestIdRef.current || streamRef.current !== target) {
          cam.stop();
          return;
        }
        cam.enabled = share.cameraEnabled;
        target.addTrack(cam);
        log(`Camera restored → "${cam.label}"`, 'success');
      } catch (err) {
        fail(err);
      }
    }

    // A screen-only session that ended leaves an empty stream: treat as stopped.
    if (target && target.getTracks().length === 0) {
      streamRef.current = null;
      setStream(null);
      setStatus('idle');
    }
    refresh();
  }, [log, fail, refresh]);

  const startScreenShare = useCallback(async () => {
    if (screenRef.current) return;
    if (!navigator.mediaDevices.getDisplayMedia) {
      setError({ name: 'NotSupportedError', message: 'getDisplayMedia is not available', hint: 'This browser (most mobile browsers) cannot share the screen.' });
      return;
    }
    setError(null);
    const myRequest = requestIdRef.current;
    let display;
    try {
      // Must be called from a click. The browser shows its own picker (screen/window/tab).
      display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    } catch (err) {
      fail(err, 'screen');
      return;
    }
    const screenTrack = display.getVideoTracks()[0];
    if (myRequest !== requestIdRef.current) {
      screenTrack.stop();
      return;
    }
    // Hint to encoders (later): favour sharp text over smooth motion.
    screenTrack.contentHint = 'detail';

    let target = streamRef.current;
    if (!target) {
      target = new MediaStream();
      streamRef.current = target;
      setStream(target);
      setStatus('live');
    }
    const cam = currentTrack('video');
    if (cam) {
      target.removeTrack(cam);
      cam.stop(); // release the camera while sharing (light off); we reopen it afterwards
    }
    target.addTrack(screenTrack);
    screenRef.current = { track: screenTrack, hadCamera: Boolean(cam), cameraEnabled: cam?.enabled ?? true };
    setScreenSharing(true);

    // The browser's own "Stop sharing" bar (or closing the shared window) ends the
    // track from OUTSIDE our UI. That fires 'ended'. React to it like our own button.
    screenTrack.addEventListener(
      'ended',
      () => {
        if (screenRef.current?.track === screenTrack) {
          log('Screen track ended (browser "Stop sharing" or window closed)', 'warn');
          stopScreenShare();
        }
      },
      { once: true },
    );

    const s = screenTrack.getSettings();
    log(`Sharing "${screenTrack.label}" (${s.displaySurface ?? 'surface?'}, ${s.width}×${s.height})`, 'success');
    refresh();
  }, [log, fail, refresh, stopScreenShare]);

  // ---- keep the table in sync with events from outside our code -----------

  // Tracks change while the stream object stays the same, so key on the track ids.
  const trackKey = tracks.map((t) => t.id).join(',');
  useEffect(() => {
    if (!stream) return undefined;
    const onEvent = (e) => {
      log(`Track ${e.target.kind} "${e.target.label}": ${e.type}`, e.type === 'ended' ? 'warn' : 'info');
      refresh();
    };
    const events = ['ended', 'mute', 'unmute'];
    const list = stream.getTracks();
    list.forEach((t) => events.forEach((ev) => t.addEventListener(ev, onEvent)));
    return () => list.forEach((t) => events.forEach((ev) => t.removeEventListener(ev, onEvent)));
  }, [stream, trackKey, log, refresh]);

  // Unmount: release everything. (StrictMode's fake unmount in dev runs this once
  // right after mount. Harmless, nothing has been started yet.)
  useEffect(() => {
    return () => {
      requestIdRef.current++;
      stopAll(streamRef.current);
      streamRef.current = null;
      screenRef.current = null;
    };
  }, []);

  return {
    stream,
    tracks,
    error,
    status,
    screenSharing,
    prefs,
    start,
    stop,
    switchDevice,
    setVideoPreset,
    setAudioProcessing,
    toggleEnabled,
    startScreenShare,
    stopScreenShare,
  };
}
