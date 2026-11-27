// New harness controls only. Never launches Electron, including in CI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';
import { rpc, tree, cleanupFailed } from './core-native/session.mjs';

test('native observer refuses missing ownership before opening an inspector or loading production', () => {
  const env = { ...process.env, CI: 'true' };
  for (const key of ['ION_CORE_ACCEPTANCE_ROOT', 'ION_CORE_ACCEPTANCE_TOKEN', 'ION_CORE_PRODUCTION_ENTRY']) delete env[key];
  const result = spawnSync(process.execPath, ['scripts/core-native/bootstrap.cjs'], { env, encoding: 'utf8', timeout: 4000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /Refusing unowned native acceptance profile/);
  assert.doesNotMatch(result.stderr, /Debugger listening/);
});
test('inspector transport executes a real Node request, reports exceptions and releases its connection', async () => {
  const child = spawn(process.execPath, ['-e', "const i=require('node:inspector');i.open(0,'127.0.0.1'); console.log(i.url()); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const [chunk] = await once(child.stdout, 'data'), url = String(chunk).trim();
    assert.equal(await rpc(url, 'process.pid'), child.pid);
    await assert.rejects(rpc(url, '(()=>{throw Error("intentional transport fixture")})()'), /intentional transport fixture/);
    await assert.rejects(rpc('ws://example.invalid/test', '1'), /127/);
  } finally { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
});
test('native seed is readable by normal backing stores and contains real source trust to exclude', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-native-seed-')));
  try {
    const bundle = join(root, 'fixture.cjs');
    await build({ entryPoints: ['scripts/core-native/fixture.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
    const { seed } = createRequire(import.meta.url)(bundle);
    const profile = join(root, 'Profile'), workspace = join(root, 'Workspace Ω'), value = await seed(profile, workspace);
    assert.ok(value.draft && value.problem && value.attempt);
    const trust = JSON.parse(await readFile(join(profile, 'run-trust.json'), 'utf8'));
    assert.equal(trust.roots[0].path, workspace);
    assert.equal(JSON.parse(await readFile(join(profile, 'preferences.json'), 'utf8')).settings.fontSize, 19);
    assert.match(await readFile(value.source, 'utf8'), /ION_ATTEMPT_SOURCE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failure teardown removes a real owned Node process family without launching Electron', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'ion-native-cleanup-')));
  const program = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.on('spawn',()=>console.log(child.pid));setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'ignore'] });
  const done = once(child, 'exit'); let descendant;
  const session = { pid: child.pid, profile, executablePath: await realpath(process.execPath) };
  await tree(session);
  try {
    const [chunk] = await once(child.stdout, 'data'); descendant = Number(String(chunk).trim());
    const before = await tree(session);
    assert.ok(before.members.some(p => p.pid === descendant));
    await cleanupFailed(session); await done;
    assert.deepEqual((await tree(session)).members, []);
  } finally {
    await cleanupFailed(session);
    await rm(profile, { recursive: true, force: true });
  }
});
