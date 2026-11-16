// Bounded Node service benchmark. Does not launch Electron or access a live profile.
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), output = resolve('performance-results/core-backup-benchmark');
const common = ['preferences', 'themes', 'learning', 'content', 'projects'];
const modules = { service: resolve('dist/main/backup/service.cjs'), legacy: resolve('dist/main/profile-export.cjs') };
if (process.argv[2] === '--child') {
  const [variant, root, index] = process.argv.slice(3), profile = join(root, 'profile'), destination = join(root, 'output-' + variant + '-' + index);
  await mkdir(destination);
  const importAt = performance.now(), loaded = require(variant === 'legacy' ? modules.legacy : modules.service), loadMs = performance.now() - importAt;
  const cpu = process.cpuUsage(), startMemory = process.memoryUsage(), start = performance.now();
  let result, service, reviewMs = null, writeMs = null;
  if (variant === 'legacy') {
    const preferences = { exportSnapshot: async () => JSON.parse(await readFile(join(profile, 'preferences.json'), 'utf8')) };
    result = await loaded.exportLocalProfile(profile, destination, preferences);
  } else {
    service = new loaded.BackupService({ profile, appVersion: '0.9.8' });
    const folders = variant === 'workspace' ? [{ ...await service.addFolder(join(root, 'working-files')), mode: 'copy' }] : [];
    const reviewedAt = performance.now(); const review = await service.review({ categories: common, folders }); reviewMs = performance.now() - reviewedAt;
    const writeAt = performance.now(); result = await service.create(review.token, join(destination, 'data.ionbackup')); writeMs = performance.now() - writeAt;
    await service.cancel();
  }
  const durationMs = performance.now() - start, endMemory = process.memoryUsage(), cpuDelta = process.cpuUsage(cpu);
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  // Correctness verification is outside the timed interval and its memory sample.
  if (service) {
    const checked = await service.openRestore(result);
    if (checked.files !== (variant === 'workspace' ? 54 : 14)) throw new Error('Wrong backup payload count.');
    await service.cancel();
  } else {
    const verify = async (source, target) => {
      for (const item of await readdir(source, { withFileTypes: true })) {
        const input = join(source, item.name), copied = join(target, item.name);
        if (item.isDirectory()) await verify(input, copied);
        else if (!(await readFile(input)).equals(await readFile(copied))) throw new Error('Legacy benchmark copy mismatch.');
      }
    };
    await verify(profile, result);
  }
  const staleStages = (await readdir(profile)).filter(n => n.startsWith('.ion-backup-stage-'));
  if (staleStages.length) throw new Error('Benchmark left a staging directory.');
  process.send?.({ variant, index: Number(index), loadMs, durationMs, reviewMs, writeMs, rssBeforeMiB: startMemory.rss / 1024 ** 2, rssAfterMiB: endMemory.rss / 1024 ** 2,
    peakRssMiB, cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
    heapAfterMiB: endMemory.heapUsed / 1024 ** 2, cleanup: true, bytes: (await stat(result)).isFile() ? (await stat(result)).size : null });
} else {
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ion-backup-benchmark-'))), profile = join(root, 'profile'); await mkdir(profile);
  const helper = join(root, 'fixture.cjs');
  const source = `import { PreferenceStore } from './src/main/preferences'; import { ThemeStore } from './src/main/themes'; import { LearningService } from './src/main/learning'; import { ProjectRepository } from './src/main/projects/repository'; import { planningCases } from './test/fixtures/project-plans'; import { readFile } from 'node:fs/promises'; import { join, resolve } from 'node:path'; export async function setup(profile) { const prefs = new PreferenceStore(join(profile,'preferences.json')); await prefs.updateSettings({fontSize:19}); const theme = new ThemeStore(profile, resolve('src/main/themes/palettes')); const palette = JSON.parse(await readFile(resolve('src/main/themes/palettes/dark.json'),'utf8')); for(let i=0;i<10;i++) await theme.create({...palette,name:'Benchmark theme '+i}); const history = new LearningService(join(profile,'learning.json')); for(let i=0;i<20;i++) await history.recordTopic('arrays','selected'); const projects = new ProjectRepository(join(profile,'projects-v1')); await projects.save('/synthetic/assignment',planningCases[0].reviewed,null); }`;
  await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' }, platform: 'node', target: 'node24', bundle: true, minify: true, format: 'cjs', outfile: helper, external: ['electron'] });
  const report = { environment: { date: new Date().toISOString(), node: process.version, os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, physicalRamGiB: totalmem() / 1024 ** 3 },
    scope: 'Fresh Node child using production service bundles, filesystem caches uncontrolled/warm; not Electron process-tree RAM or GUI startup.',
    fixture: { customThemes: 10, learningTopicEvents: 20, projects: 1, copiedWorkspaceFiles: 40, copiedWorkspaceBytes: 40 * 256 * 1024 }, samples: [], errors: [], summaries: {} };
  try {
    await require(helper).setup(profile); await mkdir(join(root, 'working-files'));
    const content = Buffer.alloc(256 * 1024, 'a');
    for (let i = 0; i < 40; i++) await writeFile(join(root, 'working-files', 'source-' + i + '.txt'), content);
    const child = (variant, index) => new Promise((yes, no) => {
      const worker = fork(new URL(import.meta.url), ['--child', variant, root, String(index)], { silent: true }); let data, error = '';
      const deadline = setTimeout(() => { worker.kill('SIGKILL'); no(new Error('Benchmark child exceeded the 30-second safety bound.')); }, 30000);
      worker.on('message', message => { data = message; }); worker.stderr.on('data', bytes => { if (error.length < 8192) error += bytes; });
      worker.on('error', no); worker.on('close', code => { clearTimeout(deadline); code || !data ? no(new Error(error || 'No benchmark result.')) : yes(data); });
    });
    // All samples retained. Interleaved comparable common-payload cases; workspace is a separate new capability.
    for (let i = 0; i < 30; i++) for (const variant of i % 2 ? ['common', 'legacy'] : ['legacy', 'common']) {
      try { report.samples.push(await child(variant, i)); } catch (error) { report.errors.push({ variant, index: i, error: String(error) }); }
    }
    for (let i = 0; i < 10; i++) { try { report.samples.push(await child('workspace', i)); } catch (error) { report.errors.push({ variant: 'workspace', index: i, error: String(error) }); } }
    const { BackupService } = require(modules.service), service = new BackupService({ profile, appVersion: '0.9.8' });
    report.cycles = [];
    for (let i = 0; i < 40; i++) { const start = performance.now(); await service.review({ categories: ['preferences'], folders: [] }); await service.cancel(); if (i % 5 === 0 || i === 39) report.cycles.push({ index: i, ms: performance.now() - start, ...process.memoryUsage() }); }
    const beforeIdle = process.cpuUsage(), idleAt = performance.now(); await new Promise(yes => setTimeout(yes, 1000));
    const idle = process.cpuUsage(beforeIdle); report.closedServiceCpuMs = (idle.user + idle.system) / 1000; report.closedObservationMs = performance.now() - idleAt;
    const pendingHelper = join(root, 'pending.cjs'); await build({ entryPoints: ['src/main/backup/pending.ts'], bundle: true, platform: 'node', format: 'cjs', minify: true, outfile: pendingHelper });
    const { hasPendingRestore } = require(pendingHelper), probes = [];
    for (let i = 0; i < 100; i++) { const start = performance.now(); assertFalse(await hasPendingRestore(profile)); probes.push(performance.now() - start); }
    const stats = values => { const ordered = [...values].sort((a,b) => a-b); return { n: values.length, median: ordered[Math.floor(values.length / 2)], p95: ordered[Math.ceil(values.length * .95)-1], max: ordered.at(-1) }; };
    report.markerProbeMs = stats(probes);
    for (const variant of ['legacy', 'common', 'workspace']) {
      const rows = report.samples.filter(s => s.variant === variant); report.summaries[variant] = Object.fromEntries(['durationMs', 'loadMs', 'peakRssMiB', 'rssBeforeMiB', 'rssAfterMiB', 'cpuMs'].map(key => [key, stats(rows.map(r => r[key]))]));
    }
    await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ summaries: report.summaries, markerProbeMs: report.markerProbeMs, errors: report.errors }, null, 2));
    if (report.errors.length) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}
function assertFalse(value) { if (value !== false) throw new Error('Unexpected pending restore.'); }
