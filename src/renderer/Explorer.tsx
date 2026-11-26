import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent } from 'react';
import type { Entry, EntryKind } from '../shared/contracts';
import type { SourceControlEntry } from '../shared/source-control';
import { errorMessage, type Tab } from './documents';
import { Icon } from './icons';
import { adjacentExplorerPath, firstExplorerChild, visibleExplorerItems } from './explorer-tree';
import { isWithin, sourceControlPathKey } from './paths';

interface ExplorerProps {
  hidden?: boolean;
  root: Entry | null;
  roots?: Entry[];
  activePath: string | null;
  target: string | null;
  tabs: Tab[];
  revision: number;
  sourceControlEntries?: readonly SourceControlEntry[];
  onOpen(entry: Entry): void;
  onTarget(path: string): void;
  onCreate(kind: EntryKind): void;
  onRename(entry: Entry): void;
  onTrash(entry: Entry): void;
  onContextMenu(entry: Entry, root: boolean, position: { x: number; y: number }): void;
  onRefresh(): void;
  onOpenFolder(): void;
  onAddFolder(): void;
  onRemoveFolder(path: string): void;
  onReorderFolder(path: string, offset: -1 | 1): void;
  onSaveWorkspace(): void;
  onOpenWorkspace(): void;
}

interface FolderProps {
  path: string;
  depth: number;
  activePath: string | null;
  target: string | null;
  revision: number;
  sourceControl?: ReadonlyMap<string, SourceControlEntry>;
  expanded: ReadonlySet<string>;
  focusedPath: string | null;
  onOpen(entry: Entry): void;
  onTarget(path: string): void;
  onToggle(entry: Entry): void;
  onFocusPath(path: string): void;
  onRegisterTreeItem(path: string, node: HTMLButtonElement | null): void;
  onDirectoryEntries(path: string, entries: readonly Entry[]): void;
  onRename(entry: Entry): void;
  onTrash(entry: Entry): void;
  onContextMenu(entry: Entry, root: boolean, position: { x: number; y: number }): void;
}

const Folder = memo(function Folder(props: FolderProps) {
  const { path, depth, activePath, target, revision, sourceControl, expanded, focusedPath, onOpen, onTarget, onToggle,
    onFocusPath, onRegisterTreeItem, onDirectoryEntries, onRename, onTrash, onContextMenu } = props;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.ion.listDirectory(path).then((items) => {
      if (!cancelled) {
        setEntries(items);
        setError(null);
        onDirectoryEntries(path, items);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setEntries(null);
        setError(errorMessage(reason));
        onDirectoryEntries(path, []);
      }
    });
    return () => { cancelled = true; };
  }, [onDirectoryEntries, path, revision]);

  if (error) return <p className="tree-message" role="status">{error}</p>;
  if (!entries) return <p className="tree-message" role="status">Reading folder…</p>;
  if (!entries.length) return depth === 0 ? <p className="tree-message">This folder is empty.</p> : null;
  return (
    <ul className="tree" role="group" aria-label={depth === 0 ? 'Folder contents' : undefined}>
      {entries.map((entry) => {
        const isFolder = entry.kind === 'folder';
        const isExpanded = expanded.has(entry.path);
        const selected = target === entry.path || (!isFolder && activePath === entry.path);
        const change = sourceControl?.get(sourceControlPathKey(entry.path));
        const status = change?.unmerged ? '!' : change?.worktree === '?' ? 'U' : change?.worktree || change?.index;
        return (
          <li key={entry.path} role="none">
            <div className={`tree-row ${selected ? 'selected' : ''}`} style={{ paddingInlineStart: 7 + depth * 13 }}
              data-testid="explorer-row" data-path={entry.path} onContextMenu={(event: ReactMouseEvent) => {
                event.preventDefault();
                onFocusPath(entry.path);
                onTarget(entry.path);
                const bounds = event.currentTarget.getBoundingClientRect();
                onContextMenu(entry, false, { x: event.clientX || bounds.left + 18, y: event.clientY || bounds.top + bounds.height });
              }}>
              <button className="tree-label" data-testid="explorer-entry" data-path={entry.path}
                role="treeitem" aria-level={depth + 2} aria-selected={selected}
                aria-expanded={isFolder ? isExpanded : undefined} aria-current={!isFolder && selected ? 'true' : undefined}
                tabIndex={focusedPath === entry.path ? 0 : -1}
                ref={(node) => { onRegisterTreeItem(entry.path, node); }}
                title={entry.path}
                onFocus={() => onFocusPath(entry.path)}
                onClick={() => {
                  onFocusPath(entry.path);
                  if (isFolder) onToggle(entry);
                  else { onTarget(path); onOpen(entry); }
                }}>
                <span className="tree-chevron">{isFolder && <Icon name={isExpanded ? 'down' : 'chevron'} size={12}/>}</span>
                <Icon name={isFolder ? (isExpanded ? 'open' : 'folder') : 'file'} size={15}
                  className={isFolder ? 'tree-folder-icon' : /\.c$/i.test(entry.name) ? 'tree-c-icon' : undefined}/>
                <span>{entry.name}</span>
              </button>
              {status && <span className="tree-git-status" data-git-status={status} title={change?.unmerged ? 'Unmerged Git changes'
                : change?.worktree === '?' ? 'Untracked by Git' : [change?.index && `Staged ${change.index}`,
                  change?.worktree && `Working tree ${change.worktree}`].filter(Boolean).join(' · ')}>{status}</span>}
              <div className="tree-tools">
                <button className="icon-button" aria-label={`Rename ${entry.name}`} title="Rename" data-testid="rename-entry"
                  onClick={() => onRename(entry)}><Icon name="edit" size={13}/></button>
                <button className="icon-button danger-icon" aria-label={`Move ${entry.name} to Trash`} title="Move to Trash"
                  data-testid="trash-entry" onClick={() => onTrash(entry)}><Icon name="trash" size={13}/></button>
              </div>
            </div>
            {isFolder && isExpanded && <Folder {...props} path={entry.path} depth={depth + 1}/>}
          </li>
        );
      })}
    </ul>
  );
});

