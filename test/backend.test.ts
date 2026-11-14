import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { maxFileBytes, revision, WorkspaceFiles } from '../src/main/files'
import { PreferenceStore } from '../src/main/preferences'
import { CRunner, detectCompiler } from '../src/main/runner'
import { textPageBytes } from '../src/shared/large-text'

async function sandbox(t: TestContext): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'ion-tests-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  return temporary
}

test('filesystem grants stay scoped to selected files and canonical folders', async (t) => {
  const temporary = await sandbox(t)
  const root = join(temporary, 'workspace')
  const outside = join(temporary, 'private.txt')
  await mkdir(root)
  await writeFile(outside, 'outside')
  await symlink(outside, join(root, 'escape.txt'))
  await symlink(temporary, join(root, 'escape-folder'))

  const files = new WorkspaceFiles()
  const granted = await files.grant(root, 'folder')
  await assert.rejects(files.read(outside), /before accessing/)
  await assert.rejects(files.read(join(granted.path, 'escape.txt')), /Symbolic links/)
  await assert.rejects(files.list(join(granted.path, 'escape-folder')), /Symbolic links/)
  assert.throws(() => files.create(granted.path, '../private.txt', 'file'), /valid file or folder name/)
  await assert.rejects(files.read(granted.path + '/../private.txt'), /Invalid file path/)
  assert.deepEqual(await files.list(granted.path), [])

  const individual = await files.grant(outside, 'file')
  assert.equal((await files.read(individual.path)).text, 'outside')
})

test('atomic saves detect conflicting changes and leave both user edits and original data recoverable', async (t) => {
  const temporary = await sandbox(t)
  const files = new WorkspaceFiles()
  const entry = await files.saveAs(join(temporary, 'source.c'), '\uFEFFalpha\r\n')
  assert.ok(entry)
  assert.equal((await files.read(entry.path)).text, '\uFEFFalpha\r\n')

  const saved = await files.save(entry.path, 'beta', entry.revision)
  assert.notEqual(saved.revision, entry.revision)
  const outcomes = await Promise.allSettled([
    files.save(entry.path, 'first', saved.revision, saved.contentHash),
    files.save(entry.path, 'second', saved.revision, saved.contentHash),
  ])
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[1].status, 'rejected')
  assert.equal(await readFile(entry.path, 'utf8'), 'first')

  const opened = await files.read(entry.path)
  await writeFile(entry.path, 'external edit')
  await assert.rejects(files.save(entry.path, 'unsaved change', opened.revision), /FILE_CHANGED/)
  assert.equal(await readFile(entry.path, 'utf8'), 'external edit')
  const recovered = await files.saveAs(join(temporary, 'recovered.c'), 'unsaved change')
  assert.ok(recovered)
  assert.equal(await readFile(recovered.path, 'utf8'), 'unsaved change')
})

test('source saves accept metadata-only changes and byte-identical replacements', async (t) => {
  const temporary = await sandbox(t)
  const files = new WorkspaceFiles()
  const original = '\uFEFFalpha\r\n'
  const entry = await files.saveAs(join(temporary, 'source.txt'), original)
  assert.ok(entry)
  const opened = await files.read(entry.path)
  assert.equal(opened.text, original)
  assert.equal(opened.contentHash, createHash('sha256').update(await readFile(entry.path)).digest('hex'))
  assert.equal(entry.contentHash, opened.contentHash)

  await utimes(entry.path, new Date(0), new Date(0))
  const touched = await files.read(entry.path)
  assert.notEqual(touched.revision, opened.revision)
  await assert.rejects(files.save(entry.path, 'legacy client', opened.revision), /FILE_CHANGED/)
  const edited = '\uFEFFbeta\r\n'
  const saved = await files.save(entry.path, edited, opened.revision, opened.contentHash)
  assert.equal(saved.baseRevision, touched.revision)
  assert.equal(await readFile(entry.path, 'utf8'), edited)

  const replacement = join(temporary, 'replacement.txt')
  await writeFile(replacement, edited)
  await rename(replacement, entry.path)
  const replaced = await files.read(entry.path)
  assert.notEqual(replaced.revision, saved.revision)
  assert.equal(replaced.contentHash, saved.contentHash)
  await files.save(entry.path, 'after replacement', saved.revision, saved.contentHash)
  assert.equal(await readFile(entry.path, 'utf8'), 'after replacement')
})

