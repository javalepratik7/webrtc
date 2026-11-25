// mediasoup settings (step 14). Env values come from config/index.js.
//
// ---------------------------------------------------------------------------
// listenIp vs announcedIp: THE setting that makes or breaks an SFU
// ---------------------------------------------------------------------------
// mediasoup is "ICE-lite": it doesn't gather candidates or use STUN. It just
// tells the browser "send your media to <address>:<port>" (its ICE candidates)
// and answers the browser's connectivity checks there.
//
//   listenIp    = where the worker BINDS its UDP/TCP sockets on this machine.
//                 0.0.0.0 = every interface (Wi-Fi, Ethernet, Docker bridge…).
//   announcedIp = the address written INTO the ICE candidates sent to browsers.
//
// 0.0.0.0 can't be announced ("send to 0.0.0.0" means nothing to the phone),
// so with a wildcard bind you MUST announce a reachable address:
//   - dev on Wi-Fi: the laptop's LAN IP (192.168.x.x). The phone on the same
//     Wi-Fi can reach it; "localhost" or 127.0.0.1 would point the phone at ITSELF.
//   - EC2 later: the instance's network card only has a PRIVATE IP (172.31.x.x);
//     AWS maps the public / Elastic IP onto it (1:1 NAT). Bind 0.0.0.0, announce
//     the PUBLIC IP, and open the port range (UDP + TCP) in the security group.
//     Announce the private IP there and every browser on the internet gets a
//     candidate it can't reach → ICE fails after ~30 s, with no error anywhere.
//
// ---------------------------------------------------------------------------
// Ports: every WebRtcTransport takes one port per protocol from the range. Each
// user has 2 transports (send + recv) → with UDP + TCP enabled that's 4 ports per
// user, so 40000–40100 (101 ports) is enough for ~25 users per machine. Plenty
// for learning. Production setups often use a WebRtcServer instead (ONE port
// per worker shared by all transports), so only a few ports need opening.
import config from '../config/index.js';

const ms = config.mediasoup;

export default {
  numWorkers: ms.numWorkers,

  worker: {
    logLevel: 'warn', // 'debug' | 'warn' | 'error' | 'none'
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  },

  // A Router = one "room" inside a worker. Its codecs are what this room speaks:
  // every producer must send one of these, and every consumer receives one of them.
  // The SFU NEVER transcodes: if A sends VP8, B must be able to decode VP8.
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: { 'x-google-start-bitrate': 1000 },
      },
      {
        kind: 'video',
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: { 'profile-id': 0, 'x-google-start-bitrate': 1000 },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f', // Constrained Baseline 3.1: what Safari/iOS hardware encoders do
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000,
        },
      },
    ],
  },

  webRtcTransport: {
    listenInfos: [
      { protocol: 'udp', ip: ms.listenIp, announcedAddress: ms.announcedIp, portRange: { min: ms.rtcMinPort, max: ms.rtcMaxPort } },
      // TCP fallback: for networks that block UDP (some corporate / hotel Wi-Fi).
      { protocol: 'tcp', ip: ms.listenIp, announcedAddress: ms.announcedIp, portRange: { min: ms.rtcMinPort, max: ms.rtcMaxPort } },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    // What the server assumes it may SEND to a browser before bandwidth estimation kicks in.
    initialAvailableOutgoingBitrate: 1_000_000,
  },
  // Applied after creating each transport with transport.setMaxIncomingBitrate():
  // caps what ONE user may send us (protects the server's downlink and the other users).
  maxIncomingBitrate: 3_000_000,

  // Safety limit: an SFU room can be much bigger than a mesh (step 13: ~4).
  maxPeersPerRoom: 20,
};
