// SDP parsing + a plain-English explanation for each line (used by SdpViewer).
//
// SDP is line based: "<type>=<value>". The part before the first "m=" is the
// SESSION section; each "m=" starts a MEDIA section (one per transceiver or
// one for all data channels) that lasts until the next "m=".

const DIRECTIONS = {
  sendrecv: 'Direction: this side wants to SEND and RECEIVE media on this m-section.',
  sendonly: 'Direction: this side will only SEND here (e.g. a broadcaster).',
  recvonly: 'Direction: this side will only RECEIVE here (e.g. a viewer, or addTransceiver(kind, {direction:"recvonly"})).',
  inactive: 'Direction: no media flows either way (e.g. the m-section was stopped, or put on hold).',
};

const SPECIAL_CODECS = {
  rtx: 'RTX = retransmission. Lost packets are resent on a separate payload type (see the matching a=fmtp apt=).',
  red: 'RED = redundant encoding: older frames are resent inside new packets to survive loss.',
  ulpfec: 'ULPFEC = forward error correction: extra parity packets let the receiver rebuild lost ones.',
  'flexfec-03': 'FlexFEC = a more flexible forward error correction scheme.',
  'telephone-event': 'telephone-event = DTMF keypad tones (RFC 4733), e.g. for phone menus.',
  cn: 'CN = comfort noise: background noise generated during silence.',
};

const FMTP_PARAMS = {
  minptime: 'minimum packet duration in ms',
  useinbandfec: 'Opus in-band forward error correction (1 = on)',
  usedtx: 'Opus DTX: send (almost) nothing during silence',
  stereo: 'receiver wants stereo',
  'sprop-stereo': 'sender may send stereo',
  maxaveragebitrate: 'maximum average bitrate (bps)',
  apt: 'this RTX payload retransmits payload type',
  'profile-level-id': 'H.264 profile + level (42=Baseline, 4d=Main, 64=High; last byte = level, e.g. 1f = 3.1)',
  'packetization-mode': 'H.264 packetization (1 = non-interleaved, allows splitting frames into several packets)',
  'level-asymmetry-allowed': 'H.264: each side may use a different level',
  'profile-id': 'VP9 profile (0 = 8-bit 4:2:0, 2 = 10-bit)',
  'level-idx': 'AV1 level',
  profile: 'AV1 profile',
  tier: 'AV1 tier',
  'x-google-max-bitrate': 'Chrome-specific bitrate cap (kbps)',
};

const RTCP_FB = {
  nack: 'NACK: the receiver reports lost packets so the sender can retransmit them (via RTX).',
  'nack pli': 'PLI (Picture Loss Indication): "I lost too much, please send a keyframe".',
  'ccm fir': 'FIR (Full Intra Request): asks for a full keyframe (e.g. a new viewer joined).',
  'goog-remb': 'REMB: receiver-side bandwidth estimate sent back to the sender (older Chrome mechanism).',
  'transport-cc': 'Transport-wide congestion control: the receiver reports arrival times of every packet, the sender estimates bandwidth (modern approach).',
};

// Splits SDP into a session section + media sections and extracts the key facts.
export function parseSdp(sdp) {
  const lines = (sdp || '').split(/\r?\n/).filter(Boolean);
  const sections = [{ index: 0, kind: 'session', lines: [] }];
  for (const line of lines) {
    if (line.startsWith('m=')) {
      sections.push({ index: sections.length, kind: line.slice(2).split(' ')[0], lines: [] });
    }
    sections[sections.length - 1].lines.push(line);
  }

  for (const s of sections) {
    s.codecs = {}; // payload type → "opus/48000/2"
    s.candidates = 0;
    for (const line of s.lines) {
      let m;
      if ((m = line.match(/^a=rtpmap:(\d+) (.+)$/))) s.codecs[m[1]] = m[2];
      else if ((m = line.match(/^a=mid:(.+)$/))) s.mid = m[1];
      else if ((m = line.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/))) s.direction = m[1];
      else if ((m = line.match(/^a=setup:(.+)$/))) s.setup = m[1];
      else if ((m = line.match(/^a=group:BUNDLE (.+)$/))) s.bundle = m[1].split(' ');
      else if (line.startsWith('a=candidate:')) s.candidates++;
      else if ((m = line.match(/^m=(\S+) (\d+) (\S+) (.*)$/))) {
        s.port = Number(m[2]);
        s.proto = m[3];
        s.formats = m[4].split(' ');
      }
    }
  }
  return { lines, sections };
}

