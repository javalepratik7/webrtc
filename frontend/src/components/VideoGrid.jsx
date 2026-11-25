// Responsive grid of ParticipantTiles; the layout depends only on how many people there are:
//   1 → full width · 2 → side by side · 3–4 → 2×2 · 5–6 → 3×2   (phones: 1 column for 2, 2 columns above)
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
import ParticipantTile from './ParticipantTile.jsx';

const layoutClass = (n) => (n <= 1 ? 'grid-1' : n === 2 ? 'grid-2' : n <= 4 ? 'grid-4' : 'grid-6');
const toBars = (level = 0) => (level < 0.01 ? 0 : level < 0.05 ? 1 : level < 0.12 ? 2 : level < 0.25 ? 3 : 4);

export default function VideoGrid({ tiles, activeId, levels }) {
  return (
    <div className={`video-grid ${layoutClass(tiles.length)}`} data-count={tiles.length}>
      {tiles.map((t) => (
        <ParticipantTile
          key={t.id}
          name={t.name}
          stream={t.stream}
          isLocal={t.isLocal}
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
