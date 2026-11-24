# Step 3: Camera & mic (getUserMedia)

Theory: `Webrtc.md` §4.1 (getUserMedia), §13.1 (MediaStreamTrack), §13.2 (MediaStream).

## What I built

| File | Role |
| ---- | ---- |
| `hooks/useLocalMedia.js` | `start(constraints)`, `stop()`, `stream`, `tracks`, `error`, `status`. Stops tracks on unmount |
| `components/VideoTile.jsx` | Attaches a stream to `<video>` via `srcObject` in an effect. Props `muted`, `mirrored`, `label` |
| `components/MicLevel.jsx` | Live mic meter: `MediaStreamAudioSourceNode → AnalyserNode` → RMS → dB |
| `pages/MediaLab.jsx` | Start / Stop / Mic only / Impossible constraints, preview, track table, error box |

## MediaStream vs MediaStreamTrack

- A **track** is one source: one camera, or one mic. It's the thing that holds the hardware.
  `kind`, `label`, `readyState` (`live`/`ended`), `enabled`, `muted`, `stop()`, `getSettings()`.
- A **stream** is just a **container** of tracks that belong together (camera + mic → lip sync).
  It's what `<video>.srcObject` takes. It has no `stop()` of its own.
- One `getUserMedia({ video, audio })` call → **one stream with two tracks**.
- To release the camera, **stop every track**: `stream.getTracks().forEach(t => t.stop())`.
  If even one track (or a `clone()` of it) is still live, the camera light stays on.
- `enabled = false` vs `stop()`:
  - `enabled = false` is a *mute*: the track still exists and sends black frames or silence, and the device stays open.
  - `stop()` is permanent: the track goes to `readyState: "ended"`, the device is released, and it can't be restarted. You need a new `getUserMedia`.
- `muted` (read-only) is different from `enabled`. It means *the source* isn't delivering data right now
  (OS paused the device, network stall on a remote track). It fires `mute`/`unmute` events.
- In WebRTC you send **tracks**, not streams: `pc.addTrack(track, stream)`. The stream argument
  only tells the other side which tracks to group together.

## Why `srcObject` can't be a JSX prop

