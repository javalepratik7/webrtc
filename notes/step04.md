# Step 4: Devices & controls

Theory: `Webrtc.md` §4.1 (getUserMedia, constraints, enumerateDevices, getDisplayMedia),
§13.1 (MediaStreamTrack), §13.5 (audio processing pipeline).

## What I built

| File | Role |
| ---- | ---- |
| `hooks/useLocalMedia.js` | + `switchDevice`, `setVideoPreset`, `setAudioProcessing`, `toggleEnabled`, `startScreenShare`/`stopScreenShare`, `prefs` |
| `hooks/useDevices.js` | `enumerateDevices()` → cameras / mics / speakers, refreshed on `devicechange` and after permission |
| `components/DeviceSelector.jsx` | Camera / mic / speaker dropdowns + "Play test tone" on the chosen speaker |
| `components/VideoTile.jsx` | + `sinkId` prop (`setSinkId`) and a placeholder overlay |
| `components/MicLevel.jsx` | Now takes a **track**, not a stream (see below) |
| `pages/MediaLab.jsx` | Toggles, resolution presets, processing checkboxes, `getSettings()` panel |

## One stream, swapped tracks

The hook keeps **one MediaStream** for the whole session. Switching camera/mic/screen:

1. `getUserMedia({ video: { deviceId: { exact: id }, ...preset } })` → a new track
2. `stream.removeTrack(old)`, `old.stop()`, `stream.addTrack(new)`
3. Copy `enabled` over, so "muted" stays muted after a switch

- The `<video>` follows track changes inside its `srcObject` automatically, with no re-assignment needed.
- **Web Audio doesn't**: `createMediaStreamSource(stream)` locks onto the audio track that
  existed *at creation time*. So `MicLevel` takes the audio track as a prop and rebuilds its
  graph when the track changes.
- React can't see a mutation *inside* the stream (same object), so after each swap the hook
  re-snapshots the tracks, and that state change drives the re-render. The track-event effect is
  keyed on the track ids for the same reason.
- This is a rehearsal for step 10: in a call you'll do `sender.replaceTrack(newTrack)` on the
  RTCPeerConnection. Same idea, and no renegotiation needed.
- **Order matters on phones**: open the new camera *before* stopping the old one (so a failure
  leaves you with a working camera). But many phones can't open two cameras at once and throw
  `NotReadableError`. The hook then falls back to stop-old-then-retry.

## Why device labels are empty before permission

`enumerateDevices()` before any camera/mic permission returns, in Chrome:

```json
[["audioinput","",""], ["videoinput","",""], ["audiooutput","",""]]
```

At most one entry per kind, with **empty `deviceId` and empty `label`**. That's **fingerprinting
protection** (§12.5). The list of your devices ("Logitech C920", "AirPods Pro – Pratik's", a
specific audio interface), plus stable device IDs, would make you identifiable across sites
without asking. Exposing it would be a tracking signal any page could read silently.
So the browser only reveals details after you've trusted the origin with real device access.

- After permission: full list, real labels, and `deviceId`s that are **per-origin** (and reset
  when you clear site data), so they can't be correlated across sites either.
- `devicechange` doesn't reliably fire when permission is granted, so `useDevices` also
  re-enumerates when the stream changes.
- Typical flow in real apps: request a stream first (or a "preview" screen), *then* show device pickers.

## Resolution: constraints vs settings

- Presets use `{ ideal, max }`: "this size, or the closest below it". `ideal` alone could pick
  something **bigger** if it's a closer match. `exact` fails with `OverconstrainedError` if impossible.
- Changing a preset uses `track.applyConstraints()` on the **live** track, with no new getUserMedia.
- **Constraints are a request; `track.getSettings()` is the truth.** The panel shows both.
- Chrome may scale/crop in software to hit your request (`resizeMode: "crop-and-scale"`), so
  you can get 640×360 from a camera that has no 640×360 native mode. `resizeMode: "none"` means native frames.
- `track.getCapabilities()` gives the ranges a device supports (widths, frame rates, facing modes).

## Mute vs camera off vs stop

| | `track.enabled = false` | `track.stop()` |
| - | - | - |
| What you see | Black frames / silence | Track is gone (`readyState: "ended"`) |
| Device / camera light | **Still open** (light on in most browsers) | Released (light off) |
| Undo | `enabled = true`, instant | Impossible: new `getUserMedia` needed (prompt / delay) |
| In a call (later) | Peer keeps the connection, receives black/silence | Sender has no track; you'd need `replaceTrack` |
| Use for | Mute / camera-off buttons | Leaving, switching devices, releasing hardware |

