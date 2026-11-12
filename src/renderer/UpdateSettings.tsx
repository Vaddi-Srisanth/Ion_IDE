import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../shared/updates';
import { errorMessage } from './documents';
import type { UpdateControls } from './useUpdates';

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

export function UpdateSettings({ onLaunch, onChange, ready, updates, onInstall }: {
  onLaunch: boolean;
  onChange(value: boolean): Promise<void>;
  ready: boolean;
  updates: UpdateControls;
  onInstall(): void;
}) {
  const { status, busy, downloaded, error, loadStatus, check, download, cancel } = updates;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  useEffect(loadStatus, [loadStatus]);

  async function saveLaunch(enabled: boolean) {
    setSaving(true);
    setSaveError('');
    try {
      await onChange(enabled);
    } catch (reason) {
      setSaveError('Could not save the update preference. ' + errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-group">
    <h3>Updates</h3>
    <label className="setting">
      <span><b>Check for updates on launch</b><small>{saving ? 'Saving preference…' : 'Contact GitHub when Ion opens.'}</small></span>
      <input type="checkbox" checked={onLaunch} disabled={!ready || saving}
        onChange={(event) => void saveLaunch(event.target.checked)}/>
    </label>
    <div className="setting">
      <div><b>{status ? `Ion ${status.current}` : 'Ion IDE'}</b>
        <p role="status">{busy === 'download' ? 'Downloading and verifying the installer…'
          : busy === 'install' ? 'Preparing the update. Your normal save confirmation will appear before restarting.'
          : downloaded ? `${downloaded} is verified and ready. Install and Restart replaces this installation and keeps your local data.`
          : status ? description(status) : 'Loading version…'}</p>
      </div>
      <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void check()}>
        {busy === 'check' ? 'Checking…' : 'Check for Updates'}
      </button>
    </div>
    {status?.notice && <p role="status">{status.notice}</p>}
    {status?.state === 'available' && !downloaded && <div className="setting">
      <span>Download the installer from GitHub.</span>
      {busy === 'download'
        ? <button className="button" type="button" onClick={cancel}>Cancel Download</button>
        : <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void download()}>Download Update</button>}
    </div>}
    {downloaded && <div className="setting">
      <span>Update the existing application. macOS or Windows may ask for security approval.</span>
      <button className="button" type="button" disabled={Boolean(busy)} onClick={onInstall}>Install and Restart</button>
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {saveError && <p className="form-error" role="alert">{saveError}</p>}
  </div>;
}
