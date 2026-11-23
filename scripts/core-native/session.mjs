import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { eventually, sleep, resourceSnapshot } from '../desktop-harness.mjs';
import { windowsProcessTree } from '../windows/process-tree.mjs';
import { familyFor, rememberLaunchMetrics } from '../process-family.mjs';
const require = createRequire(import.meta.url);
export const tree = session => process.platform === 'win32' ? windowsProcessTree(session) : resourceSnapshot(session, { details: true });
export async function events(profile) {
  const folder = join(profile, 'acceptance-events');
  const names = (await readdir(folder).catch(e => { if (e.code !== 'ENOENT') throw e; return []; })).filter(n => n.endsWith('.json')).sort();
  assert.ok(names.length <= 1000, 'Acceptance event bound exceeded');
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(folder, name), 'utf8'))));
}
export async function eventEvidence(profile) {
  try { return { profile, events: await events(profile) }; }
  catch (error) { return { profile, error: error.message, files: await readdir(join(profile, 'acceptance-events')).catch(e => ['Unreadable: ' + e.message]) }; }
}
export async function control(profile, patch) {
  const path = join(profile, 'acceptance-control.json');
  const before = JSON.parse(await readFile(path, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return '{}'; }));
  await writeFile(path, JSON.stringify({ ...before, ...patch }));
}
// One bounded inspector request per connection; never expose this in the renderer.
export async function rpc(url, expression) {
  assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\//);
  return new Promise((yes, no) => {
    const ws = new WebSocket(url); let finished = false;
    const timer = setTimeout(() => finish(Error('Acceptance inspector request timed out')), 8000);
    function finish(error, value) { if (finished) return; finished = true; clearTimeout(timer); ws.close(); error ? no(error) : yes(value); }
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })));
    ws.addEventListener('error', () => finish(Error('Acceptance inspector transport failed')), { once: true });
    ws.addEventListener('message', event => {
      const packet = JSON.parse(event.data); if (packet.id !== 1) return;
      if (packet.error || packet.result.exceptionDetails) finish(Error(JSON.stringify(packet.error ?? packet.result.exceptionDetails)));
      else finish(null, packet.result.result.value);
    });
  });
}
export async function retain(profile, start, session = {}) {
  assert.ok(start.pid > 0 && start.creationTime > 0, 'No native creation identity for the application');
  Object.assign(session, { pid: start.pid, profile, inspector: start.inspector, executablePath: await realpath(require('electron')), mainCreationTime: start.creationTime });
  rememberLaunchMetrics(session, [{ pid: start.pid, creationTime: start.creationTime }]);
  return session;
}
async function retainReceipts(session) {
  const log = await events(session.profile), start = log.find(e => e.kind === 'start' && e.pid === session.pid);
  if (start) await retain(session.profile, start, session);
  for (const record of log.filter(e => e.pid === session.pid && e.processes)) rememberLaunchMetrics(session, record.processes);
}
export async function attach(profile, previousPids = [], onOwned = () => {}, provided = {}) {
  const attachStarted = performance.now();
  const seen = new Set(previousPids); let start;
  await eventually(async () => {
    start = (await events(profile)).findLast(e => e.kind === 'start' && !seen.has(e.pid));
    return Boolean(start);
  }, 'No new application process started', 20_000);
  const session = await retain(profile, start, provided); onOwned(session);
  const startObservedAt = performance.now();
  await tree(session); // Retain early descendants before waiting for renderer readiness.
  await eventually(async () => {
    await retainReceipts(session);
    return (await events(profile)).some(e => e.kind === 'loaded' && e.pid === start.pid);
  }, 'A new production application did not load after startup/relaunch', 20_000);
  const loadObservedAt = performance.now();
  const port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const portReadAt = performance.now();
  assert.ok(Number.isInteger(port) && port > 0);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
  const cdpConnectedAt = performance.now();
  session.browser = browser;
  try {
    const context = browser.contexts()[0], page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 8000 });
    page.setDefaultTimeout(8000); await page.getByTestId('settings').first().waitFor();
    const uiReadyAt = performance.now();
    assert.equal(page.url(), 'app://workbench/index.html'); await context.setOffline(true);
    const state = await rpc(start.inspector, 'globalThis.__ionAcceptance.snapshot()');
    assert.equal(state.profile, profile); assert.equal(state.pid, start.pid);
    Object.assign(session, { browser, page, uiReadyAt, errors: [], requests: [], attachStages: {
      attachStarted, startObservedAt, loadObservedAt, portReadAt, cdpConnectedAt, uiReadyAt,
      waitForStartMs: startObservedAt - attachStarted, waitForLoadMs: loadObservedAt - startObservedAt,
      portReadMs: portReadAt - loadObservedAt, cdpConnectMs: cdpConnectedAt - portReadAt,
      settingsLocatorMs: uiReadyAt - cdpConnectedAt,
    } });
    rememberLaunchMetrics(session, state.processes);
    page.on('pageerror', e => session.errors.push(e.message));
    context.on('request', r => { if (/^(https?|wss?):/.test(r.url())) session.requests.push(r.url()); });
    await tree(session); return session;
  } catch (error) { await browser.close().catch(() => {}); throw error; }
}
export async function launch(target, profile, root, token) {
  assert.equal(process.env.CI, 'true', 'Never launch this acceptance harness on the local Mac');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use the approved isolated GitHub Actions host');
  const seen = (await events(profile)).map(e => e.pid), executablePath = await realpath(require('electron'));
  const began = performance.now();
  const env = { ...process.env, ION_CORE_ACCEPTANCE_ROOT: root, ION_CORE_ACCEPTANCE_TOKEN: token, ION_CORE_PRODUCTION_ENTRY: resolve(target, 'main/index.cjs') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ION_DEV_URL;
  const child = spawn(require('electron'), ['--remote-debugging-port=0', '--user-data-dir=' + profile, resolve('scripts/core-native/bootstrap.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const owned = { pid: child.pid, profile, executablePath, child, launchBegan: began };
  let stderr = '', spawnError;
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-8192); }); child.once('error', error => { spawnError = error; });
  try {
    if (child.pid) await tree(owned);
    const session = await attach(profile, seen, () => {}, owned);
    const startupEvents = (await events(profile)).filter(event => event.pid === session.pid);
    const event = kind => startupEvents.find(item => item.kind === kind)?.monotonicMs;
    const start = event('start'), ready = event('ready'), window = event('window'), loaded = event('loaded');
    session.startupMs = session.uiReadyAt - began;
    session.startupStages = {
      spawnToStartObservedMs: session.attachStages.startObservedAt - began,
      mainStartToReadyMs: ready - start,
      readyToWindowMs: window - ready,
      windowToLoadedMs: loaded - window,
      loadedToUiReadyObservedMs: session.uiReadyAt - session.attachStages.loadObservedAt,
      ...session.attachStages,
    };
    return session;
  } catch (error) {
    const failure = new Error('Native acceptance startup failed: ' + (spawnError?.message ?? error.message) + '\n' + stderr, { cause: error });
    try { if (child.pid) await cleanupFailed(owned); } catch (cleanup) { throw new AggregateError([failure, cleanup], 'Startup failed and owned-process cleanup is unverified'); }
    throw failure;
  }
}
export async function exited(session) {
  await eventually(async () => (await tree(session)).members.length === 0, 'Owned application processes survived shutdown', 8000);
}
export async function stop(session) {
  if ((await tree(session)).rootAlive) {
    await rpc(session.inspector, 'globalThis.__ionAcceptance.quit(); true');
    const dialog = session.page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
    await eventually(async () => (await dialog.isVisible().catch(() => false)) || !(await tree(session)).rootAlive, 'Quit did not reach confirmation or process exit', 8000);
    if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: 'Keep Drafts and Quit', exact: true }).click();
  }
  await exited(session); await session.browser.close();
  assert.deepEqual(session.errors, []); assert.deepEqual(session.requests, []);
}
export async function cleanupFailed(session) {
  if (!session) return;
  await session.browser?.close().catch(() => {});
  await retainReceipts(session);
  const live = await tree(session);
  assert.ok(familyFor(session).root, 'No verified root identity: process cleanup must remain unverified');
  for (const member of [...live.members].reverse()) {
    try { process.kill(member.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await exited(session);
}
export { sleep };