`muted` (read-only) is something else again: the *source* isn't delivering (OS paused it, or no
packets on a remote track). It's controlled by the browser, not by you.

Some apps stop the camera track on "camera off" anyway, so the light goes out (privacy), and accept
the delay of reopening it. It's a product decision.

## Audio processing (§13.5)

- `echoCancellation` (AEC) removes what your speakers play from your mic signal.
  `noiseSuppression` (NS) removes background noise. `autoGainControl` (AGC) normalises loudness.
- On for calls. Turn them **off** for music, instruments, or a pro audio interface
  (they mangle non-speech audio).
- **Chrome quirk observed:** `applyConstraints({ echoCancellation: false })` on a live mic
  **resolves successfully but changes nothing**: `getSettings()` still says `true`. So the hook
  verifies with `getSettings()`, and if it didn't stick, reopens the mic with the new constraints.
- **Second quirk:** while the old mic track is still open, Chrome may return the **same
  underlying source with its old settings** for the new request. So for processing changes the
  old track must be stopped *first* (`replaceTrack(..., { releaseFirst: true })`).
- Lesson: never trust that a constraint was applied. Read `getSettings()`.

## Screen sharing (getDisplayMedia)

- `navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } } })`. It **must be
  called from a click**, and the browser shows its own picker (screen / window / tab). You can't
  choose the source in code (privacy).
- Cancelling the picker → `NotAllowedError`.
- Not available on most mobile browsers.
- The screen track replaces the camera track in the same stream (the camera is stopped while
  sharing, and reopened with the same device + preset afterwards).
- **Browser's own "Stop sharing" bar**: it ends the track from *outside* the app. The track fires
  **`ended`** (which `track.stop()` from my own code never does), and the hook handles it exactly
  like my own "Stop sharing" button. Without this, the UI would show "sharing" forever, with a frozen frame.
- `contentHint = 'detail'` tells the encoder (later) to keep text sharp rather than motion smooth.
- **Don't mirror a screen**: the preview's `scaleX(-1)` is turned off while sharing.
- `getSettings().displaySurface` says what was picked: `monitor`, `window` or `browser`.

## Speaker selection (setSinkId)

- `audiooutput` devices from `enumerateDevices()`. Then `mediaElement.setSinkId(deviceId)`
  routes that element's audio there (`''` = system default).
- Supported in Chrome/Edge and Firefox; **not in Safari / iOS**. The UI disables the dropdown when
  `'setSinkId' in HTMLMediaElement.prototype` is false.
- Firefox only lists outputs after `navigator.mediaDevices.selectAudioOutput()`.
- The local preview is muted, so you can't hear the speaker choice on it. Hence the
  **test tone**: `OscillatorNode → MediaStreamDestination → new Audio()` → `setSinkId` → play.
  `VideoTile` already accepts `sinkId`, ready for remote video in step 10.
- Chrome lists `default` and `communications` pseudo-devices; the selector folds them into "Default".

## Testing tips (Linux)

```bash
google-chrome --use-fake-device-for-media-stream=device-count=2 --use-fake-ui-for-media-stream
```

This gives two fake cameras, two fake mics, two fake outputs, a fake screen for getDisplayMedia, and no prompts.
Without `--use-fake-ui-for-media-stream` you see the real pre-permission state.

## Exercises

1. **Front/back camera on the phone.** Add a "Flip" button that switches with
   `{ facingMode: 'user' | 'environment' }` instead of a deviceId. Try it on the phone over
   `https://<LAN-IP>:5173`. Should the preview still be mirrored for the back camera?
2. **Capabilities.** Show `videoTrack.getCapabilities()` (width/height/frameRate ranges) and
   disable presets the camera can't do natively. Compare `resizeMode: 'none'` vs `'crop-and-scale'`.
3. **Unplug test.** With a USB webcam or headset: start, then unplug it. Which events fire
   (`devicechange`, track `ended`)? Make the hook fall back to the default device automatically.
4. **Screen + camera at once.** Instead of replacing the camera, show the screen in a second
   `VideoTile` and keep the camera as picture-in-picture. Also try `getDisplayMedia({ audio: true })`
   on a Chrome tab and feed it into `MicLevel`.
