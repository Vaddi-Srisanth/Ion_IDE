import { memo, useEffect, useMemo, useState } from 'react';
import type { Entry, EntryKind } from '../shared/contracts';
import type { SourceControlEntry } from '../shared/source-control';
import { errorMessage, type Tab } from './documents';
import { Icon } from './icons';
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
  onOpen(entry: Entry): void;
  onTarget(path: string): void;
  onRename(entry: Entry): void;
  onTrash(entry: Entry): void;
}

const Folder = memo(function Folder(props: FolderProps) {
  const { path, depth, activePath, target, revision, sourceControl, onOpen, onTarget, onRename, onTrash } = props;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(() => new Set<string>());

  useEffect(() => {
    let cancelled = false;
    window.ion.listDirectory(path).then((items) => {
      if (!cancelled) {
        setEntries(items);
        setError(null);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setEntries(null);
        setError(errorMessage(reason));
      }
    });
    return () => { cancelled = true; };
  }, [path, revision]);

  const toggle = (entry: Entry) => {
    onTarget(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (current.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  if (error) return <p className="tree-message" role="status">{error}</p>;
  if (!entries) return <p className="tree-message" role="status">Reading folder…</p>;
  if (!entries.length) return depth === 0 ? <p className="tree-message">This folder is empty.</p> : null;
  return (
    <ul className="tree" aria-label={depth === 0 ? 'Folder contents' : undefined}>
      {entries.map((entry) => {
        const isFolder = entry.kind === 'folder';
        const isExpanded = expanded.has(entry.path);
        const selected = isFolder ? target === entry.path : activePath === entry.path;
        const change = sourceControl?.get(sourceControlPathKey(entry.path));
        const status = change?.unmerged ? '!' : change?.worktree === '?' ? 'U' : change?.worktree || change?.index;
        return (
          <li key={entry.path}>
            <div className={`tree-row ${selected ? 'selected' : ''}`} style={{ paddingInlineStart: 7 + depth * 13 }}
              data-testid="explorer-row" data-path={entry.path}>
              <button className="tree-label" data-testid="explorer-entry" data-path={entry.path}
                aria-expanded={isFolder ? isExpanded : undefined} aria-current={!isFolder && selected ? 'true' : undefined}
                title={entry.path}
                onClick={() => isFolder ? toggle(entry) : (onTarget(path), onOpen(entry))}>
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
  onOpen, onTarget, onCreate, onRename, onTrash, onRefresh, onOpenFolder, onAddFolder, onRemoveFolder, onReorderFolder,
  onSaveWorkspace, onOpenWorkspace }: ExplorerProps) {
  const sourceControl = useMemo(() => sourceControlEntries?.length
    ? new Map(sourceControlEntries.map((entry) => [sourceControlPathKey(entry.absolutePath), entry])) : undefined, [sourceControlEntries]);
  const duplicateRootNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of roots) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    return counts;
  }, [roots]);
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
          <>
            {roots.map((workspaceRoot) => <section className="workspace-root" data-testid="workspace-root"
              data-path={workspaceRoot.path} key={workspaceRoot.path}>
              <div className="workspace-root-heading">
                <button className={`tree-root ${target === workspaceRoot.path ? 'tree-root-selected' : ''}`} title={workspaceRoot.path}
                  aria-label={`Select root folder ${workspaceRoot.name}`} onClick={() => onTarget(workspaceRoot.path)}>
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
                sourceControl={sourceControl} onOpen={onOpen} onTarget={onTarget} onRename={onRename} onTrash={onTrash}/>
            </section>)}
          </>
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
