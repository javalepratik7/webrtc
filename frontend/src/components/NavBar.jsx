// Top navigation. NavLink adds an "active" class to the link for the current URL.
import { NavLink } from 'react-router-dom';

const links = [
  { to: '/', label: 'Home', end: true },
  { to: '/media', label: 'Media Lab' },
  { to: '/loopback', label: 'Loopback' },
  { to: '/manual', label: 'Manual Signaling' },
  { to: '/room', label: 'Room' },
];

export default function NavBar() {
  return (
    <nav className="navbar">
      <span className="brand">WebRTC Lab</span>
      {links.map(({ to, label, end }) => (
        <NavLink key={to} to={to} end={end}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
