import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WorkspaceFiles } from '../src/main/files'
import { readMarkdownImage, resolveMarkdownLink } from '../src/main/markdown-assets'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/UqkAAAAASUVORK5CYII=', 'base64')

test('Markdown images and file links stay inside the active workspace even with other grants', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ion-markdown-assets-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const files = new WorkspaceFiles()
  await mkdir(join(temporary, 'work', 'notes'), { recursive: true })
  const root = (await files.grant(join(temporary, 'work'), 'folder')).path
  const source = join(root, 'notes', 'Study.MARKDOWN')
  const sibling = join(root, 'notes', 'Other note.md')
  const outside = join(temporary, 'private.png')
  const outsideNote = join(temporary, 'outside.md')
  await Promise.all([
    writeFile(source, '# Test'), writeFile(sibling, '# Other'), writeFile(join(root, 'chart #1.png'), png),
    writeFile(outside, png), writeFile(outsideNote, '# Outside'),
    symlink(outside, join(root, 'escape.png')),
    symlink(temporary, join(root, 'escape-folder'), 'dir'),
  ])
  const separatelyOpened = await files.grant(outsideNote, 'file')
  await files.grant(outside, 'file')

  const image = await readMarkdownImage(files, source, '../chart%20%231.png')
  assert.equal(image.mime, 'image/png')
  assert.deepEqual(Buffer.from(image.bytes), png)
  assert.deepEqual(await resolveMarkdownLink(files, source, 'Other%20note.md#section'), {
    kind: 'file', entry: { kind: 'file', name: 'Other note.md', path: sibling },
  })

  for (const href of ['../../private.png', '%2e%2e/%2e%2e/private.png', '/etc/passwd', '../escape.png',
    '../escape-folder/private.png', 'https://example.test/remote.png', '//example.test/remote.png',
    'file:///etc/passwd', 'data:image/png;base64,AA', '..%5cescape.png', 'bad%00.png']) {
    await assert.rejects(readMarkdownImage(files, source, href), href)
  }
  await assert.rejects(readMarkdownImage(files, separatelyOpened.path, 'private.png'), /inside a workspace folder/)
  await assert.rejects(resolveMarkdownLink(files, source, '../../outside.md'), /outside the workspace/)
  await assert.rejects(resolveMarkdownLink(files, source, '../escape-folder/outside.md'), /Symbolic links/)
  await assert.rejects(readMarkdownImage(new WorkspaceFiles(), source, '../chart%20%231.png'), /inside a workspace folder/)
})

test('Markdown image requests reject oversized images and disguised or active formats', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ion-markdown-image-limits-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const files = new WorkspaceFiles()
  const root = (await files.grant(temporary, 'folder')).path
  const source = join(root, 'main.md')
  const huge = Buffer.from(png)
  huge.writeUInt32BE(9000, 16)
  await Promise.all([
    writeFile(source, '# Test'), writeFile(join(root, 'big-pixels.png'), huge),
    writeFile(join(root, 'active.svg'), '<svg onload="alert(1)"/>'),
    writeFile(join(root, 'fake.png'), '<svg onload="alert(1)"/>'),
    writeFile(join(root, 'big-file.png'), png),
  ])
  await truncate(join(root, 'big-file.png'), 5 * 1024 * 1024 + 1)
  await assert.rejects(readMarkdownImage(files, source, 'active.svg'), /Only PNG/)
  await assert.rejects(readMarkdownImage(files, source, 'fake.png'), /does not match/)
  await assert.rejects(readMarkdownImage(files, source, 'big-pixels.png'), /dimension limit/)
  await assert.rejects(readMarkdownImage(files, source, 'big-file.png'), /at most 5 MiB/)
})

test('Markdown image reads revalidate the active workspace before returning bytes', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ion-markdown-image-scope-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const files = new WorkspaceFiles()
  await Promise.all([mkdir(join(temporary, 'first')), mkdir(join(temporary, 'second'))])
  const root = (await files.grant(join(temporary, 'first'), 'folder')).path
  const source = join(root, 'main.md')
  const asset = join(root, 'preview.png')
  await Promise.all([writeFile(source, '# Test'), writeFile(asset, png)])
  const inspect = files.inspect.bind(files)
  let assetChecks = 0
  files.inspect = async (path, kind) => {
    const entry = await inspect(path, kind)
    if (path === asset && ++assetChecks === 2) await files.grant(join(temporary, 'second'), 'folder')
    return entry
  }
  await assert.rejects(readMarkdownImage(files, source, 'preview.png'), /workspace changed/)
})

test('Markdown external link targets accept explicit HTTP(S) URLs and reject unsafe schemes', async () => {
  const files = new WorkspaceFiles()
  assert.deepEqual(await resolveMarkdownLink(files, null, 'https://example.test/topic?q=reference#details'), {
    kind: 'external', href: 'https://example.test/topic?q=reference#details',
  })
  for (const href of ['javascript:alert(1)', 'file:///etc/passwd', '//example.test', 'mailto:example@example.test',
    'https://example.test@different.test', 'https://user:pass@example.test', 'https://exa\nmple.test']) {
    await assert.rejects(resolveMarkdownLink(files, null, href), href)
  }
})
