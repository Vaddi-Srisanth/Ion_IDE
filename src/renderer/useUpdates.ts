import { useCallback, useRef, useState } from 'react';
import type { UpdateStatus } from '../shared/updates';
import { errorMessage } from './documents';

const bridge = window.ion.updates;

export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>();
  const [busy, setBusy] = useState<'check' | 'download' | 'install'>();
  const [downloaded, setDownloaded] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);

  const loadStatus = useCallback(() => {
    void bridge.status().then((value) => {
      setStatus((current) => current ?? value);
      if (value.state === 'available' && value.ready) setDownloaded(value.name);
    }, () => {});
  }, []);

  const check = useCallback(async (quiet = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy('check');
    setError('');
    try {
      const next = await bridge.check();
      setStatus(next);
      setDownloaded(next.state === 'available' && next.ready ? next.name : '');
    } catch (reason) {
      if (!quiet) setError(errorMessage(reason));
    } finally {
      pending.current = false;
      setBusy(undefined);
    }
  }, []);

  const download = useCallback(async () => {
    if (pending.current || status?.state !== 'available' || downloaded) return;
    pending.current = true;
    setBusy('download');
    setError('');
    try {
      const { name } = await bridge.download();
      setDownloaded(name);
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      return message;
    } finally {
      pending.current = false;
      setBusy(undefined);
    }
  }, [status, downloaded]);

  const cancel = useCallback(() => {
    void bridge.cancel().catch((reason) => setError(errorMessage(reason)));
  }, []);

  const install = useCallback(async () => {
    if (pending.current || !downloaded) return;
    pending.current = true;
    setBusy('install');
    setError('');
    try {
      await bridge.install();
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      return message;
    } finally {
      pending.current = false;
      setBusy(undefined);
    }
  }, [downloaded]);

  return { status, busy, downloaded, error, loadStatus, check, download, cancel, install };
}

export type UpdateControls = ReturnType<typeof useUpdates>;
