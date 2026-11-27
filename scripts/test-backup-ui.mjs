// Headless Chrome + the production renderer; explicit fixture bridge, not native IPC proof.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, resolve, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';
import { browserFixtureData, installBrowserFixture } from './next-generation-browser-fixture.mjs';
const target = await realpath(process.argv[2] ?? 'dist/renderer');
const out = resolve('performance-results/core-backup-ui'); await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (name === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = await realpath(join(target, name === '/' ? 'index.html' : name));
    const path = relative(target, file); if (path.startsWith('..') || isAbsolute(path)) throw new Error('Unsafe static path.');
    const data = await readFile(file); if (data.length > 32 * 1024 ** 2) throw new Error('Asset too large.');
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' })[extname(file)] ?? 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(yes => server.listen(0, '127.0.0.1', yes));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const result = { kind: 'production-renderer / fixture bridge only', scenarios: [] };
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const errors = [], requests = [];
    await context.addInitScript(installBrowserFixture, await browserFixtureData(theme));
    await context.addInitScript(() => {
      const subscribers = new Set(), calls = [];
      const cPath = '/ion-browser-fixture/undo.c', originalRead = window.ion.readFile;
      window.ion.openFile = async () => ({ kind: 'file', name: 'undo.c', path: cPath });
      window.ion.readFile = async path => path === cPath ? { text: '#include <stdio.h>\nint main(void) { return 0; }\n', revision: 'c-fixture-r1' } : originalRead(path);
      const review = { token: 'review', kind: 'backup', expiresAt: Date.now() + 600000, name: 'Synthetic UI fixture', files: 1, bytes: 128,
        categories: [{ id: 'preferences', files: 1, bytes: 128, present: true, conflict: true }], folders: [], exclusions: [{ name: 'Credentials', reason: 'Excluded' }], exclusionsOmitted: 0,
        entries: [{ path: 'profile/preferences.json', bytes: 128 }], projects: [], legacy: false, warnings: ['UI fixture only. No real files are written.'] };
      const call = name => calls.push(name);
      window.ion.backup = {
        folders: async () => { call('folders'); return [{ id: 'folder', name: 'Coursework', mode: 'reference' }]; },
        chooseFolder: async () => { call('choose'); return null; },
        review: async scope => { call('review'); window.__backupScope = scope; return structuredClone(review); },
        create: async token => { call('create'); if (token !== 'review') throw new Error('Wrong token'); return '/disposable/fixture.ionbackup'; },
        openRestore: async legacy => { call('openRestore'); return { ...structuredClone(review), kind: 'restore', legacy: Boolean(legacy) }; },
        prepareRestore: async (token, choices) => { call('prepareRestore'); window.__restoreChoices = choices; return { token: 'prepared', rollback: '/disposable/rollback.ionbackup' }; },
        applyRestore: async () => { call('applyRestore'); },
        cancel: async () => { call('cancel'); },
        onProgress: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
      };
      window.__inspectBackup = () => ({ calls: [...calls], listeners: subscribers.size });
    });
    await context.route('**/*', route => { const url = route.request().url(); if (url.startsWith(origin + '/') || /^(data|blob):/.test(url)) return route.continue(); errors.push('Remote request blocked'); return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); page.on('request', req => requests.push(req.url()));
    await page.goto(origin); await page.getByTestId('settings').first().waitFor();
    assert.equal((await page.evaluate(() => window.__inspectBackup())).calls.length, 0, 'Closed backup UI initialized backend');
    assert.equal(requests.some(r => /BackupDialog-/.test(r)), false, 'Backup UI was eagerly loaded');
    await page.evaluate(() => window.__ionBrowserFixture.command('open-file'));
    await page.locator('.monaco-editor .view-lines').getByText('#include', { exact: false }).waitFor();
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map(e => e.name).find(name => /\/editor\.api-[^/]+\.js$/.test(name));
      const { editor } = await import(url), widget = editor.getEditors().find(e => e.getDomNode()?.closest('[data-testid="editor"]'));
      window.__backupEditor = widget; window.__backupModel = widget.getModel(); window.__backupOriginal = widget.getValue();
      widget.setPosition({ lineNumber: 1, column: 999 }); widget.pushUndoStop();
      widget.trigger('clipboard', 'paste', { text: ' /* BACKUP_UNDO_FIXTURE */', pasteOnNewLine: false, multicursorText: null }); widget.pushUndoStop();
    });
    await page.getByTestId('settings').first().click(); await page.getByTestId('backup-data').click();
    const backup = page.getByRole('dialog', { name: 'Back Up My Ion Data' }); await backup.waitFor();
    await backup.getByRole('button', { name: 'Review Backup', exact: true }).click();
    await backup.getByRole('button', { name: 'Create .ionbackup…' }).waitFor();
    assert.equal(await page.evaluate(() => window.__backupScope.folders[0].mode), 'reference');
    await page.screenshot({ path: join(out, theme + '-review.png') });
    await backup.getByRole('button', { name: 'Create .ionbackup…' }).click(); await backup.getByRole('status').filter({ hasText: 'Backup created:' }).waitFor();
    await backup.getByRole('button', { name: 'Close', exact: true }).click(); await backup.waitFor({ state: 'detached' });
    assert.equal((await page.evaluate(() => window.__inspectBackup())).listeners, 0);
    assert.equal(await page.evaluate(() => {
      const widget = window.__backupEditor;
      if (widget.getModel() !== window.__backupModel || !widget.getValue().includes('BACKUP_UNDO_FIXTURE')) return false;
      widget.focus(); widget.trigger('keyboard', 'undo', null);
      return widget.getValue() === window.__backupOriginal && widget.getModel() === window.__backupModel;
    }), true, 'Backup dialog changed the C editor model or destroyed block-comment Undo');
    await page.getByTestId('settings').first().click(); await page.getByTestId('restore-data').click();
    const restore = page.getByRole('dialog', { name: 'Restore From Backup' }); await restore.getByRole('checkbox').waitFor();
    assert.equal(await restore.getByRole('checkbox').isChecked(), false);
    assert.equal(await restore.getByRole('button', { name: 'Review Restart and Rollback' }).isDisabled(), true);
    await restore.getByRole('checkbox').check(); await restore.getByRole('button', { name: 'Review Restart and Rollback' }).click();
    await restore.getByRole('button', { name: 'Continue to Safe Restart' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__restoreChoices.replace), ['preferences']);
    await page.screenshot({ path: join(out, theme + '-restore.png') });
    await restore.getByRole('button', { name: 'Close', exact: true }).click(); await restore.waitFor({ state: 'detached' });
    for (let i = 0; i < 10; i++) {
      await page.getByTestId('settings').first().click(); await page.getByTestId('backup-data').click();
      await backup.getByRole('button', { name: 'Review Backup', exact: true }).waitFor();
      await backup.getByRole('button', { name: 'Close', exact: true }).click(); await backup.waitFor({ state: 'detached' });
    }
    assert.equal((await page.evaluate(() => window.__inspectBackup())).listeners, 0);
    const before = (await page.evaluate(() => window.__inspectBackup())).calls.length;
    await page.waitForTimeout(1000);
    assert.equal((await page.evaluate(() => window.__inspectBackup())).calls.length, before, 'Closed UI kept calling backup backend');
    assert.deepEqual(errors, []); result.scenarios.push({ theme, cycles: 10, errors, listenersAfterClose: 0, noClosedBackgroundCalls: true, cBlockCommentUndoPreserved: true, editorModelPreserved: true });
    await context.close();
  }
  await writeFile(join(out, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); await new Promise(yes => server.close(yes)); }
