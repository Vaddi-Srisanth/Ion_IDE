import type { Entry } from '../shared/contracts';

export const MAX_VISIBLE_EXPLORER_ITEMS = 10_000;

export interface VisibleExplorerItem {
  entry: Entry;
  parentPath: string | null;
  depth: number;
  root: boolean;
}

/**
 * Produces the exact keyboard order of the currently rendered tree without
 * querying the DOM. The cap protects keyboard work from malformed or
 * unexpectedly large directory responses.
 */
export function visibleExplorerItems(roots: readonly Entry[], directories: ReadonlyMap<string, readonly Entry[]>,
  expanded: ReadonlySet<string>, limit = MAX_VISIBLE_EXPLORER_ITEMS): VisibleExplorerItem[] {
  const visible: VisibleExplorerItem[] = [];
  const append = (entry: Entry, parentPath: string | null, depth: number, root: boolean) => {
    if (visible.length >= limit) return;
    visible.push({ entry, parentPath, depth, root });
    if (entry.kind !== 'folder' || (!root && !expanded.has(entry.path))) return;
    for (const child of directories.get(entry.path) ?? []) {
      if (visible.length >= limit) break;
      append(child, entry.path, depth + 1, false);
    }
  };
  for (const root of roots) {
    if (visible.length >= limit) break;
    append(root, null, 1, true);
  }
  return visible;
}

export function adjacentExplorerPath(items: readonly VisibleExplorerItem[], currentPath: string,
  direction: -1 | 1): string | undefined {
  const index = items.findIndex(({ entry }) => entry.path === currentPath);
  if (index < 0) return items.at(direction > 0 ? 0 : -1)?.entry.path;
  return items[index + direction]?.entry.path;
}

export function firstExplorerChild(items: readonly VisibleExplorerItem[], parentPath: string): string | undefined {
  const index = items.findIndex(({ entry }) => entry.path === parentPath);
  const next = index >= 0 ? items[index + 1] : undefined;
  return next?.parentPath === parentPath ? next.entry.path : undefined;
}