test('source saves reject same-size external changes even when the modified timestamp is restored', async (t) => {
  const temporary = await sandbox(t)
  const files = new WorkspaceFiles()
  const entry = await files.saveAs(join(temporary, 'source.txt'), 'original')
  assert.ok(entry)
  const timestamp = new Date('2020-01-01T00:00:00Z')
  await utimes(entry.path, timestamp, timestamp)
  const opened = await files.read(entry.path)
  await writeFile(entry.path, 'external')
  await utimes(entry.path, timestamp, timestamp)
  await assert.rejects(files.save(entry.path, 'my unsaved changes', opened.revision, opened.contentHash), /FILE_CHANGED/)
  assert.equal(await readFile(entry.path, 'utf8'), 'external')
})

test('source saves check the supplied base hash before mutation even when the metadata token matches', async (t) => {
  const temporary = await sandbox(t)
  const files = new WorkspaceFiles()
  const entry = await files.saveAs(join(temporary, 'source.txt'), 'original')
  assert.ok(entry)
  const opened = await files.read(entry.path)
  await writeFile(entry.path, 'external')
  const current = await files.read(entry.path)
  assert.notEqual(current.contentHash, opened.contentHash)
  assert.equal(current.revision, revision(await lstat(entry.path, { bigint: true })))
  // Supply the current metadata token with the editor's original base bytes.
  // This deterministically exercises the collision branch on every platform,
  // without depending on filesystem timestamp resolution or replacing stat().
  await assert.rejects(files.save(entry.path, 'my unsaved changes', current.revision, opened.contentHash), /FILE_CHANGED/)
  assert.equal(await readFile(entry.path, 'utf8'), 'external')
  assert.deepEqual(await readdir(temporary), ['source.txt'], 'A pre-existing conflict must be rejected before staging or exchange.')
})

test('directory operations protect existing entries and support cancellation', async (t) => {
  const temporary = await sandbox(t)
  const files = new WorkspaceFiles()
  const root = await files.grant(temporary, 'folder')
  const folder = await files.create(root.path, 'lib', 'folder')
  const first = await files.create(folder.path, 'first.c', 'file')
  const second = await files.create(folder.path, 'second.c', 'file')
  await assert.rejects(files.rename(first.path, second.name), /already exists/)

  const renamed = await files.rename(first.path, 'third.c')
  assert.deepEqual((await files.list(folder.path)).map((entry) => entry.name), ['second.c', 'third.c'])
  assert.equal(await files.trash(renamed.path, async () => false, async () => assert.fail('No approval')), false)
  assert.equal((await lstat(renamed.path)).isFile(), true)
  assert.equal(await files.trash(renamed.path, async () => true, (path) => rename(path, join(root.path, 'trashed.c'))), true)
  await assert.rejects(lstat(renamed.path), { code: 'ENOENT' })
  await assert.rejects(files.trash(root.path,
    async () => assert.fail('Workspace root must be rejected before confirmation.'),
    async () => assert.fail('Workspace root must not reach the native Trash operation.')),
  { message: /^(?:Move the workspace folder to Trash from Finder after closing it\.|Close the workspace before moving its folder to the Recycle Bin from File Explorer\.)$/ })
})

