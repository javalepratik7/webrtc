// Shows an offer/answer SDP grouped by section, with important lines colour-coded.
// Hover a line for its explanation (title tooltip); click/tap to pin it below
// (tooltips don't exist on phones). Includes an m-section summary that can be
// pinned to compare two connections (e.g. audio+video vs data only).
import { useMemo, useState } from 'react';
import { explainLine, parseSdp, summarizeSdp } from '../services/sdp.js';

const LEGEND = [
  ['session', 'session (v= o= s= t=)'],
  ['media', 'm= section'],
  ['bundle', 'mid / BUNDLE'],
  ['codec', 'codecs (rtpmap, fmtp, rtcp-fb)'],
  ['ice', 'ICE credentials'],
  ['dtls', 'DTLS (fingerprint, setup)'],
  ['direction', 'direction'],
  ['candidate', 'candidates'],
];

function SummaryTable({ summary, title }) {
  return (
    <div className="sdp-summary">
      <h3>{title}</h3>
      <p className="muted small">
        {summary.lineCount} lines · BUNDLE: {summary.bundle.length ? summary.bundle.join(' ') : 'none'}
      </p>
      {summary.media.length === 0 ? (
        <p className="muted small">No m-sections.</p>
      ) : (
        <table className="track-table">
          <thead>
            <tr>
              <th>mid</th>
              <th>kind</th>
              <th>direction</th>
              <th>setup</th>
              <th>codecs (preference order)</th>
              <th>lines</th>
            </tr>
          </thead>
          <tbody>
            {summary.media.map((m) => (
              <tr key={m.mid ?? m.kind}>
                <td>{m.mid}</td>
                <td>{m.kind}</td>
                <td>{m.direction}</td>
                <td>{m.setup}</td>
                <td>
                  {m.kind === 'application' ? m.proto : m.codecs.join(', ')}
                  {m.payloadTypes > m.codecs.length && m.kind !== 'application' && (
                    <span className="muted"> ({m.payloadTypes} PTs incl. RTX/RED/FEC)</span>
                  )}
                </td>
                <td>{m.lineCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SdpViewer({ sdp, label }) {
  const [which, setWhich] = useState('offer'); // 'offer' | 'answer'
  const [final, setFinal] = useState(false); // false = as created, true = localDescription after gathering
  const [importantOnly, setImportantOnly] = useState(false);
  const [selected, setSelected] = useState(null); // { line, text }
  const [pinned, setPinned] = useState(null); // { label, summary }

  const text = final ? sdp[`${which}Final`] : sdp[which];

  const parsed = useMemo(() => {
    if (!text) return null;
    const { sections } = parseSdp(text);
    return sections.map((section) => ({
      ...section,
      rows: section.lines.map((line) => ({ line, ...explainLine(line, section) })),
    }));
  }, [text]);

  const summary = useMemo(() => (sdp[which] ? summarizeSdp(sdp[which]) : null), [sdp, which]);

  return (
    <div className="card">
      <h2>SDP</h2>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Which description">
          {['offer', 'answer'].map((w) => (
            <button key={w} className={which === w ? 'primary' : undefined} onClick={() => setWhich(w)}>
              {w === 'offer' ? 'Offer (A)' : 'Answer (B)'}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Version">
          <button className={!final ? 'primary' : undefined} onClick={() => setFinal(false)}>
            As created
          </button>
          <button className={final ? 'primary' : undefined} onClick={() => setFinal(true)}>
            After ICE gathering
          </button>
        </div>
        <label className="checkbox inline">
          <input type="checkbox" checked={importantOnly} onChange={(e) => setImportantOnly(e.target.checked)} /> Important
          lines only
        </label>
      </div>

      <div className="sdp-legend small">
        {LEGEND.map(([cat, name]) => (
          <span key={cat} className={`sdp-chip sdp-${cat}`}>
            {name}
          </span>
        ))}
      </div>

      {!text ? (
        <p className="muted">
          {final && sdp[which] ? 'Waiting for ICE gathering to complete…' : 'Press “Connect” to generate an offer and answer.'}
        </p>
      ) : (
        <div className="sdp-text" role="list">
          {parsed.map((section) => (
            <div key={section.index} className="sdp-section">
              <div className="sdp-section-title">
                {section.kind === 'session' ? 'Session' : `m-section ${section.index - 1}: ${section.kind} (mid ${section.mid})`}
              </div>
              {section.rows
                .filter((r) => !importantOnly || r.important)
                .map((r, i) => (
                  <div
                    key={i}
                    role="listitem"
                    tabIndex={0}
                    title={r.text}
                    className={`sdp-line sdp-${r.cat}${r.important ? ' sdp-important' : ''}${selected?.line === r.line ? ' sdp-selected' : ''}`}
                    onClick={() => setSelected({ line: r.line, text: r.text })}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected({ line: r.line, text: r.text })}
                  >
                    {r.line}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="sdp-explain">
          <code>{selected.line.length > 90 ? `${selected.line.slice(0, 90)}…` : selected.line}</code>
          <p>{selected.text}</p>
        </div>
      )}

      {summary && (
        <>
          <div className="toolbar" style={{ marginTop: '1rem' }}>
            <button onClick={() => setPinned({ label: `${label}, ${which}`, summary })}>📌 Pin this {which} for comparison</button>
            {pinned && <button onClick={() => setPinned(null)}>Unpin</button>}
          </div>
          <div className="sdp-compare">
            <SummaryTable summary={summary} title={`Current: ${label}, ${which}`} />
            {pinned && <SummaryTable summary={pinned.summary} title={`Pinned: ${pinned.label}`} />}
          </div>
        </>
      )}
    </div>
  );
}
