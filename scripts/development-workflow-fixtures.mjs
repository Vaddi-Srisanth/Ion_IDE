import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createProject, eventually, resourceSnapshot } from './desktop-harness.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'

const execute = promisify(execFile)

export async function git(root, ...args) {
  const { stdout } = await execute('git', ['-C', root, ...args], {
    windowsHide: true, timeout: 10_000, maxBuffer: 2_000_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  })
  return stdout
}

export async function developmentFixture(root, { medium = false } = {}) {
  const project = await createProject(root, { medium })
  const changed = join(root, 'edited résumé.txt')
  const deleted = join(root, 'deleted.txt')
  const renamed = join(root, 'old name.txt')
  const renamedTo = join(root, 'new name.txt')
  const untracked = join(root, 'new ñote.txt')
  const ignored = join(root, 'local.ignore')
  const large = join(root, 'large-diff.txt')
  const waiting = join(root, 'waiting.c')
  const original = 'original tracked text\r\nsecond line\r\n'
  await Promise.all([
    writeFile(join(root, '.gitignore'), '*.ignore\n'), writeFile(ignored, 'ignored'), writeFile(changed, original),
    writeFile(deleted, 'delete this file\n'), writeFile(renamed, 'this content survives a rename\n'),
    writeFile(large, Array.from({ length: 7_000 }, (_, index) => `Original row ${index}\n`).join('')),
    writeFile(waiting, `#define _POSIX_C_SOURCE 199309L
#ifdef _WIN32
#include <windows.h>
#else
#include <time.h>
#endif
#include <stdio.h>
int main(void) {
#ifdef _WIN32
    Sleep(3600);
#else
    const struct timespec delay = {3, 600000000};
    nanosleep(&delay, NULL);
#endif
    puts("done");
    return 0;
}
`),
  ])
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Ion Desktop Fixture')
  await git(root, 'config', 'user.email', 'ion-fixture@example.invalid')
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'add', '--all')
  await git(root, 'commit', '--no-gpg-sign', '-m', 'Fixture baseline')
  await git(root, 'rm', '--', 'deleted.txt')
  await git(root, 'mv', '--', 'old name.txt', 'new name.txt')
  const modified = 'original tracked text\r\nchanged line\r\n'
  await Promise.all([
    writeFile(changed, modified), writeFile(untracked, 'new working text\n'),
    writeFile(large, (await readFile(large, 'utf8')).replace(/Original row (1[0-9]{3}|6[0-9]{3})/g, 'Modified row $1')),
  ])
  return { ...project, changed, deleted, renamed, renamedTo, untracked, ignored, large, waiting, original, modified }
}

export function testSpec({ waits = 'loop.c', waitingOutput = '' } = {}) {
  const example = { milestoneId: 'behavior', source: 'program.c', stdin: '', match: 'exact', exitCode: 0 }
  return { version: 1, title: 'C behavior suite', description: 'Local verification fixture.', goal: 'Verify observable output.',
    technologies: ['C'], files: [], environment: [],
    milestones: [{ id: 'behavior', title: 'Behavior', description: '', dependsOn: [], acceptance: ['Check output.'], status: 'not-started' }],
    tests: [
      { ...example, id: 'pass', title: 'Matching output', expectedOutput: 'ION-DESKTOP-RUN-OK\n' },
      { ...example, id: 'fail', title: 'Different output', expectedOutput: 'Expected different output\n' },
      { ...example, id: 'broken', title: 'Compiler problem', source: 'broken.c', expectedOutput: '' },
      { ...example, id: 'waiting', title: 'Waiting program', source: waits, expectedOutput: waitingOutput },
    ] }
}

export function processTree(session) {
  return process.platform === 'win32' ? windowsProcessTree(session) : resourceSnapshot(session, { details: true })
}

export async function waitForChildren(session, predicate, message) {
  await eventually(async () => predicate((await processTree(session)).members.filter(({ kind }) => kind === 'child')),
    message, 18_000)
}