test('named files can be seeded without overwriting existing files', async (t) => {
  const temporary = await sandbox(t)
  const files = new WorkspaceFiles()
  const root = await files.grant(temporary, 'folder')
  const starter = '#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n'
  const created = await files.create(root.path, 'main.c', 'file', starter)
  assert.equal(await readFile(created.path, 'utf8'), starter)
  await assert.rejects(files.create(root.path, created.name, 'file', 'replacement'), { code: 'EEXIST' })
  assert.equal(await readFile(created.path, 'utf8'), starter)

  assert.throws(() => files.create(root.path, 'bad.c', 'file', 'binary\0text'), /UTF-8/)
  assert.throws(() => files.create(root.path, 'sources', 'folder', starter), /editable text files/)
  assert.throws(() => files.create(root.path, 'notes.pdf', 'file', starter), /editable text files/)
  assert.throws(() => files.create(root.path, 'notebook.ipynb', 'file', starter), /editable text files/)
  const blank = await files.create(root.path, 'empty.c', 'file')
  assert.equal(await readFile(blank.path, 'utf8'), '')
  assert.deepEqual((await readdir(root.path)).sort(), ['empty.c', 'main.c'])
})

test('source saves preserve modes, reject invalid Unicode, and fail closed after a disk replacement', async (t) => {
  const temporary = await sandbox(t)
  const files = new WorkspaceFiles()
  const entry = await files.saveAs(join(temporary, 'source.txt'), 'original')
  assert.ok(entry)
  await chmod(entry.path, 0o640)
  const opened = await files.read(entry.path)
  assert.throws(() => files.save(entry.path, 'unpaired \uD800', opened.revision), /UTF-8/)
  assert.equal(await readFile(entry.path, 'utf8'), 'original')
  const valid = await files.save(entry.path, 'valid 🧪', opened.revision)
  assert.equal(await readFile(entry.path, 'utf8'), 'valid 🧪')
  if (process.platform !== 'win32') assert.equal((await lstat(entry.path)).mode & 0o777, 0o640)

  const moved = join(temporary, 'original.txt')
  await rename(entry.path, moved)
  await assert.rejects(files.save(entry.path, 'buffer', valid.revision), /FILE_CHANGED/)
  await writeFile(entry.path, 'replacement')
  await assert.rejects(files.save(entry.path, 'buffer', valid.revision), /FILE_CHANGED/)
  assert.equal(await readFile(entry.path, 'utf8'), 'replacement')
  assert.equal(await readFile(moved, 'utf8'), 'valid 🧪')
  assert.deepEqual((await readdir(temporary)).sort(), ['original.txt', 'source.txt'])
})

test('Save As requires replacement consent and rechecks the destination revision', async (t) => {
  const temporary = await sandbox(t)
  const destination = join(temporary, 'target.txt')
  await writeFile(destination, 'earlier contents')
  const files = new WorkspaceFiles()
  assert.equal(await files.saveAs(destination, 'buffer'), null)
  assert.equal(await files.saveAs(destination, 'buffer', async () => false), null)
  assert.equal(await readFile(destination, 'utf8'), 'earlier contents')
  await assert.rejects(files.saveAs(destination, 'buffer', async (path) => {
    assert.equal(path, await files.grant(destination, 'file').then((entry) => entry.path))
    await writeFile(destination, 'new external contents')
    return true
  }), /FILE_CHANGED/)
  assert.equal(await readFile(destination, 'utf8'), 'new external contents')
  assert.deepEqual(await readdir(temporary), ['target.txt'])
  assert.ok(await files.saveAs(destination, 'buffer', async () => true))
  assert.equal(await readFile(destination, 'utf8'), 'buffer')
})

test('binary, invalid UTF-8 and oversized files are rejected', async (t) => {
  const temporary = await sandbox(t)
  const files = new WorkspaceFiles()
  const root = await files.grant(temporary, 'folder')
  await writeFile(join(root.path, 'binary'), Buffer.from([0, 32]))
  await writeFile(join(root.path, 'invalid'), Buffer.from([0xff, 32]))
  await writeFile(join(root.path, 'large'), Buffer.alloc(maxFileBytes + 1, 32))
  await assert.rejects(files.read(join(root.path, 'binary')), /binary data/)
  await assert.rejects(files.read(join(root.path, 'invalid')), /valid UTF-8/)
  await assert.rejects(files.read(join(root.path, 'large')), /2 MiB/)
})

