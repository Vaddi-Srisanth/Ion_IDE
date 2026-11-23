import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { launch, stop, cleanupFailed, control, rpc, tree, sleep, eventEvidence } from './core-native/session.mjs';
import { median } from './benchmark-resource-metrics.mjs';
import { identityCpuPercent } from './process-family.mjs';
assert.equal(process.env.CI, 'true', 'Native metrics are restricted to an approved CI host');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use the approved isolated GitHub Actions host');
const execute = promisify(execFile), baseline = resolve(process.argv[2]), candidate = resolve(process.argv[3] ?? 'dist');
const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-core-metrics-'))), token = randomUUID();
await writeFile(join(root, 'owner'), token, { flag: 'wx', mode: 0o600 });
const out = resolve('performance-results/core-native-acceptance/paired-resources.json');
const report = { complete: false, source: process.env.GITHUB_SHA, baseline: 'd67613a1e9b77c7d677bd304628d57c58542fa71',
  host: { platform: process.platform, release: release(), arch: process.arch, cpu: cpus()[0]?.model, logicalCores: cpus().length, ramBytes: totalmem() },
  protocol: { pairs: 4, ordering: 'AB/BA alternating; serialized', settleMs: 2000, idleMs: 10000, intervalMs: 2000,
    startup: 'Spawn to visible Settings control after production page/CDP attach. Fresh process then same-profile warm launch; OS caches untouched.',
    resources: 'Same visible CI desktop and window configuration. One 80-line C file; no compiler, terminal or learning panels. CPU is percent of one core.',
    memory: 'Full identity-owned family. Sum of RSS/working sets may count shared pages repeatedly. Mac footprint ledger charges and Windows private bytes are distinct.',
    observer: 'Identical CI-only observer entry for both builds; timing includes transport attachment. Not installer or physical 8 GB hardware evidence.' },
  artifacts: {}, attempts: [] };
