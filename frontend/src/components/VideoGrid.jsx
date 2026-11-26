// Responsive grid of ParticipantTiles; the layout depends only on how many people there are:
//   1 → full width · 2 → side by side · 3–4 → 2×2 · 5+ → 3 columns   (phones: 1 column for 2, 2 columns above)
// Screen shares are tiles too (step 13), so with screens there can be more than 6.
//
//   <VideoGrid tiles={[{ id, name, stream, isLocal, micOn, camOn, connection, mirrored }]}
//              activeId="…" levels={{ id: 0..1 }} />
//
// No flicker when people join/leave or the layout changes:
//   - key = peer id (never the array index): React keeps each tile's DOM node,
//     including its <video>, for as long as that person is in the room.
//   - The layout is a CSS class on the SAME container element, so going from
//     2×2 to 3×2 only changes CSS. No tile is unmounted.
//   - Tiles stay in join order. We highlight the speaker, we don't move them:
//     reordering on every speaker change would make the grid jump around.
//   - levels → 0–4 bars here, so a tile only re-renders when its bar count changes.
//
// Step 15 (SFU): optional spotlight + tile-size reporting for simulcast.
//   pinnedId     → that tile spans the full width, the others become a strip of small tiles.
//                  Done with CSS `order`, NOT by reordering children: no DOM moves.
//   onSelect(id) → click a tile (to pin / unpin it)
//   onTileResize(id, widthPx) → ResizeObserver on every tile; the SFU page turns
//                  the width into a simulcast layer (big tile → high, small → low).
import { useEffect, useRef } from 'react';
import ParticipantTile from './ParticipantTile.jsx';

const layoutClass = (n) => (n <= 1 ? 'grid-1' : n === 2 ? 'grid-2' : n <= 4 ? 'grid-4' : 'grid-6');
const toBars = (level = 0) => (level < 0.01 ? 0 : level < 0.05 ? 1 : level < 0.12 ? 2 : level < 0.25 ? 3 : 4);

export default function VideoGrid({ tiles, activeId, levels, pinnedId = null, onSelect, onTileResize }) {
  const gridRef = useRef(null);
  const resizeRef = useRef(onTileResize);
  resizeRef.current = onTileResize;
  const idsKey = tiles.map((t) => t.id).join('|');
  const pinned = pinnedId && tiles.some((t) => t.id === pinnedId) ? pinnedId : null;

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !resizeRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) resizeRef.current?.(e.target.dataset.tileId, e.contentRect.width);
    });
    grid.querySelectorAll('[data-tile-id]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [idsKey]);

  return (
    <div ref={gridRef} className={`video-grid ${pinned ? 'spotlight' : layoutClass(tiles.length)}`} data-count={tiles.length}>
      {tiles.map((t) => (
        <ParticipantTile
          key={t.id}
          id={t.id}
          pinned={t.id === pinned}
          onSelect={onSelect}
          badge={t.badge}
          name={t.name}
          stream={t.stream}
          isLocal={t.isLocal}
          isScreen={t.isScreen}
          micOn={t.micOn}
          camOn={t.camOn}
          connection={t.connection}
          mirrored={t.mirrored}
          speaking={activeId === t.id}
          levelBars={t.micOn ? toBars(levels[t.id]) : 0}
        />
      ))}
    </div>
  );
}
