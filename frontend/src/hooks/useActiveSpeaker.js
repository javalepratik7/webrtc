// Who is talking? Polls audio levels (0..1) and picks one active speaker.
//
//   const { levels, activeId } = useActiveSpeaker(mesh.getAudioLevels, inRoom);
//   levels    { [peerId | 'me']: 0..1 }  (latest sample)
//   activeId  peerId | 'me' | null
//
// getAudioLevels comes from getStats: inbound-rtp.audioLevel per remote peer,
// media-source.audioLevel for our own mic. No Web Audio graph needed, and it
// measures what was actually DECODED from the network (a peer who muted with
// track.enabled = false sends silence → level 0).
//
// Raw levels jump around between syllables, so the highlight would flicker. Two
// rules keep it calm:
//   - switch to a new speaker only if they are the loudest above THRESHOLD and the
//     current one has been active for at least HOLD_MS
//   - drop the highlight only after the speaker has been quiet for HOLD_MS
import { useEffect, useRef, useState } from 'react';

const INTERVAL_MS = 250;
const THRESHOLD = 0.02; // audioLevel is linear (1.0 = full scale). Speech is ~0.05–0.3.
const HOLD_MS = 1200;

export default function useActiveSpeaker(getLevels, enabled) {
  const [levels, setLevels] = useState({});
  const [activeId, setActiveId] = useState(null);
  const getRef = useRef(getLevels);
  getRef.current = getLevels;

  useEffect(() => {
    if (!enabled) {
      setLevels({});
      setActiveId(null);
      return undefined;
    }
    let cancelled = false;
    let active = null;
    let since = 0; // when `active` became active
    const lastLoud = {}; // id → last time it was above the threshold

    const tick = async () => {
      const l = await getRef.current();
      if (cancelled) return;
      const now = Date.now();
      let loudest = null;
      for (const [id, v] of Object.entries(l)) {
        if (v < THRESHOLD) continue;
        lastLoud[id] = now;
        if (!loudest || v > l[loudest]) loudest = id;
      }
      if (loudest && loudest !== active && (!active || now - since > HOLD_MS)) {
        active = loudest;
        since = now;
      } else if (active && now - (lastLoud[active] ?? 0) > HOLD_MS) {
        active = null;
      }
      setLevels(l);
      setActiveId(active);
    };
    const timer = setInterval(tick, INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return { levels, activeId };
}
