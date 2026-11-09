import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../shared/updates';
import { errorMessage } from './documents';

function description(status: UpdateStatus): string {
  switch (status.state) {
    case 'unchecked': return 'Check the Ion IDE releases on GitHub.';
    case 'current': return 'You have the latest version.';
    case 'no-release': return 'There is no published Ion IDE release yet.';
    case 'unsupported': return 'Installer updates are unavailable for this build.';
    case 'asset-missing': return `Ion ${status.latest} is newer, but a verified installer for this device is unavailable.`;
    case 'available': return `Ion ${status.latest} is available (${Math.ceil(status.bytes / 1024 ** 2)} MiB).`;
  }
}

export function UpdateSettings({ onLaunch, onChange }: { onLaunch: boolean; onChange(value: boolean): void }) {
  const [status, setStatus] = useState<UpdateStatus>();
  const [busy, setBusy] = useState<'check' | 'download'>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const bridge = window.ion.updates;
  useEffect(() => {
    let mounted = true;
    void bridge.status().then((value) => { if (mounted) setStatus(value); }, () => {});
    return () => { mounted = false; };
  }, [bridge]);

  async function perform(action: 'check' | 'download') {
    if (busy) return;
    setBusy(action);
    setNotice('');
    setError('');
    try {
      if (action === 'check') setStatus(await bridge.check());
      else {
        const { name } = await bridge.download();
        setNotice(`${name} is ready in Downloads. Save your work and quit Ion before opening the installer.`);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return <div className="settings-group">
    <h3>Updates</h3>
    <label className="setting">
      <span><b>Check for updates on launch</b><small>Contact GitHub when Ion opens.</small></span>
      <input type="checkbox" checked={onLaunch} onChange={(event) => onChange(event.target.checked)}/>
    </label>
    <div className="setting">
      <div><b>{status ? `Ion ${status.current}` : 'Ion IDE'}</b>
        <p role="status">{busy === 'download' ? 'Downloading and verifying the installer…' : notice || (status ? description(status) : 'Loading version…')}</p>
      </div>
      <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void perform('check')}>
        {busy === 'check' ? 'Checking…' : 'Check for Updates'}
      </button>
    </div>
    {status?.state === 'available' && !notice && <div className="setting">
      <span>Download the installer from GitHub.</span>
      {busy === 'download'
        ? <button className="button" type="button" onClick={() => void bridge.cancel()}>Cancel Download</button>
        : <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void perform('download')}>Download Update</button>}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
