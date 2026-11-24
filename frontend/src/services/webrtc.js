// WebRTC helpers shared by every page: ICE config, candidate parsing, stats summary.

// STUN server: tells us our PUBLIC address (as seen from the internet) so we can
// produce "srflx" (server-reflexive) candidates. Free, public, no credentials.
// TURN (relay) servers come later. They need credentials and cost bandwidth.
export const ICE_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// Same, but host candidates only (to compare: no srflx will appear).
export const NO_STUN_CONFIG = { iceServers: [] };

// Resolves once the peer has finished gathering candidates (for non-trickle /
// "vanilla" ICE, where the SDP is only sent once it contains every candidate).
// Resolves true if gathering completed, false if we gave up after timeoutMs.
//
// Why a timeout is essential: "complete" only fires after EVERY STUN request has
// succeeded or timed out. stun.l.google.com also resolves to IPv6; on a machine
// without a working IPv6 route that request takes ~40 s to time out (error 701),
// even though the useful host + srflx candidates arrived within ~100 ms.
export function waitForIceGathering(pc, timeoutMs = 3000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (completed) => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve(completed);
    };
    const check = () => pc.iceGatheringState === 'complete' && finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// ---------------------------------------------------------------------------
// ICE candidates
//
//   candidate:842163049 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 ...
//             foundation  │  proto  priority  address   port      type      related address/port
//                     component (1 = RTP; with rtcp-mux there is never a 2)
// ---------------------------------------------------------------------------

export const CANDIDATE_TYPES = {
  host: 'Host: an address on one of your own network interfaces (LAN IP, or an mDNS .local name).',
  srflx: 'Server-reflexive: your PUBLIC IP:port as seen by the STUN server (your NAT\'s outside address).',
  prflx: 'Peer-reflexive: an address discovered during connectivity checks (the peer saw us from an address we didn\'t know).',
  relay: 'Relay: an address on a TURN server that forwards traffic for you (last resort when direct fails).',
};

export function parseCandidate(candidateString) {
  const str = candidateString.replace(/^a=/, '');
  const parts = str.split(' ');
  if (!parts[0]?.startsWith('candidate:') || parts.length < 8) return null;

  const priority = Number(parts[3]);
  const c = {
    raw: str,
    foundation: parts[0].slice('candidate:'.length),
    component: Number(parts[1]),
    protocol: parts[2].toLowerCase(),
    priority,
    address: parts[4],
    port: Number(parts[5]),
    type: parts[7], // parts[6] is the literal "typ"
    // RFC 8445 §5.1.2: priority = 2^24·typePref + 2^8·localPref + (256 − component)
    typePreference: priority >>> 24,
    localPreference: (priority >>> 8) & 0xffff,
  };
  // Optional "key value" pairs after the type.
  for (let i = 8; i + 1 < parts.length; i += 2) {
    const key = parts[i];
    const value = parts[i + 1];
    if (key === 'raddr') c.relatedAddress = value;
    else if (key === 'rport') c.relatedPort = Number(value);
    else if (key === 'tcptype') c.tcpType = value;
    else if (key === 'generation') c.generation = Number(value);
    else if (key === 'ufrag') c.ufrag = value;
    else if (key === 'network-id') c.networkId = Number(value);
    else if (key === 'network-cost') c.networkCost = Number(value);
  }
  c.isMdns = c.address.endsWith('.local');
  c.isIPv6 = c.address.includes(':');
  return c;
}

// ---------------------------------------------------------------------------
// getStats() summary
//
// getStats() returns a Map of ~50 report objects linked by ids
// (outbound-rtp.codecId → codec, transport.selectedCandidatePairId → candidate-pair
//  → local-candidate / remote-candidate). We follow the links for the interesting bits.
// ---------------------------------------------------------------------------

// Selected candidate pair of ONE peer connection (for the Room page).
export async function getSelectedCandidatePair(pc) {
  return selectedPair(await pc.getStats());
}

function selectedPair(report) {
  let pair = null;
  report.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = report.get(r.selectedCandidatePairId);
  });
  if (!pair) {
    // Firefox: no transport.selectedCandidatePairId, but candidate-pair.selected
    report.forEach((r) => {
      if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
    });
  }
  if (!pair) return null;
  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  const describe = (c) =>
    c && {
      type: c.candidateType,
      address: c.address ?? c.ip,
      port: c.port,
      protocol: c.protocol,
      networkType: c.networkType,
    };
  return {
    state: pair.state,
    rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
    availableOutgoingKbps: pair.availableOutgoingBitrate != null ? pair.availableOutgoingBitrate / 1000 : null,
    bytesSent: pair.bytesSent,
    bytesReceived: pair.bytesReceived,
    local: describe(local),
    remote: describe(remote),
  };
}

function codecName(report, codecId) {
  const codec = codecId && report.get(codecId);
  if (!codec) return null;
  return `${codec.mimeType}${codec.sdpFmtpLine ? ` (${codec.sdpFmtpLine})` : ''} pt=${codec.payloadType}`;
}

function kbps(bytesNow, bytesBefore, msElapsed) {
  if (bytesBefore == null || !msElapsed) return null;
  return ((bytesNow - bytesBefore) * 8) / msElapsed; // bits/ms = kbit/s
}

// sender/receiver: the two RTCPeerConnections (in loopback: A sends, B receives;
// both directions are reported anyway). prev: the previous summary, for bitrates.
export async function collectStats(sender, receiver, prev) {
  const [a, b] = await Promise.all([sender.getStats(), receiver.getStats()]);
  const now = performance.now();
  const elapsed = prev ? now - prev.time : 0;
  const prevBy = (list, key) => prev?.[list]?.find((x) => x.key === key);

  const outbound = [];
  a.forEach((r) => {
    if (r.type !== 'outbound-rtp') return;
    const key = `${r.kind}-${r.ssrc}`;
    outbound.push({
      key,
      kind: r.kind,
      codec: codecName(a, r.codecId),
      bytesSent: r.bytesSent,
      packetsSent: r.packetsSent,
      kbps: kbps(r.bytesSent, prevBy('outbound', key)?.bytesSent, elapsed),
      fps: r.framesPerSecond,
      resolution: r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : null,
      encoder: r.encoderImplementation,
      limitation: r.qualityLimitationReason,
    });
  });

  const inbound = [];
  b.forEach((r) => {
    if (r.type !== 'inbound-rtp') return;
    const key = `${r.kind}-${r.ssrc}`;
    inbound.push({
      key,
      kind: r.kind,
      codec: codecName(b, r.codecId),
      bytesReceived: r.bytesReceived,
      packetsReceived: r.packetsReceived,
      packetsLost: r.packetsLost,
      jitterMs: r.jitter != null ? r.jitter * 1000 : null,
      kbps: kbps(r.bytesReceived, prevBy('inbound', key)?.bytesReceived, elapsed),
      fps: r.framesPerSecond,
      resolution: r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : null,
      decoder: r.decoderImplementation,
    });
  });

  const dataChannels = [];
  for (const [side, report] of [['A', a], ['B', b]]) {
    report.forEach((r) => {
      if (r.type === 'data-channel') {
        dataChannels.push({
          side,
          label: r.label,
          state: r.state,
          messagesSent: r.messagesSent,
          messagesReceived: r.messagesReceived,
          bytesSent: r.bytesSent,
          bytesReceived: r.bytesReceived,
        });
      }
    });
  }

  return { time: now, pair: selectedPair(a), outbound, inbound, dataChannels, reportCount: a.size };
}
