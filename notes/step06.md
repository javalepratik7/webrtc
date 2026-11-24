# Step 6: Connection Inspector (SDP, ICE, getStats)

Theory: `Webrtc.md` §6, §9.4, §11, §21.1.

> Step 5 (the loopback itself) was built as part of this step, since the inspector needs a
> connection to inspect. The loopback flow is summarised in the first section.

## What I built

| File | Role |
| ---- | ---- |
| `services/webrtc.js` | `ICE_CONFIG` (stun.l.google.com:19302), `parseCandidate`, `waitForIceGathering`, `collectStats` |
| `services/sdp.js` | `parseSdp` (session + m-sections), `summarizeSdp`, `explainLine` (plain-English per line) |
| `hooks/useLoopback.js` | Two RTCPeerConnections A → B, all four state machines, candidates, SDPs, trickle/non-trickle |
| `components/SdpViewer.jsx` | Colour-coded SDP, hover/click explanations, offer/answer, as-created/after-gathering, pin & compare |
| `components/CandidateTable.jsx` | Every candidate parsed, type legend, srflx + mDNS explanations |
| `components/StatsPanel.jsx` | Selected pair, RTT, codec, bytes, kbps, fps, data-channel counters |
| `pages/Loopback.jsx` | Checkboxes (audio / video / data / STUN / trickle), Connect, Hang up, Stats (+ auto 1 s) |

## The loopback flow (step 5)

```
A.addTrack / A.createDataChannel        ← what to negotiate
A.createOffer → A.setLocalDescription   ← A starts gathering candidates
              → B.setRemoteDescription
B.createAnswer → B.setLocalDescription  ← B starts gathering
               → A.setRemoteDescription
A.onicecandidate → B.addIceCandidate     (and B → A): trickle ICE
ICE checks pairs → DTLS handshake → connected → B.ontrack / B.ondatachannel
```

- The "signaling channel" is a plain function call. In step 7 it becomes copy/paste, in step 8 Socket.IO.
- **Order matters**: `addIceCandidate` before `setRemoteDescription` throws. It's safe here because
  candidate events are tasks and fire after the awaited `setRemoteDescription` call has been queued.
- `pc.close()` fires **no** state-change events. The UI has to reset itself.
- The remote `<video>` is muted too: in a loopback the "remote" audio is your own mic, which means feedback.

## Reading SDP

```
v=0                                   version, always 0
o=- 8218294039643242423 2 IN IP4 127.0.0.1    session id + VERSION (bumps on renegotiation); address unused
s=-  t=0 0                            ignored by WebRTC
a=group:BUNDLE 0 1                    mids 0 and 1 share ONE transport (one ICE + DTLS, one port)
m=video 9 UDP/TLS/RTP/SAVPF 96 97 …   new media section; port 9 = placeholder; PTs in preference order
c=IN IP4 0.0.0.0                      placeholder: real addresses come from ICE
a=ice-ufrag / a=ice-pwd               credentials for STUN connectivity checks
a=fingerprint:sha-256 92:E5:…         hash of the DTLS certificate: binds encryption to signaling
a=setup:actpass                       DTLS role: offer is always actpass; answer picks active/passive
a=mid:0                               names the m-section (BUNDLE, transceiver.mid, candidate.sdpMid)
a=sendrecv                            direction
a=rtpmap:96 VP8/90000                 payload type 96 = VP8, 90 kHz RTP clock
a=rtcp-fb:96 nack pli                 feedback: retransmit requests, keyframe requests
a=rtpmap:97 rtx/90000                 PT 97 = retransmissions…
a=fmtp:97 apt=96                      …of PT 96
```

Observations from comparing checkbox combos:

- **One m-section per transceiver** (each audio/video track) + **one `m=application` for ALL data channels**.
  Data only gives 17 lines; video + data gives about 140 (the video section alone is 123: 23 payload types,
  extmaps, rtcp-fb…).