const save = () => writeFile(out, JSON.stringify(report, null, 2));
await mkdir(resolve('performance-results/core-native-acceptance'), { recursive: true });
for (const [name, dir] of [['baseline', baseline], ['candidate', candidate]]) report.artifacts[name] = createHash('sha256').update(await readFile(join(dir, 'main/index.cjs'))).digest('hex');
const probe = join(root, 'rusage');
if (process.platform === 'darwin') await execute('/usr/bin/clang', ['-O2', '-std=c11', 'scripts/benchmark-resources-probe.c', '-o', probe]);
let current;
async function sample(s, destination) {
  const before = await tree(s), record = { ...before }; destination.push(record);
  assert.ok(before.rootAlive && before.members.length, 'Cannot measure an exited application as zero RAM');
  if (process.platform === 'win32') return Object.assign(record, { cpuSecondsByIdentity: Object.fromEntries(before.members.map(p => [p.pid + ':' + p.started, p.cpuSeconds])) });
  let stdout;
  try { ({ stdout } = await execute(probe, before.members.map(p => String(p.pid)), { timeout: 8000, maxBuffer: 65536 })); }
  catch (error) { record.probeFailure = { message: error.message, code: error.code, stdout: error.stdout, stderr: error.stderr }; throw error; }
  const data = new Map(stdout.trim().split('\n').map(row => { const [pid, footprint, cpuNs] = row.split(' ').map(Number); return [pid, { footprint, cpuNs }]; }));
  const after = await tree(s), identities = new Map(after.members.map(p => [p.pid, p.started]));
  record.nativeProbe = [...data]; record.identityAfter = after;
  assert.ok(before.members.length === after.members.length && before.members.every(p => identities.get(p.pid) === p.started && data.has(p.pid)), 'Native probe process identity changed; failed native rows retained');
  return Object.assign(record, { footprintMiB: before.members.reduce((n, p) => n + data.get(p.pid).footprint / 1024 ** 2, 0),
    cpuSecondsByIdentity: Object.fromEntries(before.members.map(p => [p.pid + ':' + p.started, data.get(p.pid).cpuNs / 1e9])) });
}
async function phase(s, attempt, key) {
  const result = { status: 'running', samples: [] }; attempt.phases[key] = result; await save();
  await sleep(2000); const diagnosticBefore = await rpc(s.inspector, 'globalThis.__ionAcceptance.snapshot()');
  const samples = result.samples; await sample(s, samples); await save();
  for (let i = 0; i < 5; i++) { await sleep(2000); await sample(s, samples); await save(); }
  const diagnosticAfter = await rpc(s.inspector, 'globalThis.__ionAcceptance.snapshot()');
  const cpuPercentOneCore = identityCpuPercent(samples[0], samples.at(-1));
  const memory = {};
  for (const field of ['rssMiB', 'footprintMiB', 'workingSetMiB', 'privateMiB']) if (samples.every(s => Number.isFinite(s[field]))) {
    memory[field] = { median: median(samples.map(s => s[field])), peak: Math.max(...samples.map(s => s[field])) };
  }
  return Object.assign(result, { status: 'passed', memory, cpuPercentOneCore, cpuUnavailable: cpuPercentOneCore === null ? 'Process-family identity membership changed; raw samples retained' : null,
    diagnostics: { before: diagnosticBefore, after: diagnosticAfter } });
}
try {
  for (let pair = 0; pair < 4; pair++) for (const label of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const attempt = { pair, label, status: 'running', phases: {} }; report.attempts.push(attempt); await save();
    const profile = join(root, `${pair}-${label}`), workspace = join(root, `${pair}-${label}-source`);
    await mkdir(profile); await mkdir(workspace);
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false, resourceProfile: 'minimal' }, recents: [] }));
    await writeFile(join(workspace, 'main.c'), '#include <stdio.h>\nint main(void) { return 0; }\n' + '/* fixed source line */\n'.repeat(77));
    await control(profile, { workspace, archive: join(root, 'unused.ionbackup') });
    const target = label === 'baseline' ? baseline : candidate;
    const editorApiAssets = (await readdir(join(target, 'renderer/assets'))).filter(name => /^editor\.api-[^/]+\.js$/.test(name));
    assert.equal(editorApiAssets.length, 1, `Expected exactly one ${label} editor API chunk`);
    const editorApiAsset = editorApiAssets[0];
    current = await launch(target, profile, root, token); attempt.processColdStartupMs = current.startupMs;
    attempt.coldStartupStages = current.startupStages;
    attempt.coldStartupTrace = (await rpc(current.inspector, 'globalThis.__ionAcceptance.snapshot()')).trace;
    await stop(current); current = await launch(target, profile, root, token); attempt.warmStartupMs = current.startupMs;
    attempt.warmStartupStages = current.startupStages;
    const s = current, page = s.page;
    await rpc(s.inspector, 'globalThis.__ionAcceptance.resetTrace(); true');
    await page.evaluate(() => {
      const started = performance.now(), state = { started, tabCommitMs: null, monacoMountedMs: null, sourceVisibleMs: null,
        firstAnimationFrameMs: null, secondAnimationFrameMs: null, forcedLayoutMs: null, longTasks: [], resources: [] };
      globalThis.__ionFirstFileTrace = state;
      const inspect = () => {
        const now = performance.now();
        if (state.tabCommitMs === null && document.querySelector('[data-testid="editor"]')) state.tabCommitMs = now - started;
        if (state.monacoMountedMs === null && document.querySelector('.monaco-editor')) state.monacoMountedMs = now - started;
        const lines = document.querySelector('.monaco-editor .view-lines');
        if (state.sourceVisibleMs === null && lines?.textContent?.includes('#include')) {
          state.sourceVisibleMs = now - started;
          const layoutStarted = performance.now(); lines.getBoundingClientRect(); state.forcedLayoutMs = performance.now() - layoutStarted;
          requestAnimationFrame(() => { state.firstAnimationFrameMs = performance.now() - started;
            requestAnimationFrame(() => { state.secondAnimationFrameMs = performance.now() - started; }); });
        }
      };
      const observer = new MutationObserver(inspect); observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      globalThis.__ionFirstFileStop = () => { observer.disconnect();
        state.resources = performance.getEntriesByType('resource').filter(entry => entry.startTime >= started)
          .map(entry => ({ name: entry.name.split('/').at(-1)?.split('?')[0] ?? 'unknown', startTime: entry.startTime - started,
            duration: entry.duration, responseEnd: entry.responseEnd - started, transferSize: entry.transferSize })); };
      let longTaskObserver;
      try { longTaskObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) state.longTasks.push({ startTime: entry.startTime - started, duration: entry.duration }); });
        longTaskObserver.observe({ type: 'longtask', buffered: true }); } catch {}
      const stop = globalThis.__ionFirstFileStop;
      globalThis.__ionFirstFileStop = () => { stop(); longTaskObserver?.disconnect(); };
      inspect();
    });
    let began = performance.now();
    await page.getByTestId('open-file').first().click(); await page.locator('.monaco-editor .view-lines').getByText('#include', { exact: false }).waitFor();
    attempt.fileOpenMs = performance.now() - began;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    attempt.firstFileRendererTrace = await page.evaluate(() => { globalThis.__ionFirstFileStop(); return globalThis.__ionFirstFileTrace; });
    attempt.firstFileMainTrace = (await rpc(s.inspector, 'globalThis.__ionAcceptance.snapshot()')).trace;
    await page.evaluate(async asset => {
      const url = new URL(`assets/${asset}`, document.baseURI).href;
      const { editor } = await import(url), widget = editor.getEditors().find(e => e.getDomNode()?.closest('[data-testid="editor"]'));
      if (!widget?.getModel()) throw new Error('The active Monaco editor model is unavailable');
      globalThis.__coreEditor = { editor, widget, model: widget.getModel(), value: widget.getValue(), models: editor.getModels().length };
    }, editorApiAsset);
    await phase(s, attempt, 'oneFileClosed');
    assert.equal(attempt.phases.oneFileClosed.diagnostics.after.backupLoaded, false, 'Unused backup code was eagerly loaded');
    began = performance.now(); await page.getByTestId('settings').first().click();
    await page.getByRole('dialog', { name: 'Preferences', exact: true }).waitFor();
    attempt.settingsOpenMs = performance.now() - began; await phase(s, attempt, 'settingsOpen');
    await page.getByRole('dialog', { name: 'Preferences', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
    await phase(s, attempt, 'settingsClosed');
    if (label === 'candidate') {
      await page.getByTestId('settings').first().click(); began = performance.now(); await page.getByTestId('backup-data').click();
      const dialog = page.getByRole('dialog', { name: 'Back Up My Ion Data', exact: true });
      await dialog.getByRole('button', { name: 'Review Backup', exact: true }).waitFor();
      attempt.backupOpenMs = performance.now() - began; await phase(s, attempt, 'backupOpen');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      for (let i = 0; i < 10; i++) {
        await page.getByTestId('settings').first().click(); await page.getByTestId('backup-data').click();
        await dialog.getByRole('button', { name: 'Review Backup', exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      }
      await phase(s, attempt, 'backupClosed');
      const { before, after } = attempt.phases.backupClosed.diagnostics;
      assert.equal(after.calls, before.calls, 'Closed backup dialog continued invoking backend');
      assert.equal(after.storage, before.storage, 'Closed backup dialog continued filesystem operations');
      assert.ok(!(await readdir(profile)).some(name => name.startsWith('.ion-backup-stage-') || name === 'ion-pending-restore.json'));
    }
    assert.equal(await page.evaluate(() => {
      const state = globalThis.__coreEditor;
      return state.widget.getModel() === state.model && state.widget.getValue() === state.value && state.editor.getModels().length === state.models;
    }), true, 'Panel operations changed the editor/model or created extra models');
    await stop(s); current = null; attempt.cleanup = 'owned family empty'; attempt.status = 'passed'; await save();
  }
  report.complete = true;
} catch (error) {
  const attempt = report.attempts.at(-1); if (attempt) { attempt.status = 'failed'; attempt.failure = error.message; }
  throw error;
} finally {
  let cleanupError;
  try { if (current) await cleanupFailed(current); } catch (error) { cleanupError = error; report.cleanupFailure = error.message; report.complete = false; }
  finally {
    if (current) report.finalEvents = await eventEvidence(current.profile);
    await save();
  }
  if (cleanupError) throw cleanupError; // Preserve owned staging if cleanup is unverified.
  try { await rm(root, { recursive: true, force: true }); }
  catch (error) { report.cleanupFailure = error.message; report.complete = false; await save(); throw error; }
}
