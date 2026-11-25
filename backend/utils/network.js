// This machine's LAN IPv4 addresses (shared by GET /api/network and the mediasoup config).
import os from 'node:os';

// Virtual interfaces (Docker, libvirt, VPN bridges) the phone can't reach.
const VIRTUAL = /^(docker|br-|virbr|veth|vmnet|vboxnet|tun|tap|lo)/;

// → [{ iface: 'wlo1', address: '192.168.0.115' }, …]
export function getLanAddresses() {
  const addresses = [];
  for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(iface)) continue;
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push({ iface, address: info.address });
    }
  }
  return addresses;
}