- Nothing selected means no m-sections at all, so nothing to negotiate and **ICE never starts**.
- Data channel section: `m=application 9 UDP/DTLS/SCTP webrtc-datachannel`, `a=sctp-port:5000`, no codecs.
- The answer **mirrors** the offer: same number of m-sections in the same order, and it picks
  `a=setup:active` (B becomes the DTLS client). The answer can only narrow what the offer allows, not add to it.
- Audio: Opus is PT 111 with `fmtp minptime=10;useinbandfec=1`.
- Video codec preference in Chrome: VP8, then H.264 (several profiles), AV1, VP9. The first one both sides support wins.
- **As created vs after gathering**: with trickle ICE the SDP from `createOffer()` has **no candidates**;
  they're sent separately. `pc.localDescription` later contains them as `a=candidate` lines.

## ICE candidates

```
candidate:1639054149 1 udp 1677729535 <public IP> 35747 typ srflx raddr 0.0.0.0 rport 0
          foundation  │  proto priority  address       port     type   related (base) address
                 component (1 = RTP; rtcp-mux → never 2)
```

- **priority** = `2^24·typePref + 2^8·localPref + (256 − component)`. The top byte is the type preference:
  host 126 > prflx 110 > srflx 100 > relay 0. That's why 2122260223 (host) beats 1686052607 (srflx).
- **host**: my interfaces. Here that's the LAN (192.168.0.115) **and Docker's bridge** (172.18.0.1). Every
  interface gets candidates.
- **srflx**: my public IP as seen by the STUN server, `raddr` = the local base it maps to.
- **prflx**: learned during the checks. In the stats, A's selected remote was `prflx` because B's packets
  arrived before B's candidate did. Chrome hides that address.
