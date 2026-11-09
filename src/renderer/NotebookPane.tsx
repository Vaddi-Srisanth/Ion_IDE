import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { errorMessage, type Documents, type Tab } from './documents';
import type { NotebookEditorProps } from './notebooks/NotebookEditor';

interface LoadedNotebook {
  source: string;
  Editor: ComponentType<NotebookEditorProps>;
}

type Props = Pick<NotebookEditorProps, 'settings' | 'activeTheme' | 'accentColor' | 'onKernelPolicyChange'> & { tab: Tab; documents: Documents };

const rawPageSize = 64 * 1024;
const monacoFileLimit = 2 * 1024 * 1024;

function LargeRawNotebook({ source, onBack }: { source: string; onBack(): void }) {
  const [page, setPage] = useState(0);
  const count = Math.ceil(source.length / rawPageSize);
  return <section className="document-pane" aria-label="Large notebook JSON" data-testid="notebook-raw-large">
    <div className="document-toolbar">
      <span>Raw JSON · Read only · {page + 1} of {count}</span>
      <div className="document-actions">
        <button className="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous page</button>
        <button className="button" disabled={page + 1 === count} onClick={() => setPage(page + 1)}>Next page</button>
        <button className="button" onClick={onBack}>Open Notebook</button>
      </div>
    </div>
    <pre key={page} tabIndex={0} style={{ flex: 1, minHeight: 0, margin: 0, overflow: 'auto', padding: '12px 16px' }}>
      {source.slice(page * rawPageSize, (page + 1) * rawPageSize)}
    </pre>
  </section>;
}

export function NotebookPane({ tab, documents, settings, activeTheme, accentColor, onKernelPolicyChange }: Props) {
  const { id, name } = tab;
  const [loaded, setLoaded] = useState<LoadedNotebook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [largeRaw, setLargeRaw] = useState(false);
  const openJson = async () => {
    if (tab.notebookRunning) return;
    if (loaded) {
      const source = await documents.loadText(id).catch(() => loaded.source);
      if (source.length > monacoFileLimit ||
        (source.length > monacoFileLimit / 3 && new Blob([source]).size > monacoFileLimit)) {
        setLoaded({ ...loaded, source });
        setLargeRaw(true);
        return;
      }
    }
    documents.setNotebookMode(id, 'json');
  };
  const connect = useCallback((getText: () => string) => documents.connectNotebook(id, getText), [documents, id]);
  const change = useCallback(() => documents.changed(id), [documents, id]);
  const setRunning = useCallback((running: boolean) => documents.setNotebookRunning(id, running), [documents, id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([documents.loadText(id), import('./notebooks/NotebookEditor')]).then(([source, module]) => {
      if (cancelled) return;
      setLoaded({ source, Editor: module.default });
    }, (reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason));
    });
    return () => { cancelled = true; };
  }, [documents, id]);

  if (loaded && largeRaw) return <LargeRawNotebook source={loaded.source} onBack={() => setLargeRaw(false)}/>;
  if (loaded) return <loaded.Editor source={loaded.source} name={name} onOpenJson={() => void openJson()} onConnect={connect} onChange={change}
    settings={settings} activeTheme={activeTheme} accentColor={accentColor} path={tab.path}
    onRunningChange={setRunning} onKernelPolicyChange={onKernelPolicyChange}/>;
  return <div className="editor-loading" role={error ? 'alert' : 'status'}>
    {error ? <><p>Could not open {name}. {error}</p><button className="button" onClick={() => void openJson()}>Open as JSON</button></>
      : 'Opening notebook…'}
  </div>;
}
