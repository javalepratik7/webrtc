// GET /api/network → this machine's LAN IPv4 addresses.
// A browser on https://localhost can't know the laptop's LAN IP, but the phone
// needs it (https://<LAN-IP>:5173). Dev helper only: in production you would
// not advertise internal addresses.
import { getLanAddresses } from '../utils/network.js';

export function getNetwork(req, res) {
  res.json({ addresses: getLanAddresses() });
}
