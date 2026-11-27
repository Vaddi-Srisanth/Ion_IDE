// Focused native transport check for an explicitly authorized, disposable CI host.
// Do not launch locally while the macOS registration incident remains unresolved.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { artifact, close, createProject, launch, openFolder, stubDialogs, withScratch } from './desktop-harness.mjs';
if (process.env.CI !== 'true') throw new Error('Native backup verification is CI-only while local Electron launches are restricted.');
await withScratch('backup-bridge', async scratch => {
  const profile = join(scratch, 'Disposable profile'), output = join(scratch, 'Synthetic.ionbackup'); await mkdir(profile);
  const project = await createProject(join(scratch, 'Unicode coursework Ω'));
  const session = await launch(await artifact('dist'), profile), draftId = randomUUID();
  try {
    const { app, page } = session; await page.context().setOffline(true); await stubDialogs(app, { folder: project.directory }); await openFolder(page, project);
    await page.evaluate(async id => {
      await window.ion.updateSettings({ fontSize: 19 });
      await window.ion.recovery.write({ id, name: 'Unsaved.txt', text: 'Synthetic unsaved work' });
    }, draftId);
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async (_window, options) => {
        if (options.title !== 'Back Up My Ion Data') throw new Error('Unexpected native save dialog');
        return { canceled: false, filePath: destination };
      };
      dialog.showOpenDialog = async (_window, options) => {
        if (options.title !== 'Restore From Backup') throw new Error('Unexpected native open dialog');
        return { canceled: false, filePaths: [destination] };
      };
    }, output);
    const created = await page.evaluate(async () => {
      const folders = await window.ion.backup.folders();
      const review = await window.ion.backup.review({ categories: ['preferences', 'recovery'], folders });
      return { review, path: await window.ion.backup.create(review.token) };
    });
    assert.equal(created.path, output); assert.ok(created.review.entries.some(e => e.path.endsWith('.draft')));
    assert.equal((await readFile(output)).subarray(0, 2).toString(), 'PK');
    const preview = await page.evaluate(() => window.ion.backup.openRestore()); assert.equal(preview.kind, 'restore');
    const prepared = await page.evaluate(token => window.ion.backup.prepareRestore(token, { replace: ['preferences', 'recovery'], mappings: [], copyFolders: [] }), preview.token);
    assert.ok(prepared.rollback.endsWith('.ionbackup'));
    await page.evaluate(() => window.ion.backup.cancel());
    assert.equal(await page.evaluate(id => window.ion.recovery.read(id), draftId), 'Synthetic unsaved work');
    assert.equal((await page.evaluate(() => window.ion.getPreferences())).settings.fontSize, 19);
    assert.ok(!(await readdir(profile)).some(n => n.startsWith('.ion-backup-stage-') || n === 'ion-pending-restore.json'));
    console.log('Native backup bridge: archive create, untrusted preview, prepared restore cancellation, settings and draft preservation passed. Controlled restart remains a separate verification gate.');
  } finally { await close(session); }
});
