import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Accent, Settings } from '../shared/contracts';
import type { ThemeData } from '../shared/themes';
import { Icon } from './icons';
import { ThemeSettings } from './themes/ThemeSettings';
import { ShortcutSettings } from './ShortcutSettings';
import { UpdateSettings } from './UpdateSettings';
import type { ShortcutOverrides } from '../shared/shortcuts';
import { starterLanguages, type StarterLanguage } from '../shared/starter-code';

export function Modal({ title, className = '', children, onClose, busy = false }: {
  title: string; className?: string; children: ReactNode; onClose(): void; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog className={`modal ${className}`} ref={ref} aria-label={title}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="modal-content">
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}><Icon name="x" size={16}/></button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

const accents: Accent[] = ['cyan', 'violet', 'lime', 'amber'];

export function PreferencesDialog({ settings, activeTheme, onThemeChange, onChange, onUpdateLaunchChange,
  preferencesReady, onShortcutChange, onExportProfile, onClose }: {
  settings: Settings;
  activeTheme: ThemeData | null;
  onThemeChange(id: string): Promise<void>;
  onChange(patch: Partial<Settings>): void;
  onUpdateLaunchChange(enabled: boolean): Promise<void>;
  preferencesReady: boolean;
  onShortcutChange(overrides: ShortcutOverrides): Promise<void>;
  onExportProfile(): Promise<string | null>;
  onClose(): void;
}) {
  const themeSupportsAccent = ['dark', 'light', 'system'].includes(settings.theme);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ message: string; error?: boolean } | null>(null);
  const exportProfile = async () => {
    setExportBusy(true);
    setExportStatus(null);
    try {
      const path = await onExportProfile();
      if (path) setExportStatus({ message: `Exported local profile to ${path}` });
    } catch (reason) {
      setExportStatus({ message: reason instanceof Error ? reason.message : String(reason), error: true });
    } finally {
      setExportBusy(false);
    }
  };
  return (
    <Modal title="Preferences" className="preferences" onClose={onClose} busy={exportBusy}>
      <UpdateSettings onLaunch={settings.checkUpdatesOnLaunch} onChange={onUpdateLaunchChange} ready={preferencesReady}/>
      <div className="settings-group">
        <h3>Window</h3>
        <div className="setting">
          <div><label htmlFor="open-full-screen"><b>Open in full screen</b></label>
            <p id="open-full-screen-hint">Applies the next time Ion opens a window.</p>
          </div>
          <input id="open-full-screen" type="checkbox" aria-describedby="open-full-screen-hint"
            checked={settings.openFullScreen} onChange={(event) => onChange({ openFullScreen: event.target.checked })}/>
        </div>
      </div>
      <div className="settings-group">
        <h3>Appearance</h3>
        <ThemeSettings selection={settings.theme} activeTheme={activeTheme} onSelect={onThemeChange}/>
        {themeSupportsAccent && <div className="setting">
          <div><b>Accent</b><p>Color for controls and active panes.</p></div>
          <div className="swatches" aria-label="Accent color">
            {accents.map((accent) => <button className={`swatch ${accent}`} key={accent} aria-label={accent}
              aria-pressed={settings.accent === accent} onClick={() => onChange({ accent })}>
              {settings.accent === accent && <Icon name="check" size={13}/>}
            </button>)}
          </div>
        </div>}
      </div>

      <div className="settings-group">
        <h3>Resources</h3>
        <div className="setting">
          <div><label htmlFor="resource-profile"><b>Resource profile</b></label>
            <p>Full Mode allows the online planner and opt-in project tests on save.</p>
          </div>
          <select id="resource-profile" data-testid="resource-profile" value={settings.resourceProfile}
            onChange={(event) => onChange({ resourceProfile: event.target.value === 'full' ? 'full' : 'minimal' })}>
            <option value="minimal">Minimal Mode</option>
            <option value="full">Full Mode</option>
          </select>
        </div>
      </div>

      <div className="settings-group">
        <h3>Editor</h3>
        <div className="setting">
          <label htmlFor="font-size">Font size</label>
          <select id="font-size" value={settings.fontSize} onChange={(event) => onChange({ fontSize: Number(event.target.value) })}>
            {Array.from({ length: 23 }, (_, i) => i + 10).map((size) => <option key={size} value={size}>{size} px</option>)}
          </select>
        </div>
        <div className="setting">
          <label htmlFor="tab-size">Tab width</label>
          <select id="tab-size" value={settings.tabSize} onChange={(event) => onChange({ tabSize: Number(event.target.value) })}>
            {Array.from({ length: 8 }, (_, i) => i + 1).map((size) => <option key={size} value={size}>{size} spaces</option>)}
          </select>
        </div>
        <label className="setting">Line numbers<input type="checkbox" checked={settings.lineNumbers}
          onChange={(event) => onChange({ lineNumbers: event.target.checked })}/></label>
        <label className="setting">Word wrap<input type="checkbox" checked={settings.wordWrap}
          onChange={(event) => onChange({ wordWrap: event.target.checked })}/></label>
      </div>

      <div className="settings-group">
        <h3>Files</h3>
        <label className="setting">
          <span><b>Autosave</b><small>Save changes to files that already have a location.</small></span>
          <input type="checkbox" checked={settings.autoSave} onChange={(event) => onChange({ autoSave: event.target.checked })}/>
        </label>
        <div className="setting">
          <label htmlFor="save-delay">Autosave delay</label>
          <select id="save-delay" value={settings.autoSaveDelay} disabled={!settings.autoSave}
            onChange={(event) => onChange({ autoSaveDelay: Number(event.target.value) })}>
            {[...new Set([500, 900, 1500, 3000, 5000, settings.autoSaveDelay])].sort((a, b) => a - b)
              .map((delay) => <option key={delay} value={delay}>{delay} ms</option>)}
          </select>
        </div>
      </div>

      <div className="settings-group">
        <h3>Run Console</h3>
        <label className="setting">
          <span><b>Save before Run</b><small>Run the latest editor contents. Turn off to use the saved file.</small></span>
          <input type="checkbox" checked={settings.saveBeforeRun} onChange={(event) => onChange({ saveBeforeRun: event.target.checked })}/>
        </label>
        <label className="setting">
          <span><b>Keep previous run output</b><small>Show the previous run alongside the current run.</small></span>
          <input type="checkbox" checked={settings.keepRunOutput} onChange={(event) => onChange({ keepRunOutput: event.target.checked })}/>
        </label>
        <label className="setting">
          <span><b>Learning Lens</b><small>Connect C diagnostics to offline explanations and track retries in Learn.</small></span>
          <input type="checkbox" checked={settings.learningLens} onChange={(event) => onChange({ learningLens: event.target.checked })}/>
        </label>
      </div>
      <ShortcutSettings overrides={settings.shortcuts} platform={window.ion.platform} onSave={onShortcutChange}/>
      <div className="settings-group">
        <h3>Local Data</h3>
        <div className="setting">
          <div>
            <b>Portable profile</b>
            <p>Copy settings, custom themes, learning history, and project metadata to a folder.</p>
            <p>Keep the copy private. It can contain local paths and test output. Provider credentials and source files stay out of the export.</p>
          </div>
          <button className="button" data-testid="export-local-profile" disabled={exportBusy}
            onClick={() => void exportProfile()}>{exportBusy ? 'Exporting…' : 'Export Local Profile…'}</button>
        </div>
        {exportStatus && <p data-testid="profile-export-status" className={`profile-export-status ${exportStatus.error ? 'form-error' : ''}`}
          role={exportStatus.error ? 'alert' : 'status'}>{exportStatus.message}</p>}
      </div>
      <footer className="modal-footer"><button className="button primary" onClick={onClose} disabled={exportBusy}>Done</button></footer>
    </Modal>
  );
}

