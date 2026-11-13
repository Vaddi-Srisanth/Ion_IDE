import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { WorkspaceFiles } from '../src/main/files'
import { fileMutations } from '../src/main/file-mutations'

const execute = promisify(execFile)
const mac = process.platform === 'darwin'
async function setup(t: TestContext) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-save-metadata-')))
  const folder = join(scratch, 'workspace café')
  await mkdir(folder)
  const path = join(folder, 'source.c')
  await writeFile(path, 'original\n')
  t.after(async () => {
    if (mac) await execute('/bin/chmod', ['-N', path]).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true })
  })
  const files = new WorkspaceFiles()
  await files.grant(folder, 'folder')
  return { scratch, folder, path, files }
}
async function xattr(path: string, name: string, value?: Buffer) {
  if (value) await execute('/usr/bin/xattr', ['-wx', name, value.toString('hex'), path])
  const { stdout } = await execute('/usr/bin/xattr', ['-px', name, path])
  return Buffer.from(stdout.replace(/\s/g, ''), 'hex')
}
async function acl(path: string) {
  const { stdout } = await execute('/bin/ls', ['-le', path])
  return stdout.split(/\r?\n/).filter((line) => /^\s*\d+:/.test(line)).join('\n')
}

test('macOS source saves preserve bounded xattrs, Finder tags, quarantine, ACL, owner, group and mode', { skip: !mac }, async (t) => {
  const { scratch, folder, path, files } = await setup(t)
  await chmod(path, 0o750)
  const original = await lstat(path)
  const anotherGroup = process.getgroups?.().find((group) => group !== original.gid)
  if (anotherGroup !== undefined) await chown(path, original.uid, anotherGroup)
  const tagSource = join(scratch, 'tags.xml')
  const tagBinary = join(scratch, 'tags.plist')
  await writeFile(tagSource, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>Ion fixture\n6</string></array></plist>')
  await execute('/usr/bin/plutil', ['-convert', 'binary1', '-o', tagBinary, tagSource])
  const attributes = new Map([
    ['com.ionide.metadata.fixture', Buffer.from('preserve me β')],
    ['com.apple.metadata:_kMDItemUserTags', await readFile(tagBinary)],
    ['com.apple.quarantine', Buffer.from('0083;6fffffff;IonMetadataFixture;00000000-0000-4000-8000-000000000001')],
  ])
  for (const [name, value] of attributes) await xattr(path, name, value)
  await execute('/bin/chmod', ['+a', 'everyone deny execute', path])
  const expectedAcl = await acl(path)
  assert.ok(expectedAcl, 'fixture contains a real explicit extended ACL')
  const before = await lstat(path)
  for (let round = 1; round <= 3; round++) {
    const opened = await files.read(path)
    await files.save(path, `saved ${round}\n`, opened.revision)
    assert.equal(await readFile(path, 'utf8'), `saved ${round}\n`)
    const after = await lstat(path)
    assert.equal(after.mode & 0o777, before.mode & 0o777)
    assert.equal(after.uid, before.uid)
    assert.equal(after.gid, before.gid)
    assert.equal(await acl(path), expectedAcl)
    for (const [name, value] of attributes) assert.deepEqual(await xattr(path, name), value)
  }
  assert.deepEqual(await readdir(folder), ['source.c'])
})

test('macOS metadata read denial rejects before replacement and preserves the original source', { skip: !mac }, async (t) => {
  const { folder, path, files } = await setup(t)
  await xattr(path, 'com.ionide.metadata.fixture', Buffer.from('original attribute'))
  await execute('/bin/chmod', ['+a', 'everyone deny readextattr', path])
  const opened = await files.read(path)
  const before = await lstat(path)
  await assert.rejects(files.save(path, 'unsaved editor buffer\n', opened.revision))
  const after = await lstat(path)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.equal(await readFile(path, 'utf8'), 'original\n')
  assert.deepEqual(await readdir(folder), ['source.c'])
  await execute('/bin/chmod', ['-N', path])
  assert.deepEqual(await xattr(path, 'com.ionide.metadata.fixture'), Buffer.from('original attribute'))
})

test('macOS replacement staging remains private before source metadata is transferred', { skip: !mac }, async (t) => {
  const { folder } = await setup(t)
  await execute('/bin/chmod', ['+a', 'everyone allow read,readattr,readextattr,readsecurity,file_inherit', folder])
  const staged = join(folder, '.ion-private-test.tmp')
  const oldMask = process.umask(0o777)
  try {
    await fileMutations().prepare(staged, await lstat(folder, { bigint: true }), 0o1644, 'file', 'unpublished source')
  } finally { process.umask(oldMask) }
  assert.equal((await lstat(staged)).mode & 0o777, 0o600)
  assert.equal(await acl(staged), '', 'Inherited grants must be cleared before staging source bytes.')
})
