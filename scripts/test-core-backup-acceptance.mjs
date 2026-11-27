// Actual Electron lifecycle verification. CI only; no installed app or live profile.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { editorShows, eventually } from './desktop-harness.mjs';
import { rememberLaunchMetrics } from './process-family.mjs';
import { launch, attach, retain, stop, cleanupFailed, control, events, eventEvidence, exited } from './core-native/session.mjs';
assert.equal(process.env.CI, 'true', 'Native acceptance is restricted to an approved CI host');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use the approved isolated GitHub Actions host');
const target = resolve(process.argv[2] ?? 'dist'), out = resolve('performance-results/core-native-acceptance');
const editorApiAssets = (await readdir(join(target, 'renderer/assets'))).filter(name => /^editor\.api-[^/]+\.js$/.test(name));
assert.equal(editorApiAssets.length, 1, 'Expected exactly one production editor API chunk');
const editorApiAsset = editorApiAssets[0];
const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-core-native-'))), token = randomUUID();
await writeFile(join(root, 'owner'), token, { flag: 'wx', mode: 0o600 }); await mkdir(out, { recursive: true });
const report = { schema: 1, complete: false, source: process.env.GITHUB_SHA, productionMainSha256: createHash('sha256').update(await readFile(join(target, 'main/index.cjs'))).digest('hex'), cases: [], failures: [], limitations: ['Unpackaged production files with a CI-only observer/fault-injection entry, not an installer test.'] };
const scrub = value => JSON.parse(JSON.stringify(value).split(root).join('<scratch>').replace(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/g, '<local-inspector>'));
const save = () => writeFile(join(out, 'restore-lifecycle.json'), JSON.stringify(scrub(report), null, 2));
const live = new Set(), profiles = new Set();
async function start(profile) { profiles.add(profile); const s = await launch(target, profile, root, token); live.add(s); return s; }
async function finish(s) { await stop(s); live.delete(s); }
async function settings(page, action) { await page.getByTestId('settings').first().click(); await page.getByTestId(action).click(); }
async function createBackup(s, destination) {
  await control(s.profile, { archive: destination });
  await settings(s.page, 'backup-data');
  const dialog = s.page.getByRole('dialog', { name: 'Back Up My Ion Data', exact: true });
  await dialog.getByRole('button', { name: 'Review Backup', exact: true }).click();
  const entries = await dialog.locator('.backup-files').textContent();
  assert.ok(!/planning-provider|run-trust|Login Data/.test(entries));
  await dialog.getByRole('button', { name: 'Create .ionbackup…', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: 'Backup created:' }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal((await readFile(destination)).subarray(0, 2).toString(), 'PK');
}
async function review(s, archive, map = true) {
  await control(s.profile, { archive }); await settings(s.page, 'restore-data');
  const dialog = s.page.getByRole('dialog', { name: 'Restore From Backup', exact: true });
  const checks = dialog.locator('fieldset').first().getByRole('checkbox'); await checks.first().waitFor();
  for (const check of await checks.all()) assert.equal(await check.isChecked(), false); // Keep current is the default.
  for (const check of await checks.all()) await check.check();
  if (map && await dialog.getByLabel('Relink C integer adder', { exact: true }).count()) {
    await dialog.getByRole('button', { name: 'Choose Relocated Folder…', exact: true }).click();
    const select = dialog.getByLabel('Relink C integer adder', { exact: true });
    const option = await select.locator('option').filter({ hasText: 'Workspace Ω' }).first().getAttribute('value');
    assert.ok(option); await select.selectOption(option);
  }
  await dialog.getByRole('button', { name: 'Review Restart and Rollback', exact: true }).click();
  await dialog.getByRole('button', { name: 'Continue to Safe Restart', exact: true }).waitFor();
  return dialog;
}
async function apply(s, dialog, disposition = 'keep', fault = null) {
  const seen = (await events(s.profile)).map(e => e.pid);
  await control(s.profile, { fault });
  await dialog.getByRole('button', { name: 'Continue to Safe Restart', exact: true }).click();
  if (disposition) {
    const confirmation = s.page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
    await confirmation.waitFor();
    if (disposition === 'cancel') { await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click(); return s; }
    await confirmation.getByRole('button', { name: disposition === 'save' ? 'Save All' : 'Keep Drafts and Quit', exact: true }).click();
  }
  let faultReceipt;
  if (fault?.action === 'kill') {
    await eventually(async () => { faultReceipt = (await events(s.profile)).findLast(e => e.kind === 'fault' && !seen.includes(e.pid)); return Boolean(faultReceipt); }, 'Actual startup did not reach the requested kill boundary', 20_000);
    const startReceipt = (await events(s.profile)).find(e => e.kind === 'start' && e.pid === faultReceipt.pid);
    const interrupted = await retain(s.profile, startReceipt); live.add(interrupted);
    assert.ok(faultReceipt.processes.some(p => p.pid === faultReceipt.pid && p.creationTime > 0), 'Missing identity for interrupted application');
    rememberLaunchMetrics(interrupted, faultReceipt.processes);
    await exited(interrupted); live.delete(interrupted);
    report.cases.push({ name: 'actual-startup-kill', receipt: faultReceipt });
    const resumed = await start(s.profile); await exited(s); live.delete(s); await s.browser.close(); return resumed;
  }
  const next = await attach(s.profile, seen, next => live.add(next));
  assert.notEqual(next.pid, s.pid, 'Restore did not create a new real application process');
  await exited(s); live.delete(s); await s.browser.close();
  return next;
}
async function saveAndRequireRenewedReview(s, dialog) {
  const before = (await events(s.profile)).filter(event => event.kind === 'start').map(event => event.pid);
  await dialog.getByRole('button', { name: 'Continue to Safe Restart', exact: true }).click();
  const confirmation = s.page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: 'Save All', exact: true }).click();
  await eventually(async () => (await events(s.profile)).some(event => event.kind === 'native-message' && event.message === 'Restore was not applied'),
    'A save after restore review did not reject the stale restore confirmation', 20_000);
  const context = s.browser.contexts()[0]; let page;
  await eventually(async () => {
    page = context.pages().find(candidate => !candidate.isClosed() && candidate.url() === 'app://workbench/index.html');
    return Boolean(page && await page.getByTestId('settings').first().isVisible().catch(() => false));
  }, 'The original application did not recover after rejecting stale restore confirmation', 20_000);
  page.setDefaultTimeout(8_000); page.on('pageerror', error => s.errors.push(error.message)); s.page = page;
  const after = (await events(s.profile)).filter(event => event.kind === 'start').map(event => event.pid);
  assert.deepEqual(after, before, 'Rejecting stale restore confirmation unexpectedly started another application');
  report.cases.push({ name: 'Save requires renewed restore review', passed: true });
  return s;
}
async function edit(page, marker) {
  await page.getByTestId('open-file').first().click(); await editorShows(page, '#include');
  // insertText may split a multiline CDP replacement into many native edits.
  // Define one edit deliberately; this fixture tests preservation across backup,
  // rather than assuming a particular browser input/Undo grouping policy.
  await page.evaluate(async ({ text, asset }) => {
    const url = new URL(`assets/${asset}`, document.baseURI).href;
    const { editor } = await import(url), widget = editor.getEditors().find(e => e.getDomNode()?.closest('[data-testid="editor"]'));
    if (!widget?.getModel()) throw new Error('The active Monaco editor model is unavailable');
    widget.pushUndoStop(); widget.executeEdits('core-acceptance', [{ range: widget.getModel().getFullModelRange(), text }]); widget.pushUndoStop(); widget.focus();
  }, { text: '/* ' + marker + ' */\nint main(void) { return 0; }\n', asset: editorApiAsset });
  await editorShows(page, marker);
}
async function editorState(page) {
  return page.evaluate(async asset => {
    const url = new URL(`assets/${asset}`, document.baseURI).href;
    const { editor } = await import(url), widget = editor.getEditors().find(e => e.getDomNode()?.closest('[data-testid="editor"]'));
    if (!widget?.getModel()) throw new Error('The active Monaco editor model is unavailable');
    const model = widget.getModel();
    return { text: widget.getValue().slice(0, 8192), model: model.id, uri: String(model.uri), canUndo: model.canUndo(), canRedo: model.canRedo() };
  }, editorApiAsset);
}
async function verify(s, f, workspace, currentDraft = null, explicitlySaved = false) {
  const result = await s.page.evaluate(async ({ f, currentDraft }) => {
    const prefs = await window.ion.getPreferences(), lesson = await window.ion.learningPacks.getLesson('acceptance-notes', 'branches');
    const problem = await window.ion.practice.get(f.problem), attempt = await window.ion.practice.openAttempt(f.problem, f.attempt);
    const text = await window.ion.readFile(attempt.path), drafts = await window.ion.recovery.list();
    const contents = await Promise.all(drafts.map(async d => ({ ...d, text: await window.ion.recovery.read(d.id) })));
    const theme = await window.ion.themes.load(f.theme), history = await window.ion.learning.getHistory();
    const folder = await window.ion.openFolder();
    const project = await window.ion.projects.open(folder.path);
    return { prefs, lesson, problem, text, contents, theme, history, project, currentDraft };
  }, { f, currentDraft });
  assert.equal(result.prefs.settings.fontSize, 19); assert.deepEqual(result.prefs.settings.smartLanguages, []);
  assert.equal(result.lesson.explanation, 'ION_OFFLINE_LESSON'); assert.equal(result.problem.notes, 'ION_PERSONAL_NOTES');
  assert.match(result.text.text, /ION_ATTEMPT_SOURCE/); assert.equal(result.problem.attempts[0].lastRun.current, false);
  assert.equal(result.theme.id, f.theme); assert.ok(JSON.stringify(result.history).includes('arrays'));
  assert.deepEqual(result.project.approved, []); assert.deepEqual(result.project.automatic, []);
  assert.equal(result.project.spec.milestones[0].status, 'in-progress');
  assert.ok(result.project.evidence.some(e => e.stale && e.restored && e.message === 'ION_HISTORICAL_TEST'));
  const run = await s.page.evaluate(async path => {
    const file = await window.ion.readFile(path);
    return window.ion.runConsole.start(crypto.randomUUID(), path, false, file.revision);
  }, join(workspace, 'main.c'));
  assert.notEqual(run.status, 'success', 'Restored history unexpectedly authorized execution');
  assert.ok((await events(s.profile)).some(e => e.kind === 'native-message' && e.buttons?.includes('Run Program')), 'A fresh run approval was not requested');
  const imported = result.contents.filter(d => /ION_ARCHIVED_DRAFT|ION_UNSAVED_EDITOR/.test(d.text));
  assert.ok(imported.length >= 2); assert.ok(imported.every(d => d.originalPath === undefined && d.id !== f.draft));
  if (currentDraft) assert.equal(result.contents.find(d => d.id === currentDraft).text, 'ION_CURRENT_DRAFT');
  await s.page.getByTestId('recover-edits').click();
  await s.page.getByRole('dialog', { name: 'Recover unsaved edits', exact: true }).getByRole('button', { name: 'Restore Drafts', exact: true }).click();
  await eventually(() => s.page.getByTestId('tab').count().then(n => n >= imported.length), 'Restored drafts did not open as editor tabs');
  assert.equal(await readFile(join(workspace, 'main.c'), 'utf8'), explicitlySaved ? '/* ION_EXPLICIT_SAVE */\nint main(void) { return 0; }\n' : '#include <stdio.h>\nint main(void) { return 0; }\n', 'Source differs from the explicit save policy');
  assert.ok(!(await readdir(s.profile)).some(n => n.startsWith('.ion-backup-stage-') || n === 'ion-pending-restore.json'));
}
try {
  const bundle = join(root, 'fixture.cjs');
  await build({ entryPoints: ['scripts/core-native/fixture.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
  const { seed } = createRequire(import.meta.url)(bundle);
  const workspace = join(root, 'Workspace Ω'), source = join(root, 'Source'), archive = join(root, 'Study.ionbackup');
  const f = await seed(source, workspace); await control(source, { workspace, archive });
  const origin = await start(source); await edit(origin.page, 'ION_UNSAVED_EDITOR'); await createBackup(origin, archive);
  report.cases.push({ name: 'Settings backup with real unsaved editor content', passed: true });
  report.editorUndo = { before: await editorState(origin.page) }; await save();
  await origin.page.locator('.monaco-editor .view-line').first().click();
  await origin.page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  report.editorUndo.after = await editorState(origin.page); await save(); await editorShows(origin.page, '#include');
  report.editorUndo.settled = await editorState(origin.page);
  assert.equal(report.editorUndo.settled.model, report.editorUndo.before.model, 'Backup replaced the editor model');
  assert.equal(report.editorUndo.settled.text, '#include <stdio.h>\nint main(void) { return 0; }\n');
  await origin.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y'); await editorShows(origin.page, 'ION_UNSAVED_EDITOR');
  await finish(origin); report.cases.push({ name: 'Undo and Redo preserved across backup', passed: true }); await save();
  for (const scenario of ['fresh', 'populated', 'previous-moved', 'published', 'rollback', 'save']) {
    const profile = join(root, scenario); await mkdir(profile);
    const prior = scenario === 'rollback' ? await seed(profile, workspace) : null;
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { fontSize: 12, autoSave: false }, recents: [] }));
    await control(profile, { workspace, archive });
    let s = await start(profile), currentDraft = null;
    if (scenario === 'populated') {
      currentDraft = f.draft; await s.page.evaluate(id => window.ion.recovery.write({ id, name: 'Current.txt', text: 'ION_CURRENT_DRAFT' }), currentDraft);
      await edit(s.page, 'ION_CURRENT_UNSAVED');
      const beforeCancel = s.pid; s = await apply(s, await review(s, archive), 'cancel');
      assert.equal(s.pid, beforeCancel); assert.equal((await s.page.evaluate(() => window.ion.getPreferences())).settings.fontSize, 12);
      report.cases.push({ name: 'Cancel preserves running app and current edits', passed: true });
    }
    if (scenario === 'save') await edit(s.page, 'ION_EXPLICIT_SAVE');
    const fault = scenario === 'rollback' ? { boundary: 'published', action: 'throw' } :
      ['previous-moved', 'published'].includes(scenario) ? { boundary: scenario, action: 'kill' } : null;
    let dialog = await review(s, archive);
    if (scenario === 'save') {
      s = await saveAndRequireRenewedReview(s, dialog);
      assert.equal(await readFile(join(workspace, 'main.c'), 'utf8'), '/* ION_EXPLICIT_SAVE */\nint main(void) { return 0; }\n');
      dialog = await review(s, archive);
    }
    s = await apply(s, dialog, scenario === 'populated' ? 'keep' : null, fault);
    if (scenario === 'rollback') {
      assert.equal((await s.page.evaluate(() => window.ion.getPreferences())).settings.fontSize, 12);
      assert.ok((await events(profile)).some(e => e.kind === 'fault' && e.action === 'throw'));
      assert.ok(!(await readdir(profile)).includes('ion-pending-restore.json'));
      assert.equal((await s.page.evaluate(id => window.ion.practice.get(id), prior.problem)).notes, 'ION_PERSONAL_NOTES');
      assert.equal(await s.page.evaluate(id => window.ion.practice.get(id).then(() => true, () => false), f.problem), false, 'Rollback left incoming practice data active');
      assert.equal((await s.page.evaluate(id => window.ion.themes.load(id), prior.theme)).id, prior.theme);
      assert.equal(await s.page.evaluate(id => window.ion.recovery.read(id), prior.draft), 'ION_ARCHIVED_DRAFT');
    } else {
      await verify(s, f, workspace, currentDraft, scenario === 'save');
      for (const name of ['planning-provider-v1.json', 'run-trust.json', 'Login Data']) {
        await assert.rejects(readFile(join(profile, name)), { code: 'ENOENT' });
      }
    }
    const backups = (await readdir(join(profile, '.ion-backups'))).filter(n => n.endsWith('.ionbackup'));
    assert.ok(backups.length > 0, 'Verified pre-restore archive was not retained');
    // Reopen the real rollback archive through the normal validated bridge.
    await control(profile, { archive: join(profile, '.ion-backups', backups[0]) });
    const rollback = await s.page.evaluate(() => window.ion.backup.openRestore()); assert.equal(rollback.kind, 'restore');
    await s.page.evaluate(() => window.ion.backup.cancel());
    report.cases.push({ name: scenario, newPid: s.pid, normalInterfaces: scenario !== 'rollback', rollbackArchiveValidated: true, events: await events(profile) });
    await finish(s); await save();
  }
  report.complete = true;
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack }); throw error;
} finally {
  const cleanupErrors = [];
  for (const s of live) { try { await cleanupFailed(s); } catch (e) { cleanupErrors.push(e.message); } }
  report.observations = await Promise.all([...profiles].map(eventEvidence));
  if (report.observations.some(o => o.error)) { report.complete = false; cleanupErrors.push('Application receipt corruption; file inventory retained'); }
  if (cleanupErrors.length) report.failures.push({ cleanupErrors });
  await save();
  if (!report.complete || cleanupErrors.length) console.error('Native acceptance failed; partial evidence retained.');
  if (report.complete && !cleanupErrors.length) await rm(root, { recursive: true, force: true });
  if (cleanupErrors.length) throw Error('Native acceptance process cleanup failed');
}
