import { lazy, memo, Suspense, useEffect, useState } from 'react';
import type { ThemeData, ThemeDefinition, ThemeSummary } from '../../shared/themes';
import './theme-settings.css';

const ThemeBuilder = lazy(() => import('./ThemeBuilder'));
const quickChoices = [
  { id: 'system', label: 'Automatic' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];
const groups = [
  { source: 'builtin', appearance: 'dark', label: 'Built-in dark' },
  { source: 'builtin', appearance: 'light', label: 'Built-in light' },
  { source: 'custom', appearance: 'dark', label: 'Custom dark' },
  { source: 'custom', appearance: 'light', label: 'Custom light' },
] as const;
const isQuickChoice = (id: string) => quickChoices.some((choice) => choice.id === id);

function errorMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

const ThemeOptions = memo(function ThemeOptions({ catalog }: { catalog: ThemeSummary[] }) {
  const extras = catalog.filter(({ id }) => !isQuickChoice(id));
  return groups.map(({ source, appearance, label }) => {
    const options = extras.filter((theme) => theme.source === source && theme.appearance === appearance);
    return options.length ? <optgroup key={label} label={label}>
      {options.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
    </optgroup> : null;
  });
});

export function ThemeSettings({ selection, activeTheme, onSelect }: {
  selection: string;
  activeTheme: ThemeData | null;
  onSelect(id: string): Promise<void>;
}) {
  const [catalog, setCatalog] = useState<ThemeSummary[] | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let current = true;
    void window.ion.themes.list().then(
      (summaries) => { if (current) setCatalog(summaries); },
      (reason) => { if (current) setCatalogError(errorMessage(reason)); },
    );
    return () => { current = false; };
  }, [catalogAttempt]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function selectInstalled(theme: ThemeSummary) {
    setCatalog((previous) => [...(previous ?? []), theme]);
    await onSelect(theme.id);
  }

  const pickerValue = !isQuickChoice(selection) && catalog?.some(({ id }) => id === selection) ? selection : '';

  return <>
    <div className="setting theme-quick">
      <div>
        <b>Theme</b>
        <p>{selection === 'system' ? 'Follows system appearance.' : 'Set the window and editor appearance.'}</p>
      </div>
      <div className="segmented" role="group" aria-label="Common themes">
        {quickChoices.map(({ id, label }) => <button key={id} type="button"
          aria-pressed={selection === id} data-testid={`theme-${id}`} disabled={creating} aria-disabled={busy || undefined}
          onClick={() => void run(() => onSelect(id))}>{label}</button>)}
      </div>
    </div>
    <div className="setting">
      <div><label htmlFor="theme-picker"><b>More themes</b></label><p>Presets and your locally installed themes.</p></div>
      <select id="theme-picker" data-testid="theme-picker" value={pickerValue} disabled={!catalog || creating} aria-disabled={busy || undefined}
        onChange={(event) => {
          const id = event.target.value;
          if (id) void run(() => onSelect(id));
        }}>
        <option value="" disabled>{catalog ? 'Choose a theme…' : catalogError ? 'Catalog unavailable' : 'Loading themes…'}</option>
        {catalog && <ThemeOptions catalog={catalog}/>}
      </select>
    </div>
    <div className="theme-tools">
      <button className="button" type="button" data-testid="theme-import" disabled={!catalog || busy || creating}
        onClick={() => void run(async () => {
          const installed = await window.ion.themes.import();
          if (installed) await selectInstalled(installed);
        })}>Import…</button>
      <button className="button" type="button" data-testid="theme-export" disabled={!activeTheme || busy || creating}
        onClick={() => void run(async () => {
          if (activeTheme && await window.ion.themes.export(activeTheme.id)) setNotice('Theme exported.');
        })}>Export Current…</button>
      <button className="button" type="button" data-testid="theme-create" disabled={!catalog || !activeTheme || busy || creating}
        onClick={() => { setError(''); setNotice(''); setCreating(true); }}>Create Theme…</button>
    </div>
    {catalogError && <div className="theme-catalog-error">
      <p className="form-error" role="alert">{catalogError}</p>
      <button className="button" type="button" onClick={() => {
        setCatalogError('');
        setCatalogAttempt((attempt) => attempt + 1);
      }}>Retry</button>
    </div>}
    {creating && activeTheme && <Suspense fallback={<p className="theme-feedback" role="status">Opening theme editor…</p>}>
      <ThemeBuilder base={activeTheme} busy={busy}
        onCancel={() => { setCreating(false); setError(''); }}
        onSave={(draft: ThemeDefinition) => void run(async () => {
          const installed = await window.ion.themes.create(draft);
          setCreating(false);
          await selectInstalled(installed);
        })}/>
    </Suspense>}
    {error && <p className="form-error theme-feedback" role="alert">{error}</p>}
    {notice && <p className="theme-feedback" role="status">{notice}</p>}
  </>;
}
