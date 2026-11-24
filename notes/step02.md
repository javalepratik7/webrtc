# Step 2: HTTPS & LAN access

Theory: `Webrtc.md` §12.5 (Permissions & privacy).

## The problem

The phone on the same Wi-Fi opens `http://192.168.0.115:5173` and camera access fails.
`navigator.mediaDevices` is `undefined` there, so the code doesn't even get to ask for permission.

## Secure context

A **secure context** is a page the browser trusts not to have been tampered with in transit:

- anything served over `https://` (or `wss://`)
- `http://localhost`, `http://127.0.0.1`, `http://[::1]` (traffic never leaves the machine)
- `file://` URLs (varies by browser)

`http://192.168.x.x` is **not** secure: it crosses the network in plain text.

Check with `window.isSecureContext`.

### Why getUserMedia requires it

Camera and mic access is a powerful feature. On plain HTTP, anyone on the network path
(public Wi-Fi, a bad router, the ISP) can **inject or modify the page's JavaScript**. That
injected script would then run with whatever camera permission the user gave the origin,
including permissions remembered from earlier visits. HTTPS ensures the code asking
for the camera is the code the site actually served.

So browsers don't just make the call fail on insecure origins. They **remove
`navigator.mediaDevices` entirely**. Other powerful APIs (Service Workers,
geolocation, clipboard, WebAuthn) follow the same rule.

Note: `RTCPeerConnection` itself works on HTTP, but without a camera/mic there's not much to send.
In practice, treat HTTPS as required.

## mkcert

A normal self-signed cert gives a scary warning everywhere. **mkcert** creates a
**local Certificate Authority (CA)** and signs dev certs with it. Trust that CA once
and every cert it signs is trusted.

```bash
sudo apt install mkcert libnss3-tools   # libnss3-tools = certutil, for Chrome/Firefox's NSS store
mkcert -install                          # adds the local CA to system + browser trust stores
mkcert -CAROOT                           # -> ~/.local/share/mkcert (rootCA.pem = public, rootCA-key.pem = SECRET)

cd frontend && mkdir -p certs
mkcert -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem \
  localhost 127.0.0.1 ::1 192.168.0.115
```

- The cert lists every name/IP it's valid for (Subject Alternative Names). If my LAN IP
  changes (DHCP), **regenerate the cert** with the new IP. A DHCP reservation on the router avoids this.
  Inspect: `openssl x509 -in certs/dev-cert.pem -noout -ext subjectAltName`.
- `frontend/certs/` is gitignored. Certs are per-machine, and the key is private.
- **Never share `rootCA-key.pem`.** Anyone with it can create certs my devices trust for *any* site.

## Vite config

```js
server: {
  host: true,                       // listen on 0.0.0.0, not just localhost
  https: { cert, key },             // read from ./certs
  proxy: {
    '/api': 'http://localhost:4000',
    '/socket.io': { target: 'http://localhost:4000', ws: true },  // step 8
  },
}
```

- `host: true`: by default Vite only listens on `localhost`, so the phone can't connect.
- `ws: true`: Socket.IO upgrades from HTTP polling to a WebSocket. The proxy has to forward
  the `Upgrade` handshake too. Browser → `wss://<ip>:5173/socket.io` → Vite → `ws://localhost:4000/socket.io`.
- `strictPort: true`: if 5173 is taken, fail instead of silently using 5174.

## Why the backend can stay plain HTTP

```
phone ──HTTPS──▶ Vite :5173 (laptop) ──HTTP──▶ Express localhost:4000 (same laptop)
```

- The browser only ever sees **one origin**: `https://<ip>:5173`. Secure-context rules apply
  to what the *browser* talks to, and it never talks to `:4000`.
- The HTTP hop is **laptop → laptop over loopback**. It never touches the network, so there's
  nothing to sniff or tamper with.
- If the page called `http://192.168.0.115:4000` directly, that would be **mixed content**
  (HTTP from an HTTPS page), and the browser would block it. It would also be cross-origin, so CORS would apply.
  Proxying avoids both.
- Same origin also means no CORS for `/api`, and in step 8 Socket.IO can connect with
  `io()` (no URL), since it defaults to the page's own origin.
- In production, a reverse proxy (nginx/Caddy/a load balancer) plays Vite's role: it terminates TLS and forwards to Node over HTTP.

## Trusting the cert on the phone

The phone doesn't know my local CA. Two options:

**A. Just accept the warning (quickest for testing).** Open `https://192.168.0.115:5173`.
Chrome: *Advanced → Proceed*. Safari: *Show Details → visit this website*.
The page is still a secure context, so `getUserMedia` works. The address bar just shows "Not secure".

**B. Install the mkcert root CA (no warnings).** Copy **only `rootCA.pem`** (never the key)
from `$(mkcert -CAROOT)` to the phone (USB, cloud drive, or temporarily serve it).

- **Android:** Settings → Security & privacy → More security settings → Encryption & credentials →
  Install a certificate → **CA certificate** → pick `rootCA.pem` → accept the warning.
  (Menu names vary by vendor; search Settings for "CA certificate".) Chrome on Android trusts
  user-installed CAs. Firefox for Android needs *Settings → About → tap logo 5× → Secret settings → Use third-party CA certificates*.
- **iPhone:** AirDrop/email `rootCA.pem` → Settings → *Profile Downloaded* → Install.
  Then **also** Settings → General → About → **Certificate Trust Settings** → enable full trust
  for the mkcert root. (The second step is easy to miss.)

Remove the CA from the phone when you're done with the project.

## Checklist

- [x] `https://localhost:5173`: Environment card shows secure context ✅, mediaDevices ✅, backend online
- [ ] `https://192.168.0.115:5173` from the phone: same three green (verify on the device)
- [x] `http://192.168.0.115:5173` no longer answers (the server only speaks HTTPS now)
- [x] `/api` and `/socket.io` (including WebSocket upgrade) proxy through to Express

## Gotchas

- Ubuntu firewall: if the phone times out, `sudo ufw allow 5173/tcp`.
- Phone on a guest network or with "AP/client isolation" enabled on the router can't reach the laptop.
- If the IP changes, update the cert, not the code. `host: true` already listens on every interface.
