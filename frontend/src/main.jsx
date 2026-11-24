// Bootstraps React: mounts <App/> inside the router and the shared log provider.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { LogProvider } from './context/LogContext.jsx';
import App from './App.jsx';
import './index.css';

// StrictMode mounts components twice in dev on purpose. Annoying at first,
// but it forces us to write proper cleanup: stopping camera tracks and closing
// RTCPeerConnections, which matters a lot from Step 3 on.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <LogProvider>
        <App />
      </LogProvider>
    </BrowserRouter>
  </StrictMode>,
);
