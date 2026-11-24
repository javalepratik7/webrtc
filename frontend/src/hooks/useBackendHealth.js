// Checks GET /api/health once on mount and exposes a recheck() function.
// status: 'checking' | 'online' | 'offline'
import { useCallback, useEffect, useState } from 'react';
import { getHealth } from '../services/api.js';
import useLog from './useLog.js';

export default function useBackendHealth() {
  const { log } = useLog();
  const [status, setStatus] = useState('checking');

  const recheck = useCallback(async () => {
    setStatus('checking');
    try {
      const data = await getHealth();
      setStatus('online');
      log(`Backend online (uptime ${data.uptimeSeconds}s)`, 'success');
    } catch (err) {
      setStatus('offline');
      log(`Backend offline: ${err.message}`, 'error');
    }
  }, [log]);

  useEffect(() => {
    recheck();
  }, [recheck]);

  return { status, recheck };
}
