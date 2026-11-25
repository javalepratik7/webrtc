# Step 12: video in the mesh

Theory: `Webrtc.md` §13 (tracks, streams, transceivers), §20.1 (mesh).

Page: **`/group`**, the same Group Mesh page as step 11, now with camera + mic for up to 6 people.

## What changed

| File | Role |
| ---- | ---- |
| `hooks/useMeshRoom.js` | + local tracks on every new pc, `ontrack` → `entry.remoteStream`, `media-state` messages → `entry.media`, `broadcast()`, `replaceTrack(kind, track)` on every pc, `getAudioLevels()` from getStats |
| `hooks/useActiveSpeaker.js` | Polls the levels every 250 ms, picks one speaker with a hold time so the highlight doesn't flicker |
| `components/VideoGrid.jsx` | Layout by count: 1 → full, 2 → side by side, 3–4 → 2×2, 5–6 → 3×2 (phone: 1 column for 2, 2 columns above) |
| `components/ParticipantTile.jsx` | `memo`'d tile: video, name, 🔇, camera-off avatar, level bars, green border when speaking |
| `pages/GroupMesh.jsx` | getUserMedia once → join; mute / camera off / switch camera / leave (reuses `CallControls`) |
| `components/CallControls.jsx` | Stats button now optional, hang-up label configurable (Room still passes both: unchanged there) |

## One local track, many peer connections

```
getUserMedia ──▶ MediaStream { audioTrack, videoTrack }      ← ONE capture, ONE camera light
                      │
      ┌───────────────┼───────────────┐
      ▼               ▼               ▼
  pc → A          pc → B          pc → C
  sender(audio)   sender(audio)   sender(audio)   ← all point at the SAME audioTrack object
  sender(video)   sender(video)   sender(video)   ← all point at the SAME videoTrack object
  encoder ×2      encoder ×2      encoder ×2      ← but each pc ENCODES separately
```

A `MediaStreamTrack` is a **source of raw frames/samples**, not a network stream. `pc.addTrack(track, stream)` doesn't
move or consume the track: it attaches an `RTCRtpSender` that *reads* from it. Any number of consumers can read the
same track at once: a `<video>` preview, a Web Audio analyser, a `MediaRecorder`, and N−1 senders. Each sender has
its own encoder, packetizer, SSRC, SRTP keys and congestion controller, because each connection is a separate
transport with its own bandwidth.

Consequences:
- Camera opened **once**. Calling `getUserMedia` per peer would fail on many phones (camera busy) and multiply the CPU cost.
- `track.enabled = false` hits **every** connection at once (one object).
- But **encoding** is still N−1 times. That's the mesh cost: CPU + upload grow with every person (an SFU needs one encode).
- `pc.close()` doesn't stop the track: other connections are still using it. Only when **I** leave does
  `media.stop()` call `track.stop()`.

Verified in the test: on each page, every connected pc's senders hold exactly the 2 local track ids (1 distinct set across 3 pcs).

Ordering is the same as step 10, now per connection: the **offerer** (new joiner) adds tracks *before* `createOffer`.
The **answerer** adds them *after* `setRemoteDescription`, so `addTrack` reuses the transceivers the offer created.

## Remote streams in the Map

```js
pc.ontrack = (e) => {
  entry.remoteStream = e.streams[0];   // fires twice (audio, video), SAME stream object both times
  publish();                            // copies the reference into React state
};
```

The stream is stored once per connection and handed out as the **same object** on every `publish()`. When a peer
leaves, its entry and its stream disappear from the Map, so its tile disappears.

## Mute / camera off: why `track.enabled = false` isn't visible to others

`enabled = false` only changes what goes **into the encoder**: silence for audio, black frames for video. The sender
keeps sending RTP and the remote track stays `live`, unmuted, and keeps delivering frames. Nothing in RTP or the SDP
says "the user turned the camera off". On the receiving side, a black camera (lens cap, dark room) and a disabled
track look exactly the same, and silence is silence.

So the UI state travels separately, over the data channels:

```js
{ type: 'media-state', audio: false, video: true }   → broadcast() to every open channel
```

- Sent on every change (an effect on `[micOn, camOn]`).
- Sent to **each new peer when its data channel opens**. A newcomer missed all earlier broadcasts. Test: B turned the
  camera off *before* Phone joined, and Phone still showed B's "camera off" tile.
- The receiver stores it in `entry.media` → tile shows 🔇 / the avatar placeholder.

(Other approaches: `sender.replaceTrack(null)` stops sending entirely, which saves bandwidth, and the remote
track eventually fires `mute`. But that's slow and unreliable as a UI signal, so you'd still send a message.)

## Active speaker

`getStats()` per connection, every 250 ms:
- `inbound-rtp` (kind audio) `.audioLevel`: how loud each **remote** peer is (0..1, linear), measured on what we decoded.
- `media-source` (kind audio) `.audioLevel`: my own mic. Same track on every pc, so any pc gives it. Forced to 0 when I'm muted.

Raw levels jump between syllables, so `useActiveSpeaker` only switches to the loudest person above 0.02 if the
current speaker has had the highlight ≥ 1.2 s. It drops the highlight after 1.2 s of quiet. The highlight is a green
outline. Tiles are **not** reordered by speaker (that would make the grid jump every time someone talks).

Alternative: one Web Audio `AnalyserNode` per remote stream. More precise (and works without a connection for the
local mic), but N−1 audio graphs. getStats is free since the browser computes it anyway.

Test (fake devices beep): A, B and Phone muted → C highlighted on all three. Then C muted and A unmuted → highlight moved to A.

## Switch camera: replaceTrack on EVERY sender

