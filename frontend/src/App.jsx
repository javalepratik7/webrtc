// App layout: nav bar on top, current page in the middle, shared log panel below.
import { Routes, Route } from 'react-router-dom';
import NavBar from './components/NavBar.jsx';
import LogPanel from './components/LogPanel.jsx';
import Home from './pages/Home.jsx';
import MediaLab from './pages/MediaLab.jsx';
import Loopback from './pages/Loopback.jsx';
import ManualSignaling from './pages/ManualSignaling.jsx';
import Room from './pages/Room.jsx';
import NotFound from './pages/NotFound.jsx';

export default function App() {
  return (
    <div className="app">
      <NavBar />
      <main className="page">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/media" element={<MediaLab />} />
          <Route path="/loopback" element={<Loopback />} />
          <Route path="/manual" element={<ManualSignaling />} />
          <Route path="/room" element={<Room />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <LogPanel />
    </div>
  );
}
