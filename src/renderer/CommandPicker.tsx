import { useEffect, useId, useRef, useState } from 'react';
import type { Entry, QuickOpenResult, RecentEntry } from '../shared/contracts';
import { Modal } from './Dialogs';
import { errorMessage, type Tab } from './documents';

interface Item {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  choose(): void;
}

interface PickerProps {
  title: string;
  testId: string;
  query: string;
  items: Item[];
  empty: string;
  note?: string;
  onQuery(query: string): void;
  onClose(): void;
}

function Picker({ title, testId, query, items, empty, note, onQuery, onClose }: PickerProps) {
  const listId = useId();
  const [index, setIndex] = useState(0);
  const selected = Math.min(index, items.length - 1);
  const option = useRef<HTMLLIElement>(null);
  useEffect(() => { option.current?.scrollIntoView({ block: 'nearest' }); }, [selected, items[selected]?.id]);
  return <Modal title={title} className="command-picker" onClose={onClose}>
    <input role="combobox" type="text" aria-label={title} aria-autocomplete="list" aria-expanded="true"
      aria-controls={listId} aria-activedescendant={selected < 0 ? undefined : listId + '-' + selected}
      className="picker-input" data-testid={testId} value={query} autoFocus spellCheck={false} maxLength={200}
      onChange={(event) => { setIndex(0); onQuery(event.target.value); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || !items.length) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setIndex((selected + step + items.length) % items.length);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          items[selected]?.choose();
        }
      }}/>
    <ul id={listId} className="picker-results" role="listbox" aria-label={title}>
      {items.map((item, position) => <li key={item.id} id={listId + '-' + position} role="option"
        ref={position === selected ? option : undefined} aria-selected={position === selected} title={item.detail}
        onMouseDown={(event) => event.preventDefault()} onClick={item.choose}>
        <div><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</div>
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </li>)}
    </ul>
    {(!items.length || note) && <p className="picker-note" role="status">{note ?? empty}</p>}
  </Modal>;
}

function searchable(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

function matches(query: string, label: string, detail = ''): boolean {
  const text = searchable(label + ' ' + detail);
  return searchable(query.trim()).split(/\s+/).every((word) => text.includes(word));
}

export function Commands({ items, onClose }: { items: Item[]; onClose(): void }) {
  const [query, setQuery] = useState('');
  return <Picker title="Command Palette" testId="command-palette-input" query={query} onQuery={setQuery} onClose={onClose}
    items={items.filter(({ label }) => matches(query, label))} empty="No matching commands."/>;
}

const emptySearch: QuickOpenResult = { entries: [], truncated: false };

export function QuickOpen({ root, tabs, recents, onSelect, onRecent, onOpen, onClose }: {
  root?: string;
  tabs: Tab[];
  recents: RecentEntry[];
  onSelect(tab: Tab): void;
  onRecent(entry: RecentEntry): void;
  onOpen(entry: Entry): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; root: string; files: QuickOpenResult; error?: string }>();
  const requested = Boolean(root && query.trim());
  useEffect(() => {
    if (!root || !query.trim()) return;
    let current = true;
    let started = false;
    const timer = setTimeout(() => {
      started = true;
      void window.ion.quickOpen.search(query).then(
        (files) => { if (current) setResult({ query, root, files }); },
        (reason: unknown) => { if (current) setResult({ query, root, files: emptySearch, error: errorMessage(reason) }); },
      );
    }, 110);
    return () => {
      current = false;
      clearTimeout(timer);
      if (started) void window.ion.quickOpen.search('').catch(() => undefined);
    };
  }, [query, root]);

  const current = result?.query === query && result.root === root ? result : undefined;
  const items: Item[] = [];
  const listed = new Set<string>();
  const append = (item: Item) => {
    if (items.length >= 40 || listed.has(item.id)) return;
    listed.add(item.id);
    items.push(item);
  };
  for (const tab of tabs) {
    if (matches(query, tab.name, tab.path ?? '')) {
      append({ id: tab.path ?? 'tab:' + tab.id, label: tab.name, detail: tab.path ?? 'Open tab', choose: () => onSelect(tab) });
    }
  }
  for (const entry of recents) {
    if (entry.kind === 'file' && matches(query, entry.name, entry.path)) {
      append({ id: entry.path, label: entry.name, detail: entry.path, choose: () => onRecent(entry) });
    }
  }
  for (const entry of current?.files.entries ?? []) {
    append({ id: entry.path, label: entry.name, detail: entry.path, choose: () => onOpen(entry) });
  }
  const note = current?.error ?? (requested && !current ? 'Searching this workspace…'
    : current?.files.truncated ? 'Search results are limited. Use Open File to access other files.' : undefined);
  return <Picker title="Quick Open File" testId="quick-open-input" query={query} onQuery={setQuery} onClose={onClose}
    items={items} note={note} empty={root ? 'Type a filename or workspace path.' : 'Open a folder to search its files.'}/>;
}

export function GoToLine({ lines, onGo, onClose }: { lines: number; onGo(line: number): void; onClose(): void }) {
  const [text, setText] = useState('');
  const line = Number(text);
  const valid = /^[0-9]+$/.test(text) && Number.isInteger(line) && line >= 1 && line <= lines;
  return <Modal title="Go to Line" onClose={onClose}>
    <form className="entry-form" onSubmit={(event) => { event.preventDefault(); if (valid) onGo(line); }}>
      <label htmlFor="goto-line">Line number (1–{lines})</label>
      <input id="goto-line" data-testid="goto-line-input" type="text" inputMode="numeric"
        value={text} onChange={(event) => setText(event.target.value)} autoFocus maxLength={10}/>
      <footer className="modal-footer"><button className="button primary" type="submit" disabled={!valid}>Go</button></footer>
    </form>
  </Modal>;
}
