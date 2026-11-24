import { useEffect, useState } from 'react';
import { workspaceReplaceTextLimit, workspaceSearchQueryLimit, workspaceSearchResultLimit, type WorkspaceReplacePreview, type WorkspaceSearchMatch, type WorkspaceSearchResult } from '../shared/workspace-search';
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

export default function WorkspaceSearch({ root, dirtyPaths, onOpen, onApplied, onClose }: {
  root: string; dirtyPaths: string[];
  onOpen(path: string, match: WorkspaceSearchMatch): void;
  onApplied(paths: string[]): void; onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [replaceMode, setReplaceMode] = useState(false);
  const [review, setReview] = useState<WorkspaceReplacePreview>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replacing, setReplacing] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [response, setResponse] = useState<{ result: WorkspaceSearchResult } | { error: string }>();
  const searching = Boolean(query && !cancelled && !response && !replacing);

  useEffect(() => {
    if (!query || cancelled || replacing || review) return;
    let current = true; let id: string | undefined;
    const timer = setTimeout(() => {
      id = crypto.randomUUID();
      void window.ion.workspaceSearch.search(id, query).then(
        result => { if (current) setResponse({ result }); },
        (error: unknown) => { if (current) setResponse({ error: errorMessage(error) }); },
      );
    }, debounceMs);
    return () => { current = false; clearTimeout(timer); if (id) void window.ion.workspaceSearch.cancel(id).catch(() => undefined); };
  }, [query, cancelled, replacing, review]);

  const invalidateReview = () => { setReview(undefined); setSelected(new Set()); };
  const reviewReplace = async () => {
    setReplacing(true); setResponse(undefined);
    try { const next = await window.ion.workspaceSearch.review(query, replacement); setReview(next); setSelected(new Set(next.files.map(file => file.path))); }
    catch (reason) { setResponse({ error: errorMessage(reason) }); } finally { setReplacing(false); }
  };
  const applyReplace = async () => {
    if (!review || !selected.size) return;
    setReplacing(true); setResponse(undefined);
    try {
      const outcome = await window.ion.workspaceSearch.apply(review.token, [...selected]);
      onApplied(outcome.applied); invalidateReview();
      if (outcome.failed.length) setResponse({ error: `${outcome.applied.length} files updated; ${outcome.failed.length} failed. Review current files before retrying.` });
      else setResponse({ result: { files: [] } });
    } catch (reason) { setResponse({ error: errorMessage(reason) }); invalidateReview(); } finally { setReplacing(false); }
  };
  const result = !cancelled && response && 'result' in response ? response.result : undefined;
  const error = !cancelled && response && 'error' in response ? response.error : undefined;
  const first = result?.files[0];
  const note = result ? resultNote(result) : searching ? 'Searching…' : cancelled ? 'Search cancelled.' : 'Searches text in saved workspace files.';

  return <Modal title="Search in Files" className="workspace-search" onClose={onClose}>
    <p className="workspace-search-root" title={root}>{root}</p>
    <form className="workspace-search-form" onSubmit={event => { event.preventDefault(); if (cancelled) setCancelled(false); else if (first) onOpen(first.path, first.matches[0]); }}>
      <input className="picker-input" type="text" data-testid="workspace-search-input" aria-label="Search text" placeholder="Find text across saved files"
        autoFocus spellCheck={false} maxLength={workspaceSearchQueryLimit} value={query}
        onChange={event => { setResponse(undefined); setCancelled(false); setQuery(event.target.value); invalidateReview(); }}/>
      {searching && <button className="button" type="button" onClick={() => { setResponse(undefined); setCancelled(true); }}>Cancel search</button>}
      {cancelled && <button className="button" type="submit">Search again</button>}
    </form>
    <div className="workspace-replace-toggle"><button className="button" type="button" aria-expanded={replaceMode}
      onClick={() => { setReplaceMode(value => !value); invalidateReview(); }}>{replaceMode ? 'Hide replace' : 'Replace in files…'}</button></div>
    {replaceMode && <section className="workspace-replace" aria-label="Replace in files">
      <input className="picker-input" type="text" aria-label="Replacement text" placeholder="Replace with" maxLength={workspaceReplaceTextLimit}
        value={replacement} onChange={event => { setReplacement(event.target.value); invalidateReview(); }}/>
      {dirtyPaths.length ? <p className="form-error" role="alert">Save or close {dirtyPaths.length} modified workspace {dirtyPaths.length === 1 ? 'file' : 'files'} before reviewing replacement.</p> : null}
      {!review ? <button className="button primary" type="button" disabled={!query || replacing || Boolean(dirtyPaths.length)} onClick={() => void reviewReplace()}>
        {replacing ? 'Reviewing…' : 'Review replacements'}</button> : <>
        <p className="picker-note" role="status">Review {review.replacements} replacements in {review.files.length} files. Files changed after review will be rejected.</p>
        <ul className="workspace-replace-files" aria-label="Files selected for replacement">{review.files.map(file => <li key={file.path}><label>
          <input type="checkbox" checked={selected.has(file.path)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(file.path); else next.delete(file.path); return next; })}/>
          <span title={file.relativePath}>{file.relativePath}</span><small>{file.replacements}</small>
        </label></li>)}</ul>
        <div className="dialog-actions"><button className="button" type="button" onClick={invalidateReview}>Review again</button>
          <button className="button primary" type="button" disabled={!selected.size || replacing} onClick={() => void applyReplace()}>{replacing ? 'Applying…' : `Replace in ${selected.size} files`}</button></div>
      </>}
    </section>}
    {error ? <p className="form-error" role="alert">{error}</p> : <p className="picker-note" role="status">{note}</p>}
    {result?.files.length ? <ul className="workspace-search-results" aria-label="Search results">{result.files.map(file => <li key={file.path} data-testid="workspace-search-file" data-path={file.path}>
      <h3 title={file.relativePath}>{file.relativePath}</h3><ul>{file.matches.map(match => <li key={match.line}><button type="button" className="workspace-search-hit"
        onClick={() => onOpen(file.path, match)} aria-label={`${file.relativePath}, line ${match.line}, ${match.preview}`}>
        <span className="workspace-search-line">{match.line}</span><span className="workspace-search-preview">{match.preview}</span></button></li>)}</ul>
    </li>)}</ul> : null}
  </Modal>;
}