JSX props on DOM elements become **HTML attributes**, and attributes are strings.
`srcObject` is a **DOM property** holding a live JS object (the MediaStream), and it has no attribute form.
So: `useRef` to get the real `<video>` element, then `video.srcObject = stream` in a `useEffect`
(runs after the element exists in the DOM). Cleanup sets it back to `null`.
(`src={URL.createObjectURL(stream)}` used to work, but it's removed from browsers.)

## Why the local preview is muted

1. **Feedback / echo:** playing your own mic out of your speakers feeds it straight back into
   the mic, which gives you howling, or at least hearing yourself with a delay.
2. **Autoplay policy:** browsers only allow `autoPlay` without a click if the video is muted.
   (`playsInline` is the iOS equivalent: otherwise Safari goes fullscreen.)

Muting the `<video>` element only affects **local playback**. The audio track is still live and
would still be sent to a peer. That's why the mic meter moves even though you hear nothing.

Mirroring (`transform: scaleX(-1)`) is also local-only and cosmetic. People expect their own
preview to behave like a mirror. Remote video must **not** be mirrored, or text appears backwards.

## Errors (`err.name`)

| Name | Meaning | How to trigger it |
| ---- | ------- | ----------------- |
| `NotAllowedError` | User/browser/OS denied permission | Click "Block", or reset site permissions and deny |
| `NotFoundError` | No device of that kind | Request video on a machine with no camera / camera disabled in BIOS |
| `NotReadableError` | Device exists but can't be opened | Camera in use by another app (common on Windows; Linux often allows sharing) |
| `OverconstrainedError` | No device matches an `exact`/`min`/`max` constraint | "Try impossible constraints" (`width: { exact: 10000 }`). `err.constraint` says which one |
| `TypeError` | Neither audio nor video requested | `getUserMedia({})` |
| `SecurityError` | Insecure context / Permissions-Policy | Step 2 territory |

`ideal` never fails; it's a preference. Only `exact`/`min`/`max` cause `OverconstrainedError`.
Also: after a `NotAllowedError` with "Block", Chrome remembers it. The user has to unblock via the address bar.

## Mic meter (Web Audio)

```
mic track → ctx.createMediaStreamSource(stream) → AnalyserNode   (not connected to destination!)
```

- Each animation frame: `getFloatTimeDomainData` gives raw samples in [-1, 1],
  then **RMS** = √(mean of squares) = loudness, then **dBFS** = `20·log10(rms)` (0 dB = max, silence → -∞).
  Map -60…0 dB to a 0…100% bar.
- Not connecting to `ctx.destination` is what keeps the mic out of the speakers.
- The bar is updated **via a ref, not state**. 60 re-renders per second for one div is wasteful.
- `AudioContext` can start `suspended` (autoplay rules). It's created right after a click, so `resume()` works.
- Cleanup: `cancelAnimationFrame`, `source.disconnect()`, `ctx.close()`. Closing the context
  does **not** stop the mic track. The hook owns the track.

## StrictMode double-mount

In **dev only**, React 18+ StrictMode does mount → **unmount** → mount for every component,
running each effect's cleanup and then the effect again. That simulates the component being
hidden and re-shown, and it exposes effects whose cleanup is missing.

How it hits getUserMedia:

- If you call `getUserMedia` **in a mount effect**, it runs **twice**. Two permission requests,
  two streams. The first stream resolves *after* its cleanup already ran, so a naive cleanup
  (`streamRef.current?.getTracks()...`) finds nothing to stop. That stream **leaks**:
  the camera light stays on forever, even after Stop.
- The fix (in `useLocalMedia`) is a **request id**. Every start/stop/unmount bumps
  `requestIdRef`. When `getUserMedia` resolves, if its id is outdated, it immediately stops
  the stream it got. The same guard covers real cases: pressing Stop while the permission
  prompt is open, or navigating away mid-prompt.
- Here capture is started by a **button** (not on mount), so StrictMode doesn't double-request.
  But the unmount cleanup still runs once on the fake unmount. It's harmless because nothing is open yet.
- `MicLevel` and `VideoTile` effects do run twice. Two `AudioContext`s get created, but the first
  is closed in cleanup, which shows the cleanup is correct.
- Bonus: starting from a click is also nicer UX (no surprise prompt on page load), and
  it's required on iOS for some audio APIs.

## Things I noticed

- `track.stop()` does **not** fire the `ended` event (only browser-initiated endings do:
  unplugging the camera, revoking permission). So the hook re-snapshots manually after stop.
- Track objects are mutable, and React can't see `readyState` change. The hook copies the
  fields it displays into plain objects (`snapshot()`) and refreshes on `ended`/`mute`/`unmute`.
- Device **labels are empty** until permission is granted (fingerprinting protection, §12.5).
- On Linux, `chrome --use-fake-device-for-media-stream --use-fake-ui-for-media-stream`
  gives a fake camera (green test pattern) and a beeping mic, with no prompt. Handy for testing.

## Exercises

1. **Mute vs stop.** Add an "enabled" toggle button in each track-table row that flips
   `track.enabled`. Watch what happens to the preview (black frames), the mic meter, the camera
   light (stays **on**), and `readyState`. Compare with Stop. Then write down which one you'd
   use for a "mute" button in a call, and why. (Hint: the hook needs a way to re-snapshot.)
2. **Inspect what you actually got.** Show `track.getSettings()` for the video track
   (width, height, frameRate, deviceId, facingMode) next to the table. Request
   `{ width: { ideal: 1920 }, height: { ideal: 1080 } }` and then `{ exact: 640 }`, and
   compare what was asked for with what the camera delivered. Try `aspectRatio` too.
3. **Catch the StrictMode leak yourself.** In a scratch component, call `getUserMedia` in a
   `useEffect` on mount with a *naive* cleanup that stops `streamRef.current`. Open the page
   in dev and stop it. Does the camera light go off? Log how many streams were created. Then
   fix it with a cancelled flag (`let cancelled = false; ... return () => { cancelled = true }`)
   and explain why that flag works the same way as `requestIdRef`.
