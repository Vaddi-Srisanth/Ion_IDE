import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { maxTerminalSessions } from '../../shared/terminal';
import { Icon } from '../icons';
import { TerminalController } from './controller';

export interface TerminalPaneProps {
  controller: RefObject<TerminalController | null>;
  tabs: ReactNode;
  focusRequest: number;
  onHide(): void;
}

export function TerminalPane({ controller, tabs, focusRequest, onHide }: TerminalPaneProps) {
  const [current, setCurrent] = useState(controller.current);
  useLayoutEffect(() => {
    const instance = controller.current ??= new TerminalController(window.ion.terminal, window.ion.platform === 'darwin');
    setCurrent(instance);
    instance.ensureFirst();
  }, [controller]);

  if (!current) return <section className="output integrated-terminal">
    <div className="pane-title">{tabs}</div>
    <div className="bottom-tab-content" role="tabpanel" id="bottom-content-terminal" aria-labelledby="bottom-tab-terminal">
      <p className="terminal-empty" role="status">Starting terminal…</p>
    </div>
  </section>;
  return <Sessions controller={current} tabs={tabs} focusRequest={focusRequest} onHide={onHide}/>;
}

function Sessions({ controller, tabs, focusRequest, onHide }: Omit<TerminalPaneProps, 'controller'> & { controller: TerminalController }) {
  const { sessions, active, opening, error } = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const selected = sessions.find(({ id }) => id === active);
  const host = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const findRequest = useRef(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState<'found' | 'missing' | 'error'>();
  const openFind = useCallback(() => {
    setSearching(true);
    findInput.current?.focus();
    findInput.current?.select();
  }, []);
  const observedFocus = useRef(focusRequest);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !active) return;
    return controller.mount(active, element, openFind);
  }, [active, controller, openFind]);

  useLayoutEffect(() => {
    if (!active && !opening) newButton.current?.focus();
    if (observedFocus.current === focusRequest) return;
    observedFocus.current = focusRequest;
    if (active) controller.focus(active);
  }, [active, controller, focusRequest, opening]);

  useLayoutEffect(() => {
    if (searching) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [active, searching]);

  const search = useCallback(async (previous: boolean, incremental: boolean) => {
    if (!active || !query) return;
    const request = ++findRequest.current;
    try {
      const found = await controller.find(active, query, previous, incremental);
      if (request === findRequest.current) setMatch(found ? 'found' : 'missing');
    } catch {
      if (request === findRequest.current) setMatch('error');
    }
  }, [active, controller, query]);

  useEffect(() => {
    if (!searching || !active) return;
    const timeout = setTimeout(() => void search(false, true), 100);
    return () => {
      clearTimeout(timeout);
      findRequest.current++;
    };
  }, [active, search, searching]);

  function closeFind() {
    findRequest.current++;
    if (active) {
      controller.clearFind(active);
      controller.focus(active);
    }
    setSearching(false);
    setMatch(undefined);
  }

  return <section className="output integrated-terminal" aria-label="Terminal" data-testid="terminal-pane">
    <div className="pane-title">
      {tabs}
      <div className="pane-tools terminal-actions">
        {!!sessions.length && <select className="terminal-sessions" aria-label="Terminal session" title="Switch terminal session"
          value={active ?? ''} data-testid="terminal-session" onChange={(event) => {
            if (active) controller.clearFind(active);
            setMatch(undefined);
            controller.select(event.currentTarget.value);
          }}>
          {sessions.map(({ id, title, number, exit }) => <option key={id} value={id}>{title} {number}{exit ? ' (exited)' : ''}</option>)}
        </select>}
        <button ref={newButton} type="button" className="icon-button terminal-new" aria-label="New Terminal" title="New Terminal"
          data-testid="terminal-new" disabled={opening || sessions.length >= maxTerminalSessions} onClick={() => void controller.create()}>
          <Icon name="plus" size={15}/>
        </button>
        <button type="button" className="icon-button" aria-label="Find in Terminal" title="Find in Terminal"
          data-testid="terminal-search" disabled={!active} onClick={openFind}><Icon name="search" size={14}/></button>
        <button type="button" className="icon-button" aria-label="Clear Terminal" title="Clear Terminal"
          data-testid="terminal-clear" disabled={!active} onClick={() => {
            if (active) {
              controller.clear(active);
              controller.focus(active);
            }
          }}><Icon name="trash" size={14}/></button>
        <button type="button" className="icon-button" aria-label="Close Terminal Session" title="Close Terminal Session and stop its processes"
          data-testid="terminal-close" disabled={!active} onClick={() => { if (active) void controller.close(active); }}>
          <Icon name="x" size={15}/>
        </button>
        <button type="button" className="icon-button" aria-label="Hide Terminal Panel" title="Hide panel (terminal sessions keep running)"
          data-testid="terminal-hide" onClick={onHide}><Icon name="down" size={15}/></button>
      </div>
    </div>
    <div className="bottom-tab-content" role="tabpanel" id="bottom-content-terminal" aria-labelledby="bottom-tab-terminal">
      {searching && active && <div className="terminal-find" role="search" aria-label="Find in Terminal">
        <input ref={findInput} type="search" aria-label="Search terminal output" placeholder="Find in Terminal"
          data-testid="terminal-search-input" value={query} maxLength={256} onChange={(event) => {
            const text = event.currentTarget.value;
            setQuery(text);
            setMatch(undefined);
            if (!text) controller.clearFind(active);
          }} onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeFind();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              void search(event.shiftKey, false);
            }
          }}/>
        <span role="status" data-testid="terminal-search-status">{match === 'found' ? 'Match' : match === 'missing' ? 'No match'
          : match === 'error' ? 'Find unavailable' : ''}</span>
        <button type="button" className="icon-button terminal-find-previous" aria-label="Previous match" title="Previous match" disabled={!query}
          onClick={() => void search(true, false)}><Icon name="chevron" size={13}/></button>
        <button type="button" className="icon-button" aria-label="Next match" title="Next match" disabled={!query}
          onClick={() => void search(false, false)}><Icon name="chevron" size={13}/></button>
        <button type="button" className="icon-button" aria-label="Close terminal search" title="Close terminal search"
          onClick={closeFind}><Icon name="x" size={14}/></button>
      </div>}
      <div ref={host} className="terminal-viewport" hidden={!active}/>
      {!active && <div className="terminal-empty" role="status">
        {opening ? 'Starting your shell…' : error ? 'No terminal session is running.' : 'Open a terminal session to start your shell.'}
      </div>}
      <div className="terminal-footer">
        {error ? <span role="alert" title={error}>{error}</span> : selected?.exit?.detail
          ? <span title={selected.exit.detail}>{selected.exit.detail}</span>
          : <span>Hiding the panel keeps sessions running.</span>}
        {!!selected && <span title={selected.exit ? 'Session exited' : 'Press Ctrl+C to interrupt the running command'}>
          {selected.exit ? 'Exited' : 'Ctrl+C to interrupt'}
        </span>}
      </div>
    </div>
  </section>;
}