// One row per m-section, for comparing offers side by side.
export function summarizeSdp(sdp) {
  const { lines, sections } = parseSdp(sdp);
  const session = sections[0];
  return {
    lineCount: lines.length,
    bundle: session.bundle || [],
    media: sections.slice(1).map((s) => ({
      mid: s.mid,
      kind: s.kind,
      proto: s.proto,
      direction: s.direction || (s.kind === 'application' ? '(n/a)' : 'sendrecv'),
      setup: s.setup,
      // Codec names without RTX/RED/FEC helpers, unique, in preference order.
      codecs: [
        ...new Set(
          (s.formats || [])
            .map((pt) => s.codecs[pt]?.split('/')[0])
            .filter((n) => n && !['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(n.toLowerCase())),
        ),
      ],
      payloadTypes: (s.formats || []).length,
      candidates: s.candidates,
      lineCount: s.lines.length,
    })),
  };
}

function codecLabel(section, pt) {
  const c = section?.codecs?.[pt];
  return c ? `${pt} (${c.split('/')[0]})` : pt;
}

// Returns { cat, important, text } for one SDP line.
// cat drives the colour: session | media | bundle | codec | ice | dtls | direction | candidate | other
export function explainLine(line, section) {
  const eq = line.indexOf('=');
  const type = line.slice(0, eq);
  const value = line.slice(eq + 1);
  let m;

  switch (type) {
    case 'v':
      return { cat: 'session', important: true, text: 'Protocol version. Always 0.' };
    case 'o': {
      const [user, id, version, , , addr] = value.split(' ');
      return {
        cat: 'session',
        important: true,
        text: `Origin: username "${user}", session id ${id}, session VERSION ${version} (increments on every renegotiation of this session), address ${addr} (a dummy, never used).`,
      };
    }
    case 's':
      return { cat: 'session', text: 'Session name. "-" = none. WebRTC ignores it.' };
    case 't':
      return { cat: 'session', text: 'Timing "0 0" = the session is permanent (not scheduled). WebRTC ignores it.' };
    case 'c':
      return { cat: 'session', text: 'Connection address. 0.0.0.0 is a placeholder: real addresses come from ICE candidates.' };
    case 'm': {
      const [kind, port, proto, ...fmts] = value.split(' ');
      const protoText =
        proto === 'UDP/TLS/RTP/SAVPF'
          ? 'UDP/TLS/RTP/SAVPF = RTP over UDP, encrypted as SRTP with keys from DTLS, with RTCP feedback.'
          : proto.includes('SCTP')
            ? `${proto} = SCTP (data channels) over DTLS over UDP.`
            : proto;
      const fmtText =
        kind === 'application'
          ? `Format "${fmts.join(' ')}".`
          : `Payload types in preference order: ${fmts.map((pt) => codecLabel(section, pt)).join(', ')}.`;
      return {
        cat: 'media',
        important: true,
        text: `New MEDIA SECTION (one per transceiver; one for all data channels) of kind "${kind}". Port ${port} is a placeholder (9 = "discard"): ICE decides the real address. ${protoText} ${fmtText}`,
      };
    }
    case 'a':
      break;
    default:
      return { cat: 'other', text: `"${type}=" line.` };
  }

  // ---- attributes (a=...) ----
  if ((m = value.match(/^group:BUNDLE (.+)$/))) {
    return {
      cat: 'bundle',
      important: true,
      text: `BUNDLE: the m-sections with mids ${m[1]} all share ONE transport (one ICE connection, one DTLS handshake, one port), instead of one per m-section.`,
    };
  }
  if ((m = value.match(/^mid:(.+)$/))) {
    return {
      cat: 'bundle',
      important: true,
      text: `Media ID "${m[1]}": names this m-section. Referenced by a=group:BUNDLE and exposed as transceiver.mid / candidate.sdpMid.`,
    };
  }
  if ((m = value.match(/^(sendrecv|sendonly|recvonly|inactive)$/))) {
    return { cat: 'direction', important: true, text: DIRECTIONS[m[1]] };
  }
  if ((m = value.match(/^rtpmap:(\d+) ([^/]+)\/(\d+)(?:\/(\d+))?$/))) {
    const [, pt, name, clock, channels] = m;
    const special = SPECIAL_CODECS[name.toLowerCase()];
    return {
      cat: 'codec',
      important: true,
      text: `Payload type ${pt} = ${name}, RTP clock ${clock} Hz${channels ? `, ${channels} channel(s)` : ''}. ${special || 'Each RTP packet carries this number to say which codec it is.'}`,
    };
  }
  if ((m = value.match(/^fmtp:(\d+) (.+)$/))) {
    const params = m[2].split(';').map((p) => {
      const [k, v] = p.split('=');
      if (v === undefined) return `"${k.trim()}" (e.g. RED: the payload types it wraps)`;
      const desc = FMTP_PARAMS[k.trim()];
      if (k.trim() === 'apt') return `apt=${v}: ${desc} ${codecLabel(section, v)}`;
      return desc ? `${k.trim()}=${v}: ${desc}` : `${k.trim()}=${v}`;
    });
    return {
      cat: 'codec',
      important: true,
      text: `Format parameters for payload type ${codecLabel(section, m[1])}. ${params.join('. ')}.`,
    };
  }
  if ((m = value.match(/^rtcp-fb:(\S+) (.+)$/))) {
    const desc = RTCP_FB[m[2]] || `RTCP feedback "${m[2]}".`;
    return {
      cat: 'codec',
      important: true,
      text: `RTCP feedback supported for payload type ${m[1] === '*' ? 'all' : codecLabel(section, m[1])}. ${desc}`,
    };
  }
  if ((m = value.match(/^ice-ufrag:(.+)$/))) {
    return {
      cat: 'ice',
      important: true,
      text: `ICE username fragment "${m[1]}". Each side's ufrag + pwd authenticate the STUN connectivity checks, so only the real peer can complete them. New values = ICE restart.`,
    };
  }
  if (value.startsWith('ice-pwd:')) {
    return {
      cat: 'ice',
      important: true,
      text: 'ICE password (paired with ice-ufrag). Used to sign STUN connectivity-check messages (MESSAGE-INTEGRITY).',
    };
  }
  if ((m = value.match(/^fingerprint:(\S+) (.+)$/))) {
    return {
      cat: 'dtls',
      important: true,
      text: `DTLS certificate fingerprint (${m[1]} hash of this side's self-signed certificate). During the DTLS handshake the peer checks the certificate matches this hash. That's what ties the encryption to the signaling: a man-in-the-middle would have a different certificate.`,
    };
  }
  if ((m = value.match(/^setup:(.+)$/))) {
    const roles = {
      actpass: 'actpass = "I can be either DTLS client or server, you choose" (always in an offer).',
      active: 'active = this side is the DTLS CLIENT (starts the handshake).',
      passive: 'passive = this side is the DTLS SERVER (waits for the handshake).',
      holdconn: 'holdconn = no connection for now.',
    };
    return { cat: 'dtls', important: true, text: `DTLS role. ${roles[m[1]] || m[1]}` };
  }
  if (value.startsWith('ice-options:')) {
    return { cat: 'ice', text: `ICE options: "${value.slice(12)}". "trickle" = candidates may be sent separately, after the SDP.` };
  }
  if (value.startsWith('candidate:')) {
    const type = value.match(/ typ (\S+)/)?.[1];
    return {
      cat: 'candidate',
      text: `ICE candidate (type ${type}) embedded in the SDP. With trickle ICE these normally travel separately (onicecandidate). They appear here in localDescription once gathered.`,
    };
  }
  if (value === 'end-of-candidates') {
    return { cat: 'candidate', text: 'No more candidates will follow for this m-section (gathering complete).' };
  }
  if (value === 'rtcp-mux') {
    return { cat: 'other', text: 'RTP and RTCP share the same port (so candidates only have component 1).' };
  }
  if (value === 'rtcp-rsize') {
    return { cat: 'other', text: 'Reduced-size RTCP: smaller feedback packets allowed.' };
  }
  if (value.startsWith('rtcp:')) {
    return { cat: 'other', text: 'RTCP address. A placeholder (rtcp-mux is used).' };
  }
  if ((m = value.match(/^extmap:(\d+)(?:\/\S+)? (\S+)/))) {
    return {
      cat: 'other',
      text: `RTP header extension #${m[1]}: ${m[2].split(/[/:#]/).pop()}. Extra per-packet info (e.g. audio level, send time, mid, orientation).`,
    };
  }
  if (value === 'extmap-allow-mixed') {
    return { cat: 'other', text: 'One- and two-byte RTP header extensions may be mixed.' };
  }
  if ((m = value.match(/^msid-semantic:\s*(.+)$/))) {
    return { cat: 'other', text: `MediaStream semantics (${m[1]}). Legacy line.` };
  }
  if ((m = value.match(/^msid:(\S+) (\S+)$/))) {
    return {
      cat: 'other',
      text: `MediaStream id "${m[1]}" + track id "${m[2]}". The receiver uses this to build event.streams in ontrack (which tracks belong together).`,
    };
  }
  if ((m = value.match(/^ssrc-group:FID (\d+) (\d+)$/))) {
    return { cat: 'other', text: `Flow ID group: SSRC ${m[2]} carries the retransmissions (RTX) for SSRC ${m[1]}.` };
  }
  if ((m = value.match(/^ssrc:(\d+) (\w+)/))) {
    return {
      cat: 'other',
      text: `SSRC ${m[1]} (${m[2]}): a random 32-bit id identifying one outgoing RTP stream. "cname" groups streams from one participant for lip sync.`,
    };
  }
  if ((m = value.match(/^sctp-port:(\d+)$/))) {
    return { cat: 'other', text: `SCTP port ${m[1]} (inside the DTLS tunnel, not a UDP port).` };
  }
  if ((m = value.match(/^max-message-size:(\d+)$/))) {
    return { cat: 'other', text: `Largest data-channel message this side can receive: ${Number(m[1]).toLocaleString()} bytes.` };
  }
  return { cat: 'other', text: 'Attribute without a built-in explanation.' };
}