export function Explorer({ hidden, root, roots = root ? [root] : [], activePath, target, tabs, revision, sourceControlEntries,
  onOpen, onTarget, onCreate, onRename, onTrash, onContextMenu, onRefresh, onOpenFolder, onAddFolder, onRemoveFolder, onReorderFolder,
  onSaveWorkspace, onOpenWorkspace }: ExplorerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [directoryEntries, setDirectoryEntries] = useState<ReadonlyMap<string, readonly Entry[]>>(() => new Map());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const treeItems = useRef(new Map<string, HTMLButtonElement>());
  const sourceControl = useMemo(() => sourceControlEntries?.length
    ? new Map(sourceControlEntries.map((entry) => [sourceControlPathKey(entry.absolutePath), entry])) : undefined, [sourceControlEntries]);
  const duplicateRootNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of roots) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    return counts;
  }, [roots]);
  const rootIdentity = roots.map(({ path }) => path).join('\0');
  useEffect(() => {
    const belongsToWorkspace = (path: string) => roots.some((workspaceRoot) => isWithin(path, workspaceRoot.path));
    setExpanded((current) => {
      const next = new Set([...current].filter(belongsToWorkspace));
      return next.size === current.size ? current : next;
    });
    setDirectoryEntries((current) => {
      const next = new Map([...current].filter(([path]) => belongsToWorkspace(path)));
      return next.size === current.size ? current : next;
    });
    for (const path of treeItems.current.keys()) {
      if (!belongsToWorkspace(path)) treeItems.current.delete(path);
    }
  // Root identity is the cleanup boundary; entry object identity is not relevant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootIdentity]);

  const reportDirectoryEntries = useCallback((path: string, entries: readonly Entry[]) => {
    setDirectoryEntries((current) => {
      if (current.get(path) === entries) return current;
      const next = new Map(current);
      next.set(path, entries);
      return next;
    });
  }, []);
  const visibleItems = useMemo(() => visibleExplorerItems(roots, directoryEntries, expanded),
    [directoryEntries, expanded, roots]);
  useEffect(() => {
    setFocusedPath((current) => {
      if (current && visibleItems.some(({ entry }) => entry.path === current)) return current;
      return [target, activePath].find((path) => path && visibleItems.some(({ entry }) => entry.path === path))
        ?? visibleItems[0]?.entry.path ?? null;
    });
  }, [activePath, target, visibleItems]);

  const registerTreeItem = useCallback((path: string, node: HTMLButtonElement | null) => {
    if (node) treeItems.current.set(path, node);
    else treeItems.current.delete(path);
  }, []);
  const moveFocus = useCallback((path: string | undefined) => {
    if (!path) return;
    setFocusedPath(path);
    queueMicrotask(() => treeItems.current.get(path)?.focus());
  }, []);
  const toggleFolder = useCallback((entry: Entry) => {
    onTarget(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  }, [onTarget]);
  const handleTreeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"]');
    if (!element || element.closest('[role="tree"]') !== event.currentTarget) return;
    const path = element.dataset.path;
    const item = path ? visibleItems.find(({ entry }) => entry.path === path) : undefined;
    if (!item) return;

    const activate = () => {
      if (item.root) onTarget(item.entry.path);
      else if (item.entry.kind === 'folder') toggleFolder(item.entry);
      else {
        if (item.parentPath) onTarget(item.parentPath);
        onOpen(item.entry);
      }
    };
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        moveFocus(adjacentExplorerPath(visibleItems, item.entry.path, 1));
        break;
      case 'ArrowUp':
        moveFocus(adjacentExplorerPath(visibleItems, item.entry.path, -1));
        break;
      case 'Home':
        moveFocus(visibleItems[0]?.entry.path);
        break;
      case 'End':
        moveFocus(visibleItems.at(-1)?.entry.path);
        break;
      case 'ArrowRight':
        if (item.entry.kind !== 'folder') break;
        if (!item.root && !expanded.has(item.entry.path)) toggleFolder(item.entry);
        else moveFocus(firstExplorerChild(visibleItems, item.entry.path));
        break;
      case 'ArrowLeft':
        if (!item.root && item.entry.kind === 'folder' && expanded.has(item.entry.path)) toggleFolder(item.entry);
        else moveFocus(item.parentPath ?? undefined);
        break;
      case 'Enter':
      case ' ':
        activate();
        break;
      case 'F2':
        if (item.root) handled = false;
        else onRename(item.entry);
        break;
      case 'Escape':
        moveFocus(item.entry.path);
        break;
      default: {
        const macTrash = window.ion.platform === 'darwin' && event.metaKey && !event.altKey && !event.ctrlKey
          && event.key === 'Backspace';
        const windowsTrash = window.ion.platform === 'win32' && !event.metaKey && !event.altKey && !event.ctrlKey
          && event.key === 'Delete';
        if (!item.root && (macTrash || windowsTrash)) onTrash(item.entry);
        else handled = false;
      }
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [expanded, moveFocus, onOpen, onRename, onTarget, onTrash, toggleFolder, visibleItems]);
  return (
    <aside className="explorer" hidden={hidden} data-testid="explorer" aria-label="File explorer">
      <div className="pane-title">
        <h2>Explorer</h2>
        {root && <div className="pane-tools">
          <button className="icon-button" aria-label="Create file" title="Create file" data-testid="create-file"
            onClick={() => onCreate('file')}><Icon name="filePlus" size={15}/></button>
          <button className="icon-button" aria-label="Create folder" title="Create folder" data-testid="create-folder"
            onClick={() => onCreate('folder')}><Icon name="folderPlus" size={15}/></button>
          <button className="icon-button" aria-label="Refresh explorer" title="Refresh" onClick={onRefresh}><Icon name="refresh" size={14}/></button>
          <button className="icon-button" aria-label="Add folder to workspace" title="Add folder to workspace"
            onClick={onAddFolder}><Icon name="folderPlus" size={15}/></button>
          <button className="icon-button" aria-label="Save workspace configuration" title="Save workspace configuration"
            onClick={onSaveWorkspace}><Icon name="save" size={14}/></button>
          <button className="icon-button" aria-label="Open workspace configuration" title="Open workspace configuration"
            onClick={onOpenWorkspace}><Icon name="folder" size={14}/></button>
        </div>}
      </div>
      <div className="explorer-body">
        {root ? (
          <div className="explorer-tree" role="tree" aria-label="Workspace files" onKeyDown={handleTreeKeyDown}>
            {roots.map((workspaceRoot) => <section className="workspace-root" data-testid="workspace-root"
              data-path={workspaceRoot.path} key={workspaceRoot.path} role="none">
              <div className="workspace-root-heading">
                <button className={`tree-root ${target === workspaceRoot.path ? 'tree-root-selected' : ''}`} title={workspaceRoot.path}
                  role="treeitem" aria-level={1} aria-expanded="true" aria-selected={target === workspaceRoot.path}
                  data-path={workspaceRoot.path} tabIndex={focusedPath === workspaceRoot.path ? 0 : -1}
                  ref={(node) => { registerTreeItem(workspaceRoot.path, node); }}
                  aria-label={`Select root folder ${workspaceRoot.name}`} onFocus={() => setFocusedPath(workspaceRoot.path)}
                  onClick={() => { setFocusedPath(workspaceRoot.path); onTarget(workspaceRoot.path); }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setFocusedPath(workspaceRoot.path);
                    onTarget(workspaceRoot.path);
                    const bounds = event.currentTarget.getBoundingClientRect();
                    onContextMenu(workspaceRoot, true,
                      { x: event.clientX || bounds.left + 18, y: event.clientY || bounds.top + bounds.height });
                  }}>
                  <Icon name="down" size={13}/><Icon name="open" size={15}/><span>{workspaceRoot.name}
                    {duplicateRootNames.get(workspaceRoot.name)! > 1 ? ` — ${workspaceRoot.path.replace(/[/\\][^/\\]+$/, '').split(/[/\\]/).at(-1)}` : ''}</span>
                </button>
                {roots.length > 1 && <button className="icon-button" aria-label={`Remove ${workspaceRoot.name} from workspace`}
                  title="Remove folder from workspace" onClick={() => onRemoveFolder(workspaceRoot.path)}><Icon name="x" size={13}/></button>}
                {roots.length > 1 && <><button className="icon-button" aria-label={`Move ${workspaceRoot.name} up`}
                  disabled={roots[0].path === workspaceRoot.path} onClick={() => onReorderFolder(workspaceRoot.path, -1)}>↑</button>
                  <button className="icon-button" aria-label={`Move ${workspaceRoot.name} down`}
                    disabled={roots.at(-1)?.path === workspaceRoot.path} onClick={() => onReorderFolder(workspaceRoot.path, 1)}>↓</button></>}
              </div>
              <Folder path={workspaceRoot.path} depth={0} activePath={activePath} target={target} revision={revision}
                sourceControl={sourceControl} expanded={expanded} focusedPath={focusedPath} onOpen={onOpen} onTarget={onTarget}
                onToggle={toggleFolder} onFocusPath={setFocusedPath} onRegisterTreeItem={registerTreeItem}
                onDirectoryEntries={reportDirectoryEntries} onRename={onRename} onTrash={onTrash} onContextMenu={onContextMenu}/>
            </section>)}
          </div>
        ) : (
          <div className="explorer-empty">
            <Icon name="folder" size={24}/>
            <h3>No folder open</h3>
            <p>Open a folder to browse and manage its files.</p>
            <button className="button" onClick={onOpenFolder}>Open Folder</button>
            <button className="button" onClick={onOpenWorkspace}>Open Workspace</button>
          </div>
        )}
      </div>
      {root && (
        <div className="explorer-footer" title={target ?? root.path}>
          <Icon name="folder" size={13}/><span>{(() => {
            const owner = roots.find(({ path }) => target && isWithin(target, path));
            return target && owner ? target === owner.path ? owner.name : `${owner.name}/${target.slice(owner.path.length + 1)}` : root.name;
          })()}</span>
        </div>
      )}
      {!root && tabs.some((tab) => tab.path) && <div className="explorer-footer"><Icon name="files" size={13}/><span>Open files are in the tab bar</span></div>}
    </aside>
  );
}
