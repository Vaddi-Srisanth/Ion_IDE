import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { workspaceEditRows } from '../src/main/language-tools/lsp-adapter'
import { LanguageWorkspaceEditReview } from '../src/main/language-tools/workspace-edit-review'

const range = (start: [number, number], end: [number, number]) => ({
  start: { line: start[0], character: start[1] }, end: { line: end[0], character: end[1] },
})

async function fixture() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-lsp-edit-')))
  const root = join(scratch, 'workspace')
  await mkdir(root)
  const main = join(root, 'main.ts'), helper = join(root, 'helper.ts')
  await writeFile(main, 'const oldName = 1\nconsole.log(oldName)\n')
  await writeFile(helper, 'export const value = oldName\n')
  const files = new WorkspaceFiles()
  await files.grant(root, 'folder', true)
  return { scratch, root, main, helper, files }
}

test('reviewed language edits use authorized revisions and atomic file saves', async () => {
  const value = await fixture()
  try {
    const rows = workspaceEditRows({ changes: {
      [pathToFileURL(value.main).href]: [
        { range: range([0, 6], [0, 13]), newText: 'nextName' },
        { range: range([1, 12], [1, 19]), newText: 'nextName' },
      ],
      [pathToFileURL(value.helper).href]: [{ range: range([0, 21], [0, 28]), newText: 'nextName' }],
    } }, value.main)
    const review = new LanguageWorkspaceEditReview(value.files)
    const preview = await review.review(rows, [])
    assert.equal(preview.edits, 3)
    assert.equal(preview.files.length, 2)
    const result = await review.apply(preview.token)
    assert.deepEqual(result.failed, [])
    assert.deepEqual(new Set(result.applied), new Set([value.main, value.helper]))
    assert.match(await readFile(value.main, 'utf8'), /nextName/)
    assert.match(await readFile(value.helper, 'utf8'), /nextName/)
  } finally { await rm(value.scratch, { recursive: true, force: true }) }
})

test('review refuses dirty, outside, traversal, overlapping and stale edits', async () => {
  const value = await fixture()
  const outside = join(value.scratch, 'outside.ts')
  await writeFile(outside, 'oldName\n')
  try {
    const row = [value.main, '0', '6', '0', '13', 'nextName']
    await assert.rejects(() => new LanguageWorkspaceEditReview(value.files).review([row], [value.main]), /Save or discard/)
    await assert.rejects(() => new LanguageWorkspaceEditReview(value.files).review([[outside, '0', '0', '0', '7', 'nextName']], []), /Open the file|outside/)
    await assert.rejects(() => new LanguageWorkspaceEditReview(value.files).review([
      row, [value.main, '0', '8', '0', '12', 'overlap'],
    ], []), /overlapping/)

    const review = new LanguageWorkspaceEditReview(value.files)
    const preview = await review.review([row], [])
    await writeFile(value.main, 'const external = 2\n')
    const result = await review.apply(preview.token)
    assert.equal(result.applied.length, 0)
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].message, /changed/i)
    await assert.rejects(() => review.apply(preview.token), /expired/)

    const otherRoot = join(value.scratch, 'other-workspace')
    await mkdir(otherRoot)
    await value.files.addRoot(otherRoot, true)
    const removed = new LanguageWorkspaceEditReview(value.files)
    const removedPreview = await removed.review([[value.main, '0', '6', '0', '13', 'nextName']], [])
    assert.equal(value.files.removeRoot(otherRoot), true)
    await assert.rejects(() => removed.apply(removedPreview.token), /workspace changed/i)
  } finally { await rm(value.scratch, { recursive: true, force: true }) }
})

test('workspace edit parser rejects resource operations, invalid URIs, oversized text and symlink escapes', async () => {
  const value = await fixture()
  try {
    assert.throws(() => workspaceEditRows({ documentChanges: [{ kind: 'create', uri: pathToFileURL(value.main).href }] }, value.main), /resource operations/)
    assert.throws(() => workspaceEditRows({ changes: { 'https://example.invalid/file': [] } }, value.main), /local files/)
    assert.throws(() => workspaceEditRows({ changes: { [pathToFileURL(value.main).href]: [
      { range: range([0, 0], [0, 0]), newText: 'x'.repeat(1024 * 1024 + 1) },
    ] } }, value.main), /1 MiB/)
    const outside = join(value.scratch, 'outside.ts')
    await writeFile(outside, 'outside\n')
    const link = join(value.root, 'linked.ts')
    try {
      await symlink(outside, link, process.platform === 'win32' ? 'file' : undefined)
      await assert.rejects(() => new LanguageWorkspaceEditReview(value.files).review([[link, '0', '0', '0', '0', 'x']], []), /regular file|Open the file/)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code)))) throw error
    }
  } finally { await rm(value.scratch, { recursive: true, force: true }) }
})
