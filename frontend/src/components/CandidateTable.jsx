// Every ICE candidate gathered by A and B, parsed field by field.
import { CANDIDATE_TYPES, parseCandidate } from '../services/webrtc.js';

export default function CandidateTable({ candidates, stunUsed, trickle, done }) {
  const rows = candidates.map((c) => ({ ...c, parsed: parseCandidate(c.candidate) }));
  const hasMdns = rows.some((r) => r.parsed?.isMdns);
  const srflx = rows.find((r) => r.parsed?.type === 'srflx');

  return (
    <div className="card">
      <h2>ICE candidates ({candidates.length})</h2>
      {rows.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="track-table candidate-table">
            <thead>
              <tr>
                <th>peer</th>
                <th title="Same foundation = same type, base IP and STUN/TURN server. Used to unfreeze similar pairs together.">
                  foundation
                </th>
                <th title="1 = RTP. 2 = RTCP (never seen with rtcp-mux).">comp</th>
                <th>proto</th>
                <th title="Higher wins. Top byte = type preference (host 126 > prflx 110 > srflx 100 > relay 0).">priority</th>
                <th>address</th>
                <th>port</th>
                <th>type</th>
                <th title="For srflx/relay: the local address this was derived from.">related</th>
                <th>mid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ id, side, sdpMid, parsed, candidate }) =>
                parsed ? (
                  <tr key={id} className={`cand-${parsed.type}`}>
                    <td>{side}</td>
                    <td>{parsed.foundation}</td>
                    <td>{parsed.component}</td>
                    <td>
                      {parsed.protocol}
                      {parsed.tcpType && <span className="muted"> ({parsed.tcpType})</span>}
                    </td>
                    <td title={`type pref ${parsed.typePreference}, local pref ${parsed.localPreference}`}>{parsed.priority}</td>
                    <td className="addr">
                      {parsed.address}
                      {parsed.isMdns && <span className="tag">mDNS</span>}
                      {parsed.isIPv6 && <span className="tag">IPv6</span>}
                    </td>
                    <td>{parsed.port}</td>
                    <td title={CANDIDATE_TYPES[parsed.type]}>
                      <span className={`tag tag-${parsed.type}`}>{parsed.type}</span>
                    </td>
                    <td className="addr muted">
                      {parsed.relatedAddress ? `${parsed.relatedAddress}:${parsed.relatedPort}` : ''}
                    </td>
                    <td>{sdpMid}</td>
                  </tr>
                ) : (
                  <tr key={id}>
                    <td>{side}</td>
                    <td colSpan={9} className="muted">
                      unparsed: {candidate}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      <dl className="explain-list small">
        {Object.entries(CANDIDATE_TYPES).map(([type, text]) => (
          <div key={type}>
            <dt>
              <span className={`tag tag-${type}`}>{type}</span>
            </dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>

      {srflx && (
        <p className="small">
          <span className="tag tag-srflx">srflx</span> <strong>{srflx.parsed.address}</strong> is your public IP, as the
          STUN server sees it. Every device behind your router shares it; the port is the mapping your NAT created for this connection.
        </p>
      )}
      {!srflx && stunUsed && trickle && done && (
        <p className="small">
          <span className="tag tag-srflx">srflx</span> <strong>No srflx candidate?</strong> In a loopback, ICE connects
          in ~60 ms using host candidates, and Chrome ends gathering once connected. That's usually before the STUN server’s
          reply comes back. Untick <em>trickle ICE</em> and reconnect: each peer then gathers <em>everything</em> first.
        </p>
      )}
      {hasMdns && (
        <p className="small">
          <span className="tag">mDNS</span> <strong>Why “xxxxxxxx-….local”?</strong> Exposing your private LAN IP (192.168.x.x)
          to any web page is a privacy leak (fingerprinting, mapping your home network). So Chrome/Safari/Firefox replace host
          IPs with a random <code>UUID.local</code> name, and the other peer resolves it with multicast DNS, which only works
          on the same LAN. Once a page has camera/mic permission, browsers trust it enough to show the real IP instead.
          Try “data only” vs “video” and compare.
        </p>
      )}
    </div>
  );
}
