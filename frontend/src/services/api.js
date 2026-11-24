// All HTTP calls to the backend live here, so pages never hard-code URLs.
// Paths are relative ("/api/..."): in dev, Vite's proxy forwards them to :4000.

async function request(path, { timeoutMs = 3000, ...options } = {}) {
  const res = await fetch(path, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function getHealth() {
  return request('/api/health');
}

// → { addresses: [{ iface, address }] }: the laptop's LAN IPs, for "open this on your phone" links.
export function getNetwork() {
  return request('/api/network');
}