```js
const track = await media.switchDevice('video', next.deviceId); // new track in the ONE local stream (preview + future pcs)
await mesh.replaceTrack('video', track);                           // each existing pc: transceiver.sender.replaceTrack(track)
```

Both parts are needed: the local stream feeds the preview **and** future connections (`getLocalStream()` at offer
time). The senders of the *existing* connections each need `replaceTrack`. Forget one and that person sees the old
(stopped) camera freeze. Still no renegotiation. Test: all 3 video senders hold the new track,
`signalingState` stayed `stable`, and C's total offers stayed 2.

## Leaving

| Who | What happens |
| --- | ------------ |
| **Someone else** leaves / closes the tab | `participant-left` → `removePeer(id)`: delete the entry, close its channel and pc → the tile is gone. My other pcs and my local tracks are untouched. |
| **I** leave | `mesh.leave()` → close **all** pcs + `group:leave`, then `media.stop()` → every local track `stop()`ped (camera light off). Test: B after Leave: all pcs `closed`, 0 live tracks. |
| Route change | Hook cleanups: useMeshRoom closes all pcs + emits `group:leave`, useLocalMedia stops tracks. |

## React re-renders without flicker or srcObject churn

The grid re-renders **4× a second** (audio levels), on every connection-state change, every chat message, every
media-state message. A `<video>` must survive all of that:

1. **`srcObject` is set in an effect keyed on the stream object** (`VideoTile`: `useEffect(..., [stream])`), never as a prop
   and never during render. Re-renders with the same stream do nothing.
2. **Same stream object every time.** The local stream is one `MediaStream` for the whole session (camera switch swaps
   the track *inside* it). Remote streams come from `ontrack` once per connection and are stored in the Map.
   Never `new MediaStream([...tracks])` during render: that's a new object each time → new srcObject → black flash.
3. **`key` = peer id, never the array index.** When B (index 1) leaves, C moves to index 1. With index keys React would
   reuse B's tile, and its `<video>`, for C → srcObject swap. With id keys, only B's node is removed.
4. **The `<video>` is always rendered.** Camera off = a placeholder **on top**. Unmounting the video on camera-off would
   create a new element on camera-on → new srcObject, `play()` again, a flash.
5. **Layout = CSS class on the same container** (`grid-1/2/4/6`). Going from 2×2 to 3×2 changes `grid-template-columns`
   only. No tile unmounts.
6. **Stable order** (join order). No reordering by speaker.
7. **`memo(ParticipantTile)` with primitive props** (`speaking` boolean, `levelBars` 0–4 instead of the raw float), so the
   250 ms level updates only re-render tiles whose bar count actually changed.

Verified with an instrumented `srcObject` setter: on A, after ~10 s of mute toggles, media-state messages and
speaker changes, **0** new `srcObject` assignments, and the same `<video>` elements. When B left, the remaining tiles
kept their exact `<video>` elements.

(StrictMode in dev runs each effect twice on mount, so you'll see srcObject set → null → set once per tile. That's only on mount.)

## Testing

**Automated** (headless Chrome with fake camera/mic (2 fake cameras), 4 contexts, one with an Android user agent and a 390 px viewport):

| Check | Result |
| ----- | ------ |
| Layout 1 / 2 / 3 / 4 / 5 / 6 people | `grid-1` 1 col · `grid-2` 2 cols · `grid-4` 2 cols · `grid-4` · `grid-6` 3 cols · `grid-6` 3 cols (phone: 2 cols) |
| Every remote `<video>` playing | `videoWidth > 0`, not paused, on every page at each N |
| Same tracks on every pc | ✓ on A, C, Phone (3 pcs each, 1 distinct sender-track set) |
| Camera off before Phone joined | Phone shows B's "camera off" (state sent on channel open) |
| Mute icons | each page shows 🔇 on exactly the muted people |
| Active speaker | C highlighted everywhere, then moved to A |
| Re-render stability | 0 srcObject assignments, same `<video>` elements |
| Switch camera on C | 3/3 senders on the new track, `stable`, no new offer |
| B leaves | tiles 4 → 3 elsewhere, other `<video>`s kept; B: all pcs closed, 0 live tracks |
| Phone closes tab | A and C → `grid-2` |
| Console errors | none |

**By hand:** 3 laptop tabs + the phone on the same Wi-Fi, `https://<LAN-IP>:5173/group?room=mesh-room`.
- Use headphones, or mute all but one tab: several tabs on one laptop with speakers = echo/feedback.
- Watch the laptop CPU in the task manager with 4 people: every tab encodes its camera 3× and decodes 3 videos.
  That's the mesh limit you'll feel first (the phone gets hot).
- Talk into the phone: its tile should get the green border on the laptop tabs.
- `chrome://webrtc-internals`: one entry per pc. Each `outbound-rtp` video shows the same source but its own
  bitrate. The congestion controller adapts **per connection**.

## Quiz

1. You call `pc.addTrack(cameraTrack, stream)` on 4 connections. How many cameras are open, how many encoders run,
   and what happens to the other 3 connections when one of them is closed?
2. Why does the receiver keep seeing a `live`, unmuted track after the sender sets `track.enabled = false`? Why must
   media-state also be sent when a data channel *opens*, not only when it changes?
3. A teammate renders `<video ref={ref} />` and in render does `ref.current.srcObject = new MediaStream(peer.tracks)`.
   List two problems.
4. Tiles use `key={index}`. B (2nd tile) leaves. What happens to C's video, and why does `key={peerId}` fix it?
5. Switch camera only calls `media.switchDevice()` and forgets `mesh.replaceTrack()`. What do I see, what do the
   others see, and what does someone who joins *after* the switch see?