test('large text paging keeps UTF-8 characters intact and rejects stale or ungranted files', async (t) => {
  const temporary = await sandbox(t)
  const workspace = join(temporary, 'workspace')
  await mkdir(workspace)
  const files = new WorkspaceFiles()
  const { path: root } = await files.grant(workspace, 'folder')
  const path = join(root, 'large.txt')
  const prefix = 'a'.repeat(textPageBytes - 1)
  const text = prefix + '🧪next page\n' + 'b'.repeat(maxFileBytes)
  await writeFile(path, text)
  await assert.rejects(files.read(path), /TEXT_FILE_TOO_LARGE/)
  const first = await files.readTextPage(path, 0)
  assert.equal(first.text, prefix + '🧪')
  const next = await files.readTextPage(path, 1, first.revision)
  assert.ok(next.text.startsWith('next page\n'))
  assert.equal(next.pages, Math.ceil(Buffer.byteLength(text) / textPageBytes))
  await assert.rejects(files.save(path, 'a partial page', first.revision), /read only/)
  assert.equal(await readFile(path, 'utf8'), text)
  await assert.rejects(files.readTextPage(join(temporary, 'elsewhere.txt'), 0), /before accessing/)
  await writeFile(path, text + '\nchanged')
  await assert.rejects(files.readTextPage(path, 1, first.revision), /changed on disk/)
})

test('preferences validate settings and persist sorted, deduplicated recents', async (t) => {
  const temporary = await sandbox(t)
  const path = join(temporary, 'preferences.json')
  const store = new PreferenceStore(path)
  assert.equal((await store.get()).settings.resourceProfile, 'minimal')
  assert.equal((await store.get()).settings.openFullScreen, false)
  await assert.rejects(store.updateSettings({ resourceProfile: 'unknown' }), /Invalid setting/)
  await assert.rejects(store.updateSettings({ openFullScreen: 'true' }), /Invalid setting/)
  await store.updateSettings({ resourceProfile: 'full', openFullScreen: true })
  await Promise.all([store.updateSettings({ theme: 'light' }), store.updateSettings({ fontSize: 18 })])
  await assert.rejects(store.updateSettings({ explorerWidth: 100_000 }), /Invalid setting/)
  await assert.rejects(store.updateSettings({ path }), /Invalid setting/)
  const first = { path: join(temporary, 'main.c'), name: 'main.c', kind: 'file' as const }
  const second = { path: join(temporary, 'util.c'), name: 'util.c', kind: 'file' as const }
  await store.remember(first)
  await store.remember(second)
  await store.remember(first)
  const prefs = await new PreferenceStore(path).get()
  assert.equal(prefs.settings.resourceProfile, 'full')
  assert.equal(prefs.settings.openFullScreen, true)
  assert.equal(prefs.settings.theme, 'light')
  assert.equal(prefs.settings.fontSize, 18)
  assert.deepEqual(prefs.recents.map((entry) => entry.name), ['main.c', 'util.c'])
})

test('future or damaged preferences remain byte-for-byte intact after a rejected update', async (t) => {
  const temporary = await sandbox(t)
  const path = join(temporary, 'preferences.json')
  for (const contents of [Buffer.from('{"version":999,"settings":{"autoSave":false}}'), Buffer.from('{"version":'), Buffer.from([0xff])]) {
    await writeFile(path, contents)
    const store = new PreferenceStore(path)
    await assert.rejects(store.get(), /preferences|settings file/i)
    await assert.rejects(store.updateSettings({ fontSize: 20 }), /left in place/)
    assert.deepEqual(await readFile(path), contents)
    assert.deepEqual(await readdir(temporary), ['preferences.json'])
  }
})

