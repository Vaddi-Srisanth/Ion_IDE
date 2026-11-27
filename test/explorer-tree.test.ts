import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Entry } from '../src/shared/contracts';
import { adjacentExplorerPath, firstExplorerChild, visibleExplorerItems } from '../src/renderer/explorer-tree';

const folder = (path: string): Entry => ({ path, name: path.split('/').at(-1)!, kind: 'folder' });
const file = (path: string): Entry => ({ path, name: path.split('/').at(-1)!, kind: 'file' });

test('visible explorer order follows expanded folders across multiple roots', () => {
  const roots = [folder('/one'), folder('/two')];
  const directories = new Map<string, Entry[]>([
    ['/one', [folder('/one/src'), file('/one/readme.md')]],
    ['/one/src', [file('/one/src/main.c')]],
    ['/two', [file('/two/app.py')]],
  ]);
  const visible = visibleExplorerItems(roots, directories, new Set(['/one/src']));
  assert.deepEqual(visible.map(({ entry }) => entry.path),
    ['/one', '/one/src', '/one/src/main.c', '/one/readme.md', '/two', '/two/app.py']);
  assert.deepEqual(visible.map(({ depth }) => depth), [1, 2, 3, 2, 1, 2]);
  assert.equal(firstExplorerChild(visible, '/one'), '/one/src');
  assert.equal(firstExplorerChild(visible, '/one/src'), '/one/src/main.c');
});

test('collapsed descendants are absent from keyboard order', () => {
  const root = folder('/workspace');
  const directories = new Map<string, Entry[]>([
    ['/workspace', [folder('/workspace/src'), file('/workspace/readme.md')]],
    ['/workspace/src', [file('/workspace/src/main.c')]],
  ]);
  const visible = visibleExplorerItems([root], directories, new Set());
  assert.deepEqual(visible.map(({ entry }) => entry.path), ['/workspace', '/workspace/src', '/workspace/readme.md']);
  assert.equal(firstExplorerChild(visible, '/workspace/src'), undefined);
  assert.equal(adjacentExplorerPath(visible, '/workspace/src', 1), '/workspace/readme.md');
  assert.equal(adjacentExplorerPath(visible, '/workspace/src', -1), '/workspace');
});

test('visible explorer derivation is bounded', () => {
  const root = folder('/workspace');
  const directories = new Map([['/workspace', Array.from({ length: 20 }, (_, index) => file(`/workspace/${index}.c`))]]);
  const visible = visibleExplorerItems([root], directories, new Set(), 5);
  assert.equal(visible.length, 5);
  assert.equal(visible.at(-1)?.entry.path, '/workspace/3.c');
});
