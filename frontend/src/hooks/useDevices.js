// Lists cameras, mics and speakers with enumerateDevices(), and keeps the list
// fresh when devices are plugged in/out ('devicechange').
//
// refreshKey: pass something that changes when permission may have been granted
// (e.g. the stream). Labels only appear after permission, and not every browser
// fires 'devicechange' at that moment, so we re-enumerate then too.
import { useCallback, useEffect, useState } from 'react';
import useLog from './useLog.js';

export default function useDevices(refreshKey) {
  const { log } = useLog();
  const [devices, setDevices] = useState([]);

  const refresh = useCallback(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    // MediaDeviceInfo objects → plain objects for React state.
    setDevices(list.map(({ deviceId, groupId, kind, label }) => ({ deviceId, groupId, kind, label })));
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices) return undefined;
    refresh();
    const onChange = () => {
      log('devicechange: a device was added or removed');
      refresh();
    };
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [refresh, log]);

  useEffect(() => {
    if (refreshKey && navigator.mediaDevices) refresh();
  }, [refreshKey, refresh]);

  return {
    cameras: devices.filter((d) => d.kind === 'videoinput'),
    mics: devices.filter((d) => d.kind === 'audioinput'),
    speakers: devices.filter((d) => d.kind === 'audiooutput'),
    // Before permission: labels are '' (and deviceIds are '' too in Chrome/Safari).
    hasLabels: devices.some((d) => d.label),
    refresh,
  };
}
