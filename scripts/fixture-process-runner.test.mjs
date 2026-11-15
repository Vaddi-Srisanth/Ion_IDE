import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fixtureCommandDeadlineMs, fixtureRunnerProtocol, runFixtureCommand } from './fixture-process-runner.mjs'
import { developmentFixture, git } from './development-workflow-fixtures.mjs'

async function scratch(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-fixture-owner-')))
  try { await run(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

test('fixture protocol retains command deadlines, closes stdin and preserves bounded separate output', () => scratch(async root => {
  assert.equal(fixtureRunnerProtocol, 'ion-fixture-process-v2-owned')
  assert.equal(fixtureCommandDeadlineMs, process.platform === 'win32' ? 30000 : 10000)
  const result = await runFixtureCommand(process.execPath, ['-e',
    'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("EOF");process.stderr.write("diagnostic")})'], { cwd: root })
  assert.equal(result.stdout, 'EOF')
  assert.equal(result.stderr, 'diagnostic')
  assert.equal(result.evidence.cleanupVerified, true)
  await assert.rejects(runFixtureCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], {
    cwd: root, outputBytes: 1024,
  }), error => error.code === 'output-limit' && Buffer.byteLength(error.stdout + error.stderr) <= 1024)
  await assert.rejects(runFixtureCommand(process.execPath, [], { cwd: root, timeoutMs: fixtureCommandDeadlineMs + 1 }), /Invalid bounded/)
}))

test('fixture timeout owns wrapper and grandchild cleanup before removing their working directory', { timeout: 15000 }, () => scratch(async root => {
  const marker = join(root, 'pids.json')
  const wrapper = join(root, 'wrapper.cjs')
  await writeFile(wrapper, `const fs=require('node:fs'),{spawn}=require('node:child_process');
const worker=spawn(process.execPath,['-e','require("node:fs").openSync("held.txt","w");setInterval(()=>{},1000)'],
  {cwd:${JSON.stringify(root)},stdio:'ignore',windowsHide:true,detached:process.platform==='win32'});
worker.once('spawn',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({wrapper:process.pid,worker:worker.pid})));
setInterval(()=>{},1000);`)
  // Reproduce the old direct-child-only timeout inside an owning outer runner,
  // so the control's intentionally surviving grandchild cannot escape the test.
  const oldTimeout = `const fs=require('node:fs'),{execFile}=require('node:child_process');
execFile(process.execPath,[${JSON.stringify(wrapper)}],{timeout:1800,windowsHide:true},error=>{
  const pids=JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8'));
  let workerAlive=false;try{process.kill(pids.worker,0);workerAlive=true}catch{}
  process.stdout.write(JSON.stringify({killed:error?.killed,workerAlive,pids}));
});`
  const control = await runFixtureCommand(process.execPath, ['-e', oldTimeout], { cwd: root, timeoutMs: 5000 })
  const oldResult = JSON.parse(control.stdout)
  assert.equal(oldResult.killed, true)
  assert.equal(oldResult.workerAlive, true, 'The original execFile timeout leaves the spawned grandchild running.')
  const controlDrained = Date.now() + 2500
  while (alive(oldResult.pids.worker) && Date.now() < controlDrained) await delay(20)
  assert.equal(alive(oldResult.pids.worker), false, 'The outer owner must reclaim the unsafe control before continuing.')
  await rm(marker)
  let failure
  const running = runFixtureCommand(process.execPath, [wrapper], { cwd: root, timeoutMs: 1800 })
    .catch(error => { failure = error })
  const limit = Date.now() + 3000
  let pids
  while (!pids && Date.now() < limit) {
    pids = await readFile(marker, 'utf8').then(JSON.parse, () => undefined)
    if (!pids) await delay(10)
  }
  await running
  assert.ok(pids, 'The deterministic wrapper started its descendant before timeout.')
  assert.equal(failure?.code, 'timeout')
  assert.equal(failure.fixtureCommand.cleanupVerified, true)
  const drained = Date.now() + 2500
  while ((alive(pids.wrapper) || alive(pids.worker)) && Date.now() < drained) await delay(20)
  assert.equal(alive(pids.wrapper), false)
  assert.equal(alive(pids.worker), false)
  await rm(root, { recursive: true })
}))

test('real Git fixture setup retains tracked changes, rename and literal Unicode paths', () => scratch(async root => {
  const project = await developmentFixture(join(root, 'repo café'), { medium: true })
  assert.ok((await git(project.directory, 'ls-files')).split('\n').filter(Boolean).length >= 1000)
  const status = await git(project.directory, 'status', '--porcelain=v2', '-z')
  assert.ok(status.includes('edited résumé.txt'))
  assert.ok(status.includes('deleted.txt'))
  assert.ok(status.includes('new name.txt'))
  assert.ok(status.includes('new ñote.txt'))
  assert.equal(await git(project.directory, 'show', 'HEAD:edited résumé.txt'), project.original)
  await assert.rejects(git(project.directory, 'definitely-not-a-real-command'), error =>
    error.code === 'exited' && error.fixtureCommand.exitCode !== 0 && error.fixtureCommand.cleanupVerified
      && error.stderr.includes('is not a git command'))
}))
