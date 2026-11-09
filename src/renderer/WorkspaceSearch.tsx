import { useEffect, useState } from 'react';
import { workspaceSearchQueryLimit, workspaceSearchResultLimit, type WorkspaceSearchMatch, type WorkspaceSearchResult } from '../shared/workspace-search';
import { Modal } from './Dialogs';
import { errorMessage } from './documents';
import './workspace-search.css';

const debounceMs = 160;

function resultNote(result: WorkspaceSearchResult): string {
  const count = result.files.reduce((sum, file) => sum + file.matches.length, 0);
  if (result.limit === 'matches') return `Showing the first ${workspaceSearchResultLimit} matching lines. Refine the search for more.`;
  if (result.limit) return `Search reached its ${result.limit} limit. Showing ${count} matching lines so far.`;
  if (result.skipped) return `${count} matching lines. Some files could not be searched.`;
  if (!count) return 'No matching text in saved workspace files.';
  return `${count} matching ${count === 1 ? 'line' : 'lines'} in ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}.`;
}

export default function WorkspaceSearch({ root, onOpen, onClose }: {
  root: string;
  onOpen(path: string, match: WorkspaceSearchMatch): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [response, setResponse] = useState<{ result: WorkspaceSearchResult } | { error: string }>();
  const searching = Boolean(query && !cancelled && !response);

  useEffect(() => {
    if (!query || cancelled) return;
    let current = true;
    let id: string | undefined;
    const timer = setTimeout(() => {
      id = crypto.randomUUID();
      void window.ion.workspaceSearch.search(id, query).then(
        (result) => { if (current) setResponse({ result }); },
        (error: unknown) => { if (current) setResponse({ error: errorMessage(error) }); },
      );
    }, debounceMs);
    return () => {
      current = false;
      clearTimeout(timer);
      if (id) void window.ion.workspaceSearch.cancel(id).catch(() => undefined);
    };
  }, [query, cancelled]);

  const result = !cancelled && response && 'result' in response ? response.result : undefined;
  const error = !cancelled && response && 'error' in response ? response.error : undefined;
  const first = result?.files[0];
  const note = result ? resultNote(result) : searching ? 'Searching…'
    : cancelled ? 'Search cancelled.' : 'Searches text in saved workspace files.';

  return <Modal title="Search in Files" className="workspace-search" onClose={onClose}>
    <p className="workspace-search-root" title={root}>{root}</p>
    <form className="workspace-search-form" onSubmit={(event) => {
      event.preventDefault();
      if (cancelled) setCancelled(false);
      else if (first) onOpen(first.path, first.matches[0]);
    }}>
      <input className="picker-input" type="text" data-testid="workspace-search-input" aria-label="Search text"
        placeholder="Find text across saved files" autoFocus spellCheck={false} maxLength={workspaceSearchQueryLimit}
        value={query} onChange={(event) => {
          setResponse(undefined);
          setCancelled(false);
          setQuery(event.target.value);
        }}/>
      {searching && <button className="button" type="button" onClick={() => {
        setResponse(undefined);
        setCancelled(true);
      }}>Cancel search</button>}
      {cancelled && <button className="button" type="submit">Search again</button>}
    </form>
    {error ? <p className="form-error" role="alert">{error}</p> : <p className="picker-note" role="status">{note}</p>}
    {result?.files.length ? <ul className="workspace-search-results" aria-label="Search results">
      {result.files.map((file) => <li key={file.path} data-testid="workspace-search-file" data-path={file.path}>
        <h3 title={file.relativePath}>{file.relativePath}</h3>
        <ul>{file.matches.map((match) => <li key={match.line}>
          <button type="button" className="workspace-search-hit" onClick={() => onOpen(file.path, match)}
            aria-label={`${file.relativePath}, line ${match.line}, ${match.preview}`}>
            <span className="workspace-search-line">{match.line}</span><span className="workspace-search-preview">{match.preview}</span>
          </button>
        </li>)}</ul>
      </li>)}
    </ul> : null}
  </Modal>;
}
