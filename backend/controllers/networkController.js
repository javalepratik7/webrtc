// GET /api/network → this machine's LAN IPv4 addresses.
// A browser on https://localhost can't know the laptop's LAN IP, but the phone
// needs it (https://<LAN-IP>:5173). Dev helper only: in production you would
// not advertise internal addresses.
import os from 'node:os';

// Virtual interfaces (Docker, libvirt, VPN bridges) the phone can't reach.
const VIRTUAL = /^(docker|br-|virbr|veth|vmnet|vboxnet|tun|tap|lo)/;

export function getNetwork(req, res) {
  const addresses = [];
  for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(iface)) continue;
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push({ iface, address: info.address });
    }
  }
  res.json({ addresses });
}
