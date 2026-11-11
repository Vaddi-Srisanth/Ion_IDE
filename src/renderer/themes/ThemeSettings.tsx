import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ThemeData, ThemeDefinition, ThemeSummary } from '../../shared/themes';
import { themeForPreference } from '../appearance';
import { errorMessage } from '../documents';
import { Icon } from '../icons';
import './theme-settings.css';

const ThemeBuilder = lazy(() => import('./ThemeBuilder'));
const quickChoices = [
  { id: 'system', label: 'Automatic' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];
const categories = ['All', 'Dark', 'Light', 'High Contrast', 'Favorites', 'Recent'] as const;
type Category = typeof categories[number];

interface ThemeSettingsProps {
  selection: string;
  activeTheme: ThemeData | null;
  favorites: readonly string[];
  recent: readonly string[];
  startBrowsing?: boolean;
  onSelect(id: string, loaded?: ThemeData): Promise<void>;
  onPreview(theme: ThemeData | null): void;
  onFavorite(id: string): Promise<void>;
}

export function ThemeSettings({ selection, activeTheme, favorites, recent, startBrowsing,
  onSelect, onPreview, onFavorite }: ThemeSettingsProps) {
  const [catalog, setCatalog] = useState<ThemeSummary[] | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(Boolean(startBrowsing));
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('All');
  const [choice, setChoice] = useState<{ id: string; palette?: ThemeData }>();
  const request = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const browse = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!browsing) return;
    let current = true;
    void window.ion.themes.list().then(
      (summaries) => { if (current) setCatalog(summaries); },
      (reason) => { if (current) setCatalogError(errorMessage(reason)); },
    );
    return () => { current = false; };
  }, [catalogAttempt, browsing]);

  useEffect(() => {
    if (!browsing) return;
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [browsing]);

  useEffect(() => () => {
    request.current++;
    onPreview(null);
  }, [onPreview]);

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

  function closePicker() {
    request.current++;
    onPreview(null);
    setChoice(undefined);
    setBrowsing(false);
    setCatalog(null);
    setCatalogError('');
    setError('');
    requestAnimationFrame(() => browse.current?.focus());
  }

  async function preview(id: string) {
    const generation = ++request.current;
    setChoice({ id });
    setError('');
    try {
      const palette = await window.ion.themes.load(themeForPreference(id));
      if (request.current !== generation) return;
      setChoice({ id, palette });
      onPreview(palette);
    } catch (reason) {
      if (request.current !== generation) return;
      onPreview(null);
      setError(errorMessage(reason));
    }
  }

  async function selectInstalled(theme: ThemeSummary) {
    await onSelect(theme.id);
  }

  const automatic: ThemeSummary = {
    id: 'system', name: 'Automatic', appearance: activeTheme?.appearance ?? 'dark', source: 'builtin',
  };
  const items = catalog ? [automatic, ...catalog] : [];
  const search = query.trim().toLowerCase();
  const byPreference = category === 'Recent' ? recent : category === 'Favorites' ? favorites : undefined;
  const visible = items.filter((theme) => {
    if (search && !theme.name.toLowerCase().includes(search)) return false;
    if (category === 'High Contrast') return theme.contrast === 'high';
    if (category === 'Dark' || category === 'Light') return theme.id !== 'system' && theme.contrast !== 'high'
      && theme.appearance === category.toLowerCase();
    return !byPreference || byPreference.includes(theme.id);
  });
  if (byPreference) visible.sort((a, b) => byPreference.indexOf(a.id) - byPreference.indexOf(b.id));

  function pickerKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) closePicker();
      return;
    }
    if (busy || !visible.length || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    const current = visible.findIndex(({ id }) => id === (choice?.id ?? selection));
    const next = current < 0 ? 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
    const { id } = visible[next];
    list.current?.querySelector<HTMLButtonElement>(`[data-theme-choice="${id}"]`)?.focus();
    void preview(id);
  }

  return <>
    <div className="setting theme-quick">
      <div><b>Theme</b><p>{selection === 'system' ? 'Follows system appearance.' : activeTheme?.name ?? 'Set the window and editor appearance.'}</p></div>
      <div className="segmented" role="group" aria-label="Common themes">
        {quickChoices.map(({ id, label }) => <button key={id} type="button"
          aria-pressed={selection === id} data-testid={`theme-${id}`} disabled={creating || browsing || busy}
          onClick={() => void run(() => onSelect(id))}>{label}</button>)}
      </div>
    </div>
    {!browsing && <div className="setting">
      <div><b>Theme collection</b><p>Browse built-in and locally installed themes.</p></div>
      <button ref={browse} className="button" type="button" data-testid="theme-browse" disabled={creating || busy}
        onClick={() => { setQuery(''); setCategory('All'); setBrowsing(true); }}>Browse Themes…</button>
    </div>}
    {browsing && <section className="theme-collection" aria-label="Theme collection" onKeyDown={pickerKeys}>
      <div className="theme-search">
        <Icon name="search" size={15}/>
        <input ref={field} aria-label="Search themes" placeholder="Search themes…" data-testid="theme-search"
          value={query} onChange={(event) => setQuery(event.target.value)} maxLength={64} spellCheck={false}/>
      </div>
      <div className="theme-filters" role="group" aria-label="Theme categories">
        {categories.map((filter) => <button type="button" key={filter} className="button"
          aria-pressed={category === filter} onClick={() => setCategory(filter)}>{filter}</button>)}
      </div>
      <div className="theme-results" aria-label="Themes" ref={list} data-testid="theme-results">
        {visible.map((theme) => <div className="theme-row" key={theme.id}>
          <button type="button" className="theme-choice" disabled={busy}
            data-theme-choice={theme.id} aria-pressed={(choice?.id ?? selection) === theme.id}
            onClick={() => void preview(theme.id)}>
            <span className="theme-palette" aria-hidden="true">
              {(theme.swatches ?? (theme.appearance === 'light' ? ['#f3f4f8', '#315c78', '#64437b']
                : ['#161a24', '#74d7ce', '#b9a2e3'])).map((color, index) =>
                <i key={index} style={{ backgroundColor: color }}/>)}
            </span>
            <span>{theme.name}</span>
            {theme.id === selection && <Icon name="check" size={14}/>}
          </button>
          <button type="button" className="icon-button theme-favorite" aria-label={`Favorite ${theme.name}`}
            aria-pressed={favorites.includes(theme.id)} disabled={busy || favorites.length >= 100 && !favorites.includes(theme.id)}
            onClick={() => void run(() => onFavorite(theme.id))}><span aria-hidden="true">{favorites.includes(theme.id) ? '★' : '☆'}</span></button>
        </div>)}
        {!visible.length && <p role="status">{catalogError ? 'Theme collection unavailable.' : catalog ? 'No matching themes.' : 'Loading themes…'}</p>}
      </div>
      <div className="theme-collection-actions">
        <span role="status">{choice?.palette ? `Previewing ${choice.id === 'system' ? 'Automatic' : choice.palette.name}` : 'Select a theme to preview.'}</span>
        <button className="button" type="button" data-testid="theme-preview-cancel" disabled={busy} onClick={closePicker}>Cancel</button>
        <button className="button primary" type="button" data-testid="theme-preview-apply" disabled={busy || !choice?.palette}
          onClick={() => void run(async () => {
            if (!choice?.palette) return;
            await onSelect(choice.id, choice.palette);
            closePicker();
          })}>Apply</button>
      </div>
    </section>}
    {!browsing && <div className="theme-tools">
      <button className="button" type="button" data-testid="theme-import" disabled={busy || creating}
        onClick={() => void run(async () => {
          const installed = await window.ion.themes.import();
          if (installed) await selectInstalled(installed);
        })}>Import…</button>
      <button className="button" type="button" data-testid="theme-export" disabled={!activeTheme || busy || creating}
        onClick={() => void run(async () => {
          if (activeTheme && await window.ion.themes.export(activeTheme.id)) setNotice('Theme exported.');
        })}>Export Current…</button>
      <button className="button" type="button" data-testid="theme-create" disabled={!activeTheme || busy || creating}
        onClick={() => { setError(''); setNotice(''); setCreating(true); }}>Create Theme…</button>
    </div>}
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