test('C runner reports missing toolchains', async () => {
  const runner = new CRunner(undefined, async () => null)
  assert.equal((await runner.run('/unused.c', '')).status, 'missing-toolchain')
})

test('C runner compiles local C, handles stdin and diagnostics, and bounds repeated execution', async (t) => {
  const compiler = await detectCompiler(new AbortController().signal)
  if (!compiler) return t.skip('No local C compiler detected.')

  const temporary = await sandbox(t)
  const source = join(temporary, 'my program.c')
  const runner = new CRunner({ compileMs: 15_000, programMs: 3000, outputBytes: 2048 }, async () => compiler)
  await writeFile(source, '#include <stdio.h>\nint main(void) { int n; if (scanf("%d", &n) != 1) return 1; printf("%d\\n", n + 1); }')
  const result = await runner.run(source, '41\n')
  assert.equal(result.status, 'success', result.compileOutput)
  assert.equal(result.programOutput, '42\n')

  await writeFile(source, 'int main(void) { return 0 }')
  const invalid = await runner.run(source, '')
  assert.equal(invalid.status, 'compile-error')
  assert.match(invalid.compileOutput, /error:/)

  await writeFile(source, 'int main(void) { return 7; }')
  const failure = await runner.run(source, '')
  assert.equal(failure.status, 'runtime-error')
  assert.equal(failure.exitCode, 7)

  await writeFile(source, '#include <stdio.h>\nint main(void) { for (;;) putchar(120); }')
  const output = await runner.run(source, '')
  assert.equal(output.status, 'output-limit')
  assert.equal(output.programOutput.length, 2048)

  await writeFile(source, 'int main(void) { for (;;) {} }')
  const shortRunner = new CRunner({ compileMs: 15_000, programMs: 300, outputBytes: 2048 }, async () => compiler)
  const running = shortRunner.run(source, '')
  assert.equal((await shortRunner.run(source, '')).status, 'rejected')
  assert.equal((await running).status, 'timeout')
  const cancelled = shortRunner.run(source, '')
  shortRunner.stop()
  assert.equal((await cancelled).status, 'cancelled')
})

test('C runner separates output streams and releases pipes after its leader exits', async (t) => {
  const compiler = await detectCompiler(new AbortController().signal)
  if (!compiler || process.platform === 'win32') return t.skip('Requires a POSIX C toolchain.')
  const temporary = await sandbox(t)
  const source = join(temporary, 'child.c')
  const runner = new CRunner({ compileMs: 15_000, programMs: 5000, outputBytes: 2048 }, async () => compiler)
  // A detached child deliberately inherits stdout but exits on its own if cleanup is interrupted.
  await writeFile(source, `
    #include <stdio.h>
    #include <unistd.h>
    int main(void) {
      int ready[2];
      if (pipe(ready) != 0) return 1;
      pid_t child = fork();
      if (child < 0) return 2;
      if (child == 0) {
        close(ready[0]);
        if (setsid() < 0) _exit(3);
        if (write(ready[1], "x", 1) != 1) _exit(4);
        sleep(4);
        _exit(0);
      }
      close(ready[1]);
      char signal;
      if (read(ready[0], &signal, 1) != 1) return 5;
      printf("%d\\n", (int)child);
      fprintf(stderr, "notice\\n");
      return 0;
    }
  `)
  const result = await runner.run(source, '')
  const child = Number(result.programStdout?.trim())
  if (Number.isInteger(child) && child > 0) {
    t.after(() => { try { process.kill(child, 'SIGKILL') } catch { /* The fixture already exited. */ } })
  }
  assert.equal(result.status, 'success', result.compileOutput || result.message)
  assert.ok(child > 0)
  assert.equal(result.programStderr, 'notice\n')
  assert.equal(result.outputComplete, false)
  assert.match(result.programOutput, /notice/)
  assert.ok((result.programMs ?? Infinity) < 3000, 'a detached pipe does not hold the run open')
  assert.equal(runner.busy, false)
})