- **relay**: TURN (not configured yet).
- **TCP candidates with port 9 / `tcptype active`**: they'll connect *out* to the peer, so there's no listening port.
- With BUNDLE, A gathers for mid 0 *and* mid 1 at first (the answer hasn't said "bundle" yet). After the
  answer only mid 0's transport is used, so B only gathers for mid 0.

### Why `xxxxxxxx-….local` (mDNS)

A web page learning your private IP (192.168.x.x) is a privacy leak: fingerprinting, and mapping your
home network. So browsers replace host IPs with a random **`UUID.local`** name, registered via
multicast DNS on the LAN. A peer on the same network can resolve it; a website can't learn anything from it.

- **Once the page has camera/mic permission**, browsers show the real IPs (you've trusted the site already).
  Compare "data only" (mDNS) with "video" (real IPs). The stats then also show `(hidden)` for mDNS addresses.
- Without permission, srflx shows `raddr 0.0.0.0`, so even the *base* address is hidden.

### Why the srflx candidate didn't appear at first

In a loopback both peers find each other via host candidates in about **60 ms**, and **Chrome ends gathering
as soon as it's connected**. That's before the STUN reply comes back from Google, so no srflx gets reported.
In a real call, signaling through a server takes longer and the srflx shows up.
Fix in the inspector: untick **trickle ICE** (non-trickle / "vanilla" ICE): each peer waits for
`iceGatheringState === 'complete'` and sends `localDescription` with every candidate inside the SDP.
Result: one srflx per interface (`raddr` = 192.168.0.115 and 172.18.0.1 → the same public IP).

**Trickle vs non-trickle**: trickle sends candidates as they're found, so it connects faster. Vanilla sends
everything at once, which is simpler (one message each way) but waits for the slowest STUN/TURN server. Trickle is standard.

## getStats()

`getStats()` returns a Map of ~20–50 reports linked by ids:

```
transport.selectedCandidatePairId → candidate-pair → local-candidate / remote-candidate
outbound-rtp.codecId → codec           inbound-rtp (on B) → codec
data-channel (messagesSent / messagesReceived)
```

- Loopback numbers: RTT about 1 ms, VP8 640×360 at 19–20 fps, ~190 kbps right after connecting
  (the bandwidth estimator starts low and ramps up), 0 packets lost, data channel 1 message / 12 bytes.
- Counters (`bytesSent`) are cumulative. **Rates need two samples** (Δbytes·8 / Δms = kbps), which is why
  the first "Stats" click shows `-` for kbps and auto-refresh is useful.
- Firefox has no `transport.selectedCandidatePairId`; use `candidate-pair.selected` instead.

## Quiz: reading SDP

1. An offer has `a=group:BUNDLE 0 1 2` and three m-sections: `m=audio`, `m=video`, `m=application`.
   How many ICE connections and DTLS handshakes will there be, and what was added to create each m-section?
2. You see `m=video 9 UDP/TLS/RTP/SAVPF 96 97 98` and `c=IN IP4 0.0.0.0`. The peer is at 192.168.0.42.
   Why doesn't the SDP say so, and where does the real address come from?
3. The offer says `a=setup:actpass` and the answer says `a=setup:active`. Which peer starts the DTLS handshake,
   and what stops a man-in-the-middle who rewrites the SDP's candidates from decrypting the media?
4. Given `a=rtpmap:96 VP8/90000`, `a=rtpmap:97 rtx/90000`, `a=fmtp:97 apt=96`, `a=rtcp-fb:96 nack pli`:
   a packet of PT 96 gets lost. Describe what happens, naming which line enables each part.
5. You call `pc.addTransceiver('video', { direction: 'recvonly' })` and create an offer.
   What direction attribute will the m-section have, what will a normal answering browser put in its answer
   (it has a camera track to send), and why can't it answer `sendrecv`?

<details>
<summary>Answers</summary>

1. **One** ICE connection and **one** DTLS handshake: BUNDLE puts all three mids on one transport.
   `m=audio` came from an audio `addTrack`/transceiver, `m=video` from a video one, and `m=application` from
   `createDataChannel` (one section no matter how many channels).
2. Port 9 and 0.0.0.0 are **placeholders**. With ICE the address isn't known when the SDP is created,
   and there are many candidates anyway. Real addresses come from **ICE candidates**: trickled through
   `onicecandidate` → `addIceCandidate`, or as `a=candidate` lines in a non-trickle SDP.
3. `active` = the **answerer (B) is the DTLS client** and starts the handshake. The
   **`a=fingerprint`** in each SDP is the hash of that peer's certificate. Each side checks the certificate
   presented in the DTLS handshake against it, so an attacker relaying packets can't substitute their own keys.
   (They'd have to tamper with the fingerprint in the *signaling channel*, which is why signaling must use HTTPS/WSS.)
4. The receiver detects the gap in sequence numbers and sends an RTCP **NACK** (`a=rtcp-fb:96 nack`). The sender
   retransmits the packet on **PT 97 (RTX)**, which `apt=96` says repairs PT 96. If the loss is too bad to repair,
   the receiver sends a **PLI** (`a=rtcp-fb:96 nack pli`) and the sender produces a new keyframe.
5. The offer has `a=recvonly`. The answerer can at most send, so it answers **`a=sendonly`** (if it attaches a
   track to that transceiver) or `a=inactive`. It can't answer `sendrecv`, because the offerer said it won't
   send: an answer can only narrow the offered direction, never widen it.

</details>

## Exercises

1. Restart ICE: add a button that calls `pcA.restartIce()` and renegotiates. Which SDP lines change
   (`o=` version, `ice-ufrag`/`ice-pwd`)? Which stay the same (fingerprint)?
2. Codec preference: use `transceiver.setCodecPreferences()` to put VP9 (or H.264) first, then confirm in
   the SDP and in the stats codec column.
3. Break it on purpose: drop all candidates in the trickle handler (don't call `addIceCandidate`) and watch
   which states get stuck. Then try non-trickle with no STUN. Does it still connect, and why?
