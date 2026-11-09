import { useEffect, useRef, useState } from 'react';
import type { TextPage } from '../shared/large-text';
import { errorMessage } from './documents';

export function LargeTextPreview({ path }: { path: string }) {
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<{ page: number; data: TextPage } | null>(null);
  const [error, setError] = useState<string>();
  const revision = useRef<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void window.ion.readTextPage(path, page, revision.current).then((data) => {
      if (!current) return;
      revision.current = data.revision;
      setPreview({ page, data });
    }, (reason: unknown) => {
      if (current) setError(errorMessage(reason));
    });
    return () => { current = false; };
  }, [attempt, page, path]);

  const ready = preview?.page === page && !error;
  const pages = preview?.data.pages ?? 0;
  return <section className="document-pane large-text-preview" data-testid="large-text-preview" aria-label="Read-only text preview">
    <div className="document-toolbar">
      <span>Read only · Files over 2 MiB open in pages</span>
      {pages > 0 && <form className="document-actions" onSubmit={(event) => {
        event.preventDefault();
        const number = Number(new FormData(event.currentTarget).get('page'));
        if (Number.isInteger(number) && number >= 1 && number <= pages) setPage(number - 1);
      }}>
        <button type="button" className="button" disabled={!ready || page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <label>Page <input key={page} name="page" type="number" min="1" max={pages} defaultValue={page + 1} disabled={!ready}/></label>
        <span>of {pages}</span>
        <button type="submit" className="button" disabled={!ready}>Go</button>
        <button type="button" className="button" disabled={!ready || page + 1 === pages} onClick={() => setPage(page + 1)}>Next</button>
      </form>}
    </div>
    {ready ? <pre className="large-text-page" key={page} tabIndex={0}>{preview.data.text}</pre>
      : <div className="editor-loading" role={error ? 'alert' : 'status'}>
        {error ? <><p>{error}</p><button type="button" className="button" onClick={() => {
          revision.current = undefined;
          setPreview(null);
          setError(undefined);
          setPage(0);
          setAttempt((value) => value + 1);
        }}>Restart Preview</button></> : 'Opening text page…'}
      </div>}
  </section>;
}