export function StarterDialog({ onChoose, onClose }: {
  onChoose(language?: StarterLanguage): void;
  onClose(): void;
}) {
  return <Modal title="New File from Starter" className="starter-picker" onClose={onClose}>
    <p className="starter-help">Choose a language to open a new file with the basic structure already in place.</p>
    <div className="starter-choices">
      {starterLanguages.map((language, index) => <button className="button" type="button" key={language.id}
        autoFocus={index === 0} data-testid={'starter-' + language.id} onClick={() => onChoose(language)}>
        <strong>{language.label}</strong><span>.{language.extension}</span>
      </button>)}
    </div>
    <footer className="modal-footer">
      <button className="button" type="button" data-testid="starter-blank" onClick={() => onChoose()}>Blank File</button>
    </footer>
  </Modal>;
}

export function EntryDialog({ title, initial, hasStarter, onSubmit, onClose }: {
  title: string; initial: string; hasStarter?(name: string): boolean;
  onSubmit(name: string, useStarter: boolean): Promise<void>; onClose(): void;
}) {
  const [name, setName] = useState(initial);
  const [withStarter, setWithStarter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const starterAvailable = hasStarter?.(name.trim()) ?? false;
  useEffect(() => field.current?.select(), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(name.trim(), starterAvailable && withStarter);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form className="entry-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="entry-name">Name</label>
        <input id="entry-name" data-testid="entry-name" ref={field} value={name} onChange={(event) => setName(event.target.value)}
          maxLength={200} required autoFocus disabled={busy}/>
        {starterAvailable && <label className="entry-starter-option">
          <input type="checkbox" data-testid="create-with-starter" checked={withStarter} disabled={busy}
            onChange={(event) => setWithStarter(event.target.checked)}/>
          Include starter code
        </label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer className="modal-footer">
          <button className="button" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button primary" data-testid="entry-submit" type="submit" disabled={busy || !name.trim()}>{busy ? 'Working…' : title}</button>
        </footer>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({ title, message, action, alternative, error, onConfirm, onAlternative, onClose, extra }: {
  title: string; message: string; action: string; alternative?: string; error?: string;
  onConfirm(): Promise<void> | void; onAlternative?(): Promise<void> | void; onClose(): void;
  extra?: { label: string; action(): Promise<void> | void };
}) {
  const [busy, setBusy] = useState(false);
  const activate = async (callback: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await callback();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <p className="confirm-message">{message}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="modal-footer">
        <button className="button" onClick={onClose} autoFocus disabled={busy}>Cancel</button>
        {alternative && onAlternative && <button className="button danger" onClick={() => void activate(onAlternative)}
          disabled={busy}>{alternative}</button>}
        {extra && <button className="button" onClick={() => void activate(extra.action)}
          disabled={busy}>{extra.label}</button>}
        <button className="button primary" onClick={() => void activate(onConfirm)} disabled={busy}>{action}</button>
      </footer>
    </Modal>
  );
}
