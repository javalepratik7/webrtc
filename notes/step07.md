# Step 7: Manual signaling (I am the signaling server)

Theory: `Webrtc.md` §5 (signaling), §7 (offer/answer, JSEP), §9.7 (trickle ICE).

## What I built

| File | Role |
| ---- | ---- |
| `hooks/useManualPeer.js` | One RTCPeerConnection; `createOffer` / `acceptOffer` / `acceptAnswer` / `addRemoteCandidates`; vanilla or trickle |
| `hooks/useChat.js` | Chat over any RTCDataChannel (JSON `{type:'chat', text, ts}`); reused in step 9 |
| `components/ChatBox.jsx` | Chat UI (presentational) |
| `components/CopyBox.jsx` | Read-only text + Copy button (Clipboard API) |
| `pages/ManualSignaling.jsx` | Role (Caller/Callee) × mode (non-trickle/trickle), numbered steps, live states, chat |

## How to use it

Two tabs, two browsers, or laptop + phone (`https://<LAN-IP>:5173/manual`).

**Non-trickle** (one message each way)

1. Caller: *Create data channel "chat" + offer*, wait ≤ 3 s, **Copy**
2. Callee: paste → *Apply offer + create answer*, **Copy**
3. Caller: paste → *Apply answer* → connected, chat

**Trickle**: the same, but the SDPs carry **no candidates**. Each side then also has to copy its
candidates and paste them into the other side's *addIceCandidate* box.

## Why this proves signaling is just delivering text

Everything that crossed between the tabs was **a string that went through my clipboard**:

- `JSON.stringify(pc.localDescription)` → `{"type":"offer","sdp":"v=0\r\n…"}`
- `JSON.stringify(event.candidate)` → `{"candidate":"candidate:… typ host …","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"…"}`

The two browsers shared nothing else: no server, no cookies, no BroadcastChannel (the test used
two isolated browser contexts). The backend wasn't involved at all.

WebRTC doesn't care *how* the text travels: clipboard, email, a QR code, a WebSocket, a carrier pigeon.
It only needs:

1. the **right text** (unmodified: one changed character in `a=fingerprint` and DTLS refuses),
2. delivered to the **right peer**,
3. in the **right order** (remote description before candidates),
4. and for trickle, **fast enough**.

That's exactly the job description for the step 8 Socket.IO server: a relay for text messages,
which never looks inside the SDP. Once the text is delivered, the media/data flows **directly
between the browsers**; the signaling path isn't used for any of it.

## Why trickle needs a real-time channel

Trickle mode made it painful:

- The SDP is ready **instantly** (517 chars, 0 candidates), but it's useless on its own:
  `iceConnectionState` stays **`new`** until candidates arrive. Without remote candidates there's nothing to check.
- Candidates show up **over time** (host after ~5 ms, srflx after ~110 ms; TURN would be later still). A human
  copying them is thousands of times slower than gathering itself, and has to keep checking for new ones.
- It goes **both ways**, interleaved with the offer/answer, and **order matters**: pasting candidates before
  the remote description fails with `InvalidStateError`. A real app **queues** early candidates.
- Trickle exists to *start connectivity checks earlier*. That only pays off if each candidate is
  delivered within milliseconds, so it needs a push channel (WebSocket, Socket.IO), not polling and not a human.

Non-trickle needs only one message each way, but it **waits for gathering**, and that has its own trap.

### Non-trickle trap: gathering "complete" took 40 s

Measured here: host at 5 ms, srflx at 110 ms, then **nothing until 39.9 s**, when
`icecandidateerror 701 "STUN binding request timed out"` fired for the **IPv6** address of
stun.l.google.com (this machine has no working IPv6 route). Only then did `iceGatheringState` become `complete`.

So `waitForIceGathering` gives up after **3 s** and sends what it has. Real vanilla-ICE apps do the same.

## Things I observed

- **Callee's ICE connects before the caller even has the answer.** After the callee applies the offer,
  its connectivity checks reach the caller. The checks are signed with the *caller's* ICE password (which
  the callee got from the offer), so the caller can verify and answer them. The callee shows `iceConnectionState:
  connected` but `connectionState: connecting`: DTLS can't finish until the caller applies the answer
  (it needs the callee's fingerprint).
- **Trickle with candidates carried in ONE direction only still connected.** I pasted the caller's
  candidates into the callee and never pasted the callee's into the caller. The callee sent checks to the
  caller, and the caller learned the callee's address from those incoming packets: a **peer-reflexive
  (prflx)** candidate. Not something to rely on (a strict NAT/firewall on the caller's side would drop
  those unsolicited packets), but it shows how ICE fills in gaps.
- **Closing the other tab**: the caller stayed `connected` for ~5 s, then `disconnected` (consent
  freshness checks stopped being answered), then `failed` at ~15 s. **The data channel still said
  `readyState: "open"`**, and `dc.close()` / `pc.close()` change `readyState` **without firing events**.
  So `useChat` also takes `connectionState` and treats `failed`/`closed` as a dead chat, and the peer hook
  closes the channel on `failed`.
- The **caller must create the data channel before `createOffer()`**, otherwise the offer has no
  `m=application` section and there's nothing to negotiate. The callee doesn't create one: it receives
  it via `ondatachannel`.
- Offer size: ~780 chars with 2 candidates (vanilla) vs ~517 without (trickle). A data-only SDP is small enough
  for a QR code. A video SDP (~4–6 KB) isn't, really.

## Glare and roles

Only one side may send the offer. If both tabs press "Create offer", both are in `have-local-offer`, and
applying the other's *offer* fails. That's **glare**. Here a human picks the roles. In step 8 the server
or the join order decides (e.g. "the second one to join makes the offer"). The general fix is
"perfect negotiation" (polite/impolite peer, rollback).

## Exercises

1. **Phone ↔ laptop.** Do the non-trickle flow between your phone and laptop on the same Wi-Fi
   (`https://192.168.0.115:5173/manual`). Which candidate pair gets selected? (Use the step 6 page to
   remember how to read them, or add a "Stats" button here.)
2. **Tamper test.** Change one hex digit of `a=fingerprint` in the offer before pasting it. Which step
   fails, and with what error/state? Then change `a=ice-pwd` instead. What's different?
3. **Queue early candidates.** In trickle mode, make `addRemoteCandidates` *queue* candidates that arrive
   before the remote description and flush them after `setRemoteDescription`. Step 8 needs this anyway.
4. **QR code.** Encode the data-only vanilla offer as a QR code and scan it with the phone. Is it
   still "signaling"? (Yes: any channel that delivers the text counts.)
