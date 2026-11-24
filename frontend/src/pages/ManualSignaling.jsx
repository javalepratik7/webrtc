// Step 7: Manual signaling. Open this page in TWO tabs/browsers/devices.
// You are the signaling server: carry the offer, answer (and in trickle mode,
// every ICE candidate) between them by copy/paste.
import { useState } from 'react';
import useManualPeer from '../hooks/useManualPeer.js';
import useChat from '../hooks/useChat.js';
import ChatBox from '../components/ChatBox.jsx';
import CopyBox from '../components/CopyBox.jsx';
import { parseCandidate } from '../services/webrtc.js';

const STATE_ROWS = [
  ['signaling', 'signalingState'],
  ['iceGathering', 'iceGatheringState'],
  ['iceConnection', 'iceConnectionState'],
  ['connection', 'connectionState'],
];
const GOOD = new Set(['stable', 'complete', 'connected', 'completed']);
const BAD = new Set(['failed', 'disconnected', 'closed']);
const stateClass = (v) => (GOOD.has(v) ? 'ok' : BAD.has(v) ? 'err' : '');

function PasteBox({ placeholder, buttonLabel, onSubmit, disabled, rows = 4 }) {
  const [text, setText] = useState('');
  return (
    <div className="paste-box">
      <textarea rows={rows} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} disabled={disabled} />
      <button
        className="primary"
        disabled={disabled || !text.trim()}
        onClick={async () => {
          if ((await onSubmit(text)) !== false) setText('');
        }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

// Trickle mode: my candidates, each copyable, plus "copy the ones I haven't sent yet".
function MyCandidates({ candidates, done }) {
  const [sentUpTo, setSentUpTo] = useState(0);
  const unsent = candidates.slice(sentUpTo);

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div>
      <p className="muted small">
        {candidates.length} gathered{done ? ' · gathering complete' : ' · still gathering…'} · {unsent.length} not yet copied
      </p>
      <ol className="cand-list">
        {candidates.map((json, i) => {
          const c = parseCandidate(JSON.parse(json).candidate);
          return (
            <li key={json} className={i < sentUpTo ? 'muted' : undefined}>
              <span className={`tag tag-${c?.type}`}>{c?.type}</span>{' '}
              <code className="addr">
                {c?.protocol} {c?.address}:{c?.port}
              </code>
              <button className="small-btn" onClick={() => copy(json)}>
                Copy
              </button>
            </li>
          );
        })}
      </ol>
      <button
        disabled={unsent.length === 0}
        onClick={async () => {
          if (await copy(JSON.stringify(unsent.map((j) => JSON.parse(j))))) setSentUpTo(candidates.length);
        }}
      >
        Copy {unsent.length} new candidate{unsent.length === 1 ? '' : 's'} as one array
      </button>
    </div>
  );
}

export default function ManualSignaling() {
  const peer = useManualPeer();
  const chat = useChat(peer.channel, peer.pcState.connection);
  const [role, setRole] = useState('caller');
  const [mode, setMode] = useState('vanilla');
  const trickle = mode === 'trickle';
  const { started } = peer;

  const reset = () => {
    peer.reset();
    chat.clear();
  };

  return (
    <div>
      <h1>Manual Signaling</h1>
      <p className="muted">
        Step 7: open this page in <strong>two</strong> tabs (or a laptop + your phone). You are the signaling server:
        copy text from one, paste it into the other.
      </p>

      <div className="card">
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Role">
            {['caller', 'callee'].map((r) => (
              <button key={r} className={role === r ? 'primary' : undefined} onClick={() => setRole(r)} disabled={started}>
                {r === 'caller' ? '📞 Caller' : '📲 Callee'}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Mode">
            <button className={!trickle ? 'primary' : undefined} onClick={() => setMode('vanilla')} disabled={started}>
              Non-trickle (1 message each way)
            </button>
            <button className={trickle ? 'primary' : undefined} onClick={() => setMode('trickle')} disabled={started}>
              Trickle (SDP + every candidate)
            </button>
          </div>
          <button onClick={reset} disabled={!started}>
            Reset
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {trickle
            ? 'Trickle: the SDP goes over immediately with NO candidates; then each candidate has to be carried separately, in both directions.'
            : 'Non-trickle: each side waits until ICE gathering is complete, so its SDP already contains every candidate.'}{' '}
          Use the same mode in both tabs.
        </p>
      </div>

      {peer.error && (
        <div className="alert" role="alert">
          {peer.error}
        </div>
      )}

      <div className="signal-grid">
        <div className="signal-steps">
          {role === 'caller' ? (
            <>
              <section className="card step-card">
                <h2>
                  <span className="step-no">1</span> Create the offer
                </h2>
                <button className="primary" onClick={() => peer.createOffer(mode)} disabled={started}>
                  Create data channel “chat” + offer
                </button>
                {peer.gathering && <p className="muted">Gathering ICE candidates… (up to 3 s)</p>}
                {peer.localText && (
                  <>
                    <p className="small">
                      <strong>Copy this offer</strong> and paste it into the <em>Callee</em> tab:
                    </p>
                    <CopyBox text={peer.localText} label="Offer JSON" />
                  </>
                )}
              </section>

              {trickle && peer.localText && (
                <section className="card step-card">
                  <h2>
                    <span className="step-no">1b</span> Carry my candidates → callee
                  </h2>
                  <MyCandidates candidates={peer.localCandidates} done={peer.gatheringDone} />
                </section>
              )}

              <section className={`card step-card${peer.localText ? '' : ' step-disabled'}`}>
                <h2>
                  <span className="step-no">2</span> Paste the callee’s answer
                </h2>
                {peer.remoteApplied ? (
                  <p className="ok">✓ Answer applied.</p>
                ) : (
                  <PasteBox
                    placeholder='{"type":"answer","sdp":"v=0…"}'
                    buttonLabel="Apply answer"
                    onSubmit={peer.acceptAnswer}
                    disabled={!peer.localText}
                  />
                )}
              </section>
            </>
          ) : (
            <>
              <section className="card step-card">
                <h2>
                  <span className="step-no">1</span> Paste the caller’s offer
                </h2>
                {peer.remoteApplied ? (
                  <p className="ok">✓ Offer applied.</p>
                ) : (
                  <PasteBox
                    placeholder='{"type":"offer","sdp":"v=0…"}'
                    buttonLabel="Apply offer + create answer"
                    onSubmit={(text) => peer.acceptOffer(text, mode)}
                    disabled={started}
                  />
                )}
              </section>

              <section className={`card step-card${started ? '' : ' step-disabled'}`}>
                <h2>
                  <span className="step-no">2</span> Copy the answer back
                </h2>
                {peer.gathering && <p className="muted">Gathering ICE candidates… (up to 3 s)</p>}
                {peer.localText ? (
                  <>
                    <p className="small">
                      <strong>Copy this answer</strong> and paste it into the <em>Caller</em> tab:
                    </p>
                    <CopyBox text={peer.localText} label="Answer JSON" />
                  </>
                ) : (
                  !peer.gathering && <p className="muted small">Appears after the offer is applied.</p>
                )}
              </section>

              {trickle && peer.localText && (
                <section className="card step-card">
                  <h2>
                    <span className="step-no">2b</span> Carry my candidates → caller
                  </h2>
                  <MyCandidates candidates={peer.localCandidates} done={peer.gatheringDone} />
                </section>
              )}
            </>
          )}

          {trickle && started && (
            <section className="card step-card">
              <h2>
                <span className="step-no">↓</span> Paste the {role === 'caller' ? 'callee’s' : 'caller’s'} candidates
              </h2>
              <p className="muted small">
                One candidate object, an array, or one per line. Added so far: <strong>{peer.remoteCandidates}</strong>
              </p>
              <PasteBox
                placeholder='{"candidate":"candidate:… typ host …","sdpMid":"0","sdpMLineIndex":0}'
                buttonLabel="addIceCandidate"
                onSubmit={peer.addRemoteCandidates}
                rows={3}
              />
            </section>
          )}
        </div>

        <div className="signal-side">
          <div className="card">
            <h2>This tab: {role}</h2>
            <table className="track-table">
              <tbody>
                {STATE_ROWS.map(([key, name]) => (
                  <tr key={key}>
                    <td>
                      <code>{name}</code>
                    </td>
                    <td className={stateClass(peer.pcState[key])}>{peer.pcState[key]}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <code>dataChannel.readyState</code>
                  </td>
                  <td className={chat.state === 'open' ? 'ok' : ''}>{chat.state}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <ChatBox messages={chat.messages} state={chat.state} onSend={chat.send} />
        </div>
      </div>
    </div>
  );
}
