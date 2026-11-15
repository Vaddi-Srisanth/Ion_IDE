// Browser-only UI verification. Intentionally imports no Electron utilities.
// Real production renderer + explicit fixture bridge; not native runtime proof.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { browserFixtureData, installBrowserFixture } from './next-generation-browser-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--target', '--out', '--next', '--scale', '--catalog', '--cycles', '--practical', '--lens'].includes(key) || !value || options.has(key)) throw new Error('Usage: node scripts/next-generation-ui.mjs --target /absolute/dist/renderer --out /absolute/results [--next true] [--scale 2] [--catalog true] [--cycles 20] [--practical true] [--lens true]');
  options.set(key, value);
}
for (const key of ['--target', '--out']) if (!isAbsolute(options.get(key) ?? '')) throw new Error(key + ' must be absolute.');
for (const key of ['--next', '--catalog', '--practical', '--lens']) if (options.has(key) && options.get(key) !== 'true') throw new Error(key + ' accepts only true.');
const next = options.get('--next') === 'true';
const catalog = options.get('--catalog') === 'true';
const practical = options.get('--practical') === 'true';
const lens = options.get('--lens') === 'true';
if (practical && (!next || !catalog)) throw new Error('--practical requires --next true --catalog true.');
if (catalog && !next) throw new Error('--catalog true requires --next true.');
const cycles = options.has('--cycles') ? Number(options.get('--cycles')) : 0;
if (options.has('--cycles') && (!/^[0-9]+$/.test(options.get('--cycles')) || !Number.isSafeInteger(cycles) || cycles < 1 || cycles > 50)) throw new Error('--cycles must be an integer from 1 through 50.');
if (cycles && (!next || !catalog)) throw new Error('--cycles requires candidate --next true --catalog true.');
const scale = options.get('--scale') ?? '1';
if (!['1', '2'].includes(scale)) throw new Error('--scale must be 1 or 2.');
const target = await realpath(options.get('--target'));
const output = resolve(options.get('--out'));
const within = (parent, path) => { const child = relative(parent, path); return !child || (!child.startsWith('..' + sep) && child !== '..' && !isAbsolute(child)); };
if (within(target, output) || within(output, target)) throw new Error('Output must be separate from the compiled renderer.');
await stat(join(target, 'index.html'));
await mkdir(output, { recursive: true });
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await stat(chrome);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
let requestCount = 0, servedBytes = 0;
const serverErrors = [];
const server = createServer(async (request, response) => {
  try {
    if (++requestCount > 1000) throw new Error('Static request budget exceeded.');
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const path = await realpath(join(target, pathname === '/' ? 'index.html' : pathname));
    if (!within(target, path)) throw new Error('Static path escaped target.');
    const details = await stat(path);
    if (!details.isFile() || details.size > 32 * 1024 * 1024 || servedBytes + details.size > 256 * 1024 * 1024) throw new Error('Static file budget exceeded.');
    servedBytes += details.size;
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Content-Length': details.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path).on('error', error => { serverErrors.push(error.message); response.destroy(error); }).pipe(response);
  } catch (error) {
    serverErrors.push(String(error.message));
    if (!response.headersSent) response.writeHead(404);
    response.end('Unavailable fixture asset.');
  }
});
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {
  kind: 'headless-browser-real-renderer-with-test-bridge',
  limitations: ['Not Electron/native runtime verification.', 'No native filesystem writes, execution, terminal, recovery, installer or memory-footprint claims.',
    'JS heap is Chromium renderer JS heap, not process-tree RSS or macOS attributed footprint.', 'Fixture-selected Java pack and synthetic project are test data, not user data.'],
  target, chrome, nextGenerationAssertions: next, freshCatalogFixture: catalog, contentSettingsCycles: cycles,
  deviceScaleFactor: Number(scale), scaleCaveat: 'Chrome device scale factor, not native macOS Retina/WindowServer verification.', scenarios: [], errors: [],
};
let browser;
try {
  browser = await chromium.launch({ executablePath: chrome, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run'] });
  report.browserVersion = browser.version();
  for (const [width, height] of [[960, 700], [1440, 900]]) for (const theme of ['dark', 'light']) {
    const label = `${width}x${height}-${theme}${scale === '2' ? '-scale2' : ''}`;
    const scenario = { label, screenshots: [], console: [], errors: [], requests: [], assertions: [] };
    report.scenarios.push(scenario);
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: Number(scale),
      serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      await context.addInitScript(installBrowserFixture, await browserFixtureData(theme, { freshCatalog: catalog }));
      await context.route('**/*', async route => {
        const url = route.request().url();
        if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
        scenario.errors.push('Blocked unexpected remote request: ' + url); return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => scenario.errors.push(error.message));
      page.on('console', message => { if (scenario.console.length < 120) scenario.console.push({ type: message.type(), text: message.text().slice(0, 1200) }); });
      page.on('requestfailed', request => scenario.errors.push('Request failed: ' + request.url() + ' ' + request.failure()?.errorText));
      page.on('response', response => { if (response.status() >= 400) scenario.errors.push('HTTP ' + response.status() + ': ' + response.url()); });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Performance.enable');
      const network = new Map();
      cdp.on('Network.requestWillBeSent', event => network.set(event.requestId, { url: event.request.url, type: event.type, bytes: 0 }));
      cdp.on('Network.loadingFinished', event => { const item = network.get(event.requestId); if (item) item.bytes = event.encodedDataLength; });
      const snapshot = async name => {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
        const file = `${label}-${name}.png`;
        await page.screenshot({ path: join(output, file), fullPage: false, animations: 'disabled' });
        scenario.screenshots.push(file);
        const metrics = await cdp.send('Performance.getMetrics');
        const selected = Object.fromEntries(metrics.metrics.filter(({ name: key }) => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'TaskDuration'].includes(key)).map(({ name: key, value }) => [key, value]));
        const resources = [...network.values()].filter(item => /\.js(?:$|\?)/.test(item.url));
        scenario[name] = { browserMetrics: selected, totalJsTransferredBytes: resources.reduce((sum, item) => sum + item.bytes, 0),
          jsResources: resources.map(({ url, bytes }) => ({ path: new URL(url).pathname, bytes })),
          layout: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
            documentHeight: document.documentElement.scrollHeight, visibleMainCount: [...document.querySelectorAll('main')].filter(node => node.getBoundingClientRect().width > 0).length })) };
        assert.equal(scenario[name].layout.documentWidth <= width + 1, true, 'Unexpected page horizontal overflow: ' + name);
      };
      const boot = performance.now();
      await page.goto(origin + '/', { waitUntil: 'networkidle', timeout: 20000 });
      await page.getByTestId('welcome').waitFor();
      await page.locator(`.app-shell[data-theme-id="${theme}"]`).waitFor();
      await page.getByTestId('welcome').getByTestId('workspace-practice').waitFor();
      scenario.welcomeReadyMs = performance.now() - boot;
      scenario.assertions.push('Welcome visible; Practice remains discoverable; selected theme applied.');
      await snapshot('welcome');
      const dormant = scenario.welcome.jsResources.filter(({ path }) => /ProjectLens|LearningPane|MarketplacePane|LearningContentSettings|ProjectsPanel|PracticePane|TerminalPane|TerminalSurface|xterm|addon-search/i.test(path));
      assert.deepEqual(dormant, [], 'Optional modules were requested on Welcome.');
      const welcomeCalls = await page.evaluate(() => window.__ionBrowserFixture.inspect());
      assert.equal(welcomeCalls.calls.some(name => /projectLens|learningPacks|terminal\.create|runConsole\.start/.test(name)), false, 'Optional backend fixture called on Welcome.');
      scenario.assertions.push('Named learning/project/practice/terminal chunks and services dormant on Welcome.');

      await page.getByTestId('workspace-learn').click();
      const learn = page.getByTestId('learning-pane');
      await learn.waitFor();
      if (catalog) {
        assert.equal(await page.getByTestId('toggle-marketplace').count(), 0, 'Marketplace rail must be absent.');
        await learn.getByTestId('learning-language').waitFor();
        assert.equal(await learn.getByTestId('learning-language').inputValue(), '', 'Fresh fixture must not select a language automatically.');
        await learn.getByTestId('learning-language').selectOption('java');
        assert.equal((await page.evaluate(() => window.__ionBrowserFixture.inspect())).calls.includes('learningPacks.install'), false);
        await learn.getByTestId('learning-practice').waitFor();
        scenario.assertions.push('Fresh profile chooses Java directly in Learn; no Marketplace rail/install call; Practice is visible. Fixture materialization is test-only.');
      }
      await learn.getByTestId('learning-topic').first().waitFor();
      assert.equal((await learn.locator('.learning-nav-item').first().innerText()).trim(), 'Topics');
      assert.equal(await learn.getByTestId('learning-language').inputValue(), 'java');
      await snapshot('learn');
      await learn.getByTestId('learning-topic').first().click();
      await learn.getByTestId('learning-pack-lesson').waitFor();
      await snapshot('lesson');
      scenario.assertions.push('Learn selects installed Java; Topics remains first; real bundled lesson renders.');
      if (practical) {
        await learn.getByRole('button', { name: 'Back to topics' }).click();
        await learn.locator('[data-testid="learning-topic"][data-topic="flow"]').click();
        await learn.getByTestId('learning-objective').waitFor();
        assert.equal(await learn.getByTestId('learning-hints').locator('li').count(), 0);
        for (let hint = 1; hint <= 3; hint++) {
          await learn.getByTestId('learning-reveal-hint').click();
          await learn.getByTestId('learning-activity').getByText('Hints viewed: ' + hint, { exact: false }).waitFor();
          assert.equal(await learn.getByTestId('learning-hints').locator('li').count(), hint);
        }
        await learn.getByTestId('learning-start-exercise').click();
        const run = learn.getByTestId('learning-run-samples');
        await learn.locator('[data-testid="learning-run-samples"]:not(:disabled)').waitFor();
        await page.locator('.monaco-editor .view-lines').getByText('int count = input.nextInt();', { exact: false }).waitFor();
        assert.equal(await page.getByTestId('practice-pane').count(), 0, 'Enriched exercise left Learn.');
        assert.equal(await page.locator('.monaco-editor').count(), 1);
        const readExercise = () => page.evaluate(async () => {
          const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/editor\.api-[^/]+\.js$/.test(name));
          if (!url) throw new Error('Loaded Monaco module unavailable.');
          const { editor } = await import(url);
          const instance = editor.getEditors().find(item => item.getDomNode()?.closest('[data-testid="editor"]'));
          return { text: instance.getValue(), focus: instance.hasTextFocus(), canUndo: instance.getModel().canUndo() };
        });
        const originalExercise = (await readExercise()).text;
        const controlSource = 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("fixture paste");\n    }\n}\n';
        await page.locator('.monaco-editor .view-line').first().click();
        await page.keyboard.press('Meta+a');
        await page.keyboard.insertText(controlSource);
        const inserted = await readExercise();
        await page.keyboard.press('Meta+z');
        const afterImeUndo = await readExercise();
        scenario.multilineInputControl = { inserted, afterImeUndo, originalExercise,
          note: 'CDP insertText control is IME-style input, not a paste; retained even when its single Undo grouping differs.' };
        // Temporary stock control, test-only. Dispose its widget/model/host
        // before continuing ordinary single-editor and resource checks.
        await page.evaluate(async original => {
          const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/editor\.api-[^/]+\.js$/.test(name));
          const { editor } = await import(url);
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;top:0;left:0;width:600px;height:400px;z-index:9999';
          document.body.append(host);
          const model = editor.createModel(original, 'java');
          const instance = editor.create(host, { model, minimap: { enabled: false }, quickSuggestions: false,
            suggestOnTriggerCharacters: false, wordBasedSuggestions: 'off', tabCompletion: 'off' });
          instance.setSelection(model.getFullModelRange()); instance.focus();
          window.__stockUndoControl = { instance, model, host };
        }, originalExercise);
        try {
          await page.keyboard.insertText(controlSource);
          await page.keyboard.press('Meta+z');
          const stockAfterUndo = await page.evaluate(() => window.__stockUndoControl.instance.getValue());
          scenario.multilineInputControl.stockAfterUndo = stockAfterUndo;
          assert.equal(stockAfterUndo, afterImeUndo.text, 'Ion changed multiline IME Undo grouping versus stock Monaco.');
        } finally {
          await page.evaluate(() => {
            const { instance, model, host } = window.__stockUndoControl;
            instance.dispose(); model.dispose(); host.remove(); delete window.__stockUndoControl;
          });
        }
        assert.equal(await page.locator('.monaco-editor').count(), 1);
        // Use the real paste command for a coherent replacement and exact Undo.
        const paste = async text => page.evaluate(async text => {
          const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/editor\.api-[^/]+\.js$/.test(name));
          const { editor } = await import(url);
          const instance = editor.getEditors().find(item => item.getDomNode()?.closest('[data-testid="editor"]'));
          instance.focus(); instance.setSelection(instance.getModel().getFullModelRange());
          instance.trigger('clipboard', 'paste', { text, pasteOnNewLine: false, multicursorText: null });
        }, text);
        await paste(originalExercise);
        await paste(controlSource);
        await page.keyboard.press('Meta+z');
        assert.equal((await readExercise()).text, originalExercise, 'Single Undo after actual paste lost the exercise starter.');
        await page.keyboard.press('Meta+Shift+z');
        assert.equal((await readExercise()).text, controlSource, 'Redo after actual paste lost the solution.');
        await page.keyboard.press('Meta+z');
        assert.equal((await readExercise()).text, originalExercise);
        const fixtureState = () => page.evaluate(() => window.__ionBrowserFixture.inspect());
        const before = await fixtureState();
        await page.evaluate(() => window.__ionBrowserFixture.deferPractice('practice.openAttempt'));
        await run.click();
        await page.waitForFunction(() => window.__ionBrowserFixture.inspect().pendingPractice === 'practice.openAttempt');
        await learn.getByTestId('learning-stop-samples').click();
        await page.evaluate(() => window.__ionBrowserFixture.resolvePractice());
        await learn.locator('[data-testid="learning-run-samples"]:not(:disabled)').waitFor();
        const stoppedPreflight = await fixtureState();
        assert.equal(stoppedPreflight.cancelCount, before.cancelCount);
        assert.equal(stoppedPreflight.calls.filter(name => name === 'practice.runSamples').length, before.calls.filter(name => name === 'practice.runSamples').length);
        assert.equal(stoppedPreflight.calls.filter(name => name === 'saveFile').length, before.calls.filter(name => name === 'saveFile').length);
        await run.click();
        await learn.getByTestId('practice-results').getByText('1 of 3 passed', { exact: true }).waitFor();
        await learn.getByTestId('learning-sample-evidence').getByText('1 of 3 samples passed', { exact: false }).waitFor();
        await learn.getByTestId('practice-results').scrollIntoViewIfNeeded();
        await snapshot('practical-results');
        assert.equal((await fixtureState()).cancelCount, before.cancelCount, 'Completed run was cancelled.');
        await page.evaluate(() => window.__ionBrowserFixture.deferPractice('practice.runSamples'));
        await run.click();
        await page.waitForFunction(() => window.__ionBrowserFixture.inspect().pendingPractice === 'practice.runSamples');
        await learn.getByRole('button', { name: 'Back to topics' }).click();
        await page.waitForFunction(() => window.__ionBrowserFixture.inspect().cancelCount === 1 && window.__ionBrowserFixture.inspect().pendingPractice === null);
        assert.equal((await fixtureState()).calls.includes('stopRun'), false, 'Sample cancellation touched the broad Run Console stop.');
        scenario.assertions.push('Real practical React UI: three graduated hints; scaffold beside one Monaco; Stop during held lookup prevents save/run; held sample-run unmount invokes one narrow cancellation; completed run does not cancel. All sample statuses are explicit test transport, not native execution evidence.');
      }

      await page.getByRole('button', { name: 'Welcome', exact: true }).click();
      await page.getByTestId('welcome').waitFor();
      await page.getByTestId('welcome').getByTestId('open-folder').click();
      await page.getByTestId('explorer-entry').filter({ hasText: 'Main.java' }).click();
      await page.locator('.monaco-editor .view-lines').getByText('public class Main {', { exact: false }).waitFor();
      await snapshot('code');
      assert.equal(await page.locator('.monaco-editor').count(), 1, 'Expected one normal source editor.');
      scenario.assertions.push('Real Monaco displays fixture source; exactly one code editor exists.');
      // Use the existing command bridge and actual command implementation, not a
      // replacement editor action; this avoids OS-global shortcut side effects.
      await page.evaluate(() => window.__ionBrowserFixture.command('find'));
      await page.locator('.find-widget').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      scenario.assertions.push('Existing Find command opens real Monaco Find widget.');
      if (next) {
        const code = page.getByRole('button', { name: 'Code', exact: true });
        const learnNavigation = page.getByTestId('navigate-learn');
        const editorElement = await page.locator('.monaco-editor').elementHandle();
        await code.waitFor();
        await learnNavigation.waitFor();
        const originalSource = await page.locator('.monaco-editor .view-lines').innerText();
        // Monaco may use native EditContext instead of a hidden textarea.
        // Exercise real keyboard input through its visible first source line.
        const firstLine = page.locator('.monaco-editor .view-line').first();
        const originalFirstLine = await firstLine.innerText();
        await firstLine.click();
        await page.keyboard.press('Meta+ArrowRight');
        await page.keyboard.press('x');
        await page.waitForFunction(() => document.querySelector('.monaco-editor .view-line')?.textContent.endsWith('x'));
        await page.locator('.tab-close.tab-dirty').waitFor();
        await learnNavigation.click();
        await learn.waitFor();
        await code.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]')?.dataset.mode === 'free');
        assert.equal(await editorElement.evaluate(element => element.isConnected), true, 'Workspace switching remounted Monaco.');
        assert.equal(await page.locator('.monaco-editor').count(), 1);
        assert.equal(await firstLine.innerText(), originalFirstLine + 'x', 'Unsaved source lost on navigation.');
        await firstLine.click();
        await page.keyboard.press('Meta+z');
        await page.waitForFunction(() => !document.querySelector('.monaco-editor .view-line')?.textContent.endsWith('x'));
        assert.equal(await page.locator('.monaco-editor .view-lines').innerText(), originalSource, 'One Undo did not restore pre-edit source.');
        scenario.assertions.push('Persistent Code/Learn controls preserve actual unsaved Monaco text, widget identity and one-step Undo.');

        await code.focus();
        await page.keyboard.press('Tab');
        scenario.keyboardFocus = await learnNavigation.evaluate(element => ({ active: document.activeElement === element,
          focusVisible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle,
          width: getComputedStyle(element).outlineWidth, color: getComputedStyle(element).outlineColor }));
        assert.equal(scenario.keyboardFocus.active, true, 'Tab did not reach Learn navigation.');
        assert.equal(scenario.keyboardFocus.focusVisible, true);
        assert.notEqual(scenario.keyboardFocus.outline, 'none');
        assert.ok(parseFloat(scenario.keyboardFocus.width) >= 1);
        await snapshot('keyboard-focus');
        scenario.assertions.push('Keyboard Tab reaches Learn and computed :focus-visible outline is visible.');

        await page.getByTestId('navigate-projects').click();
        const projectTitle = page.getByTestId('project-title');
        await projectTitle.fill('Do not lose this project draft');
        await page.getByTestId('project-description').fill('A real React form fixture with unsaved input.');
        await code.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]')?.dataset.mode === 'projects');
        assert.equal(await projectTitle.inputValue(), 'Do not lose this project draft');
        await page.getByText('Save or close the current draft before switching workspaces.', { exact: true }).waitFor();
        await snapshot('project-draft-protected');
        await page.getByRole('button', { name: 'Discard Draft', exact: true }).click();
        if (lens) {
          await page.getByTestId('project-view-lens').click();
          const lensPane = page.getByTestId('project-lens');
          await lensPane.getByTestId('project-lens-analyze').waitFor();
          assert.equal((await page.evaluate(() => window.__ionBrowserFixture.inspect())).calls.includes('projectLens.analyze'), false, 'Project Lens analyzed automatically.');
          await lensPane.getByTestId('project-lens-analyze').click();
          await lensPane.getByTestId('project-lens-summary').waitFor();
          await lensPane.getByText('React', { exact: true }).waitFor();
          await snapshot('project-lens');
          await lensPane.getByRole('button', { name: 'Main.java', exact: false }).first().click();
          assert.equal(await editorElement.evaluate(element => element.isConnected), true);
          await page.getByTestId('project-view-roadmap').click();
          await lensPane.waitFor({ state: 'detached' });
          await page.waitForFunction(() => window.__ionBrowserFixture.inspect().calls.includes('projectLens.cancel'));
          scenario.assertions.push('Actual lazy Lens component requires explicit Analyze; renders declared evidence and opens source using the existing widget; leaving it cancels/releases. Snapshot transport is test-only; real filesystem/security tests are separate.');
        }
        await code.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]')?.dataset.mode === 'free');
        scenario.assertions.push('Actual dirty Projects form blocks Code navigation; input survives until explicit discard.');

        if (catalog) {
          await learnNavigation.click();
          await learn.getByTestId('learning-practice').click();
        } else {
          await page.getByRole('button', { name: 'Welcome', exact: true }).click();
          await page.getByTestId('workspace-practice').click();
        }
        await page.getByTestId('practice-pane').waitFor();
        await page.getByTestId('practice-new').click();
        await page.getByTestId('practice-title').fill('Do not lose this practice draft');
        await page.getByRole('button', { name: 'Keep draft', exact: true }).click();
        await code.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]')?.dataset.mode === 'practice');
        await page.getByText('Save or close the current draft before switching workspaces.', { exact: true }).waitFor();
        await page.getByTestId('practice-new').click();
        assert.equal(await page.getByTestId('practice-title').inputValue(), 'Do not lose this practice draft');
        await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
        await code.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="workspace"]')?.dataset.mode === 'free');
        scenario.assertions.push('Actual dirty Practice form blocks Code navigation and resumes with the original input.');
        if (catalog) {
          await page.evaluate(() => window.__ionBrowserFixture.command('toggle-marketplace'));
          const content = page.getByTestId('learning-content-settings');
          const contentDialog = page.getByRole('dialog', { name: 'Learning Content', exact: true });
          await content.waitFor();
          const javaCopy = content.locator('[data-content-id="java"]');
          await javaCopy.getByTestId('content-export').click();
          await content.getByText('Java exported.', { exact: true }).waitFor();
          await javaCopy.getByTestId('content-remove').click();
          await javaCopy.getByTestId('content-remove-confirm').click();
          await javaCopy.waitFor({ state: 'detached' });
          await content.getByTestId('content-import').click();
          await content.getByTestId('content-import-preview').waitFor();
          await content.getByTestId('content-import-discard').click();
          await page.waitForFunction(() => window.__ionBrowserFixture.inspect().previewTokens === 0);
          await content.getByTestId('content-import').click();
          await content.getByTestId('content-import-confirm').click();
          await content.locator('[data-content-id="fixture-import"]').waitFor();
          await snapshot('learning-content');
          scenario.assertions.push('Existing command alias opens real Content Settings; component export/remove/review/discard/confirm calls work against explicit test data only.');

          await page.evaluate(() => window.__ionBrowserFixture.deferNextPreview());
          await content.getByTestId('content-import').click();
          await page.waitForFunction(() => window.__ionBrowserFixture.inspect().pendingPreview);
          await contentDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
          await contentDialog.waitFor({ state: 'detached' });
          await page.evaluate(() => window.__ionBrowserFixture.resolvePreview());
          await page.waitForFunction(() => window.__ionBrowserFixture.inspect().previewTokens === 0);
          assert.equal(await page.getByTestId('content-import-preview').count(), 0);
          scenario.assertions.push('Closing Content Settings during a pending chooser response discards its late preview token without reopening the dialog.');
          if (cycles) {
            scenario.contentCycles = { count: cycles, forcedGC: true,
              caveat: 'Test-only CDP forced garbage collection. Browser JS heap/DOM counters, not native RAM, natural recovery or proof that no leak exists.', samples: [] };
            await cdp.send('HeapProfiler.enable');
            const sample = async cycle => {
              await cdp.send('HeapProfiler.collectGarbage');
              const metrics = await cdp.send('Performance.getMetrics');
              const dom = await cdp.send('Memory.getDOMCounters');
              scenario.contentCycles.samples.push({ cycle, jsHeapUsedBytes: metrics.metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value,
                jsHeapTotalBytes: metrics.metrics.find(({ name }) => name === 'JSHeapTotalSize')?.value,
                documents: dom.documents, nodes: dom.nodes, jsEventListeners: dom.jsEventListeners });
              const state = await page.evaluate(() => window.__ionBrowserFixture.inspect());
              assert.equal(state.previewTokens, 0, 'Preview retained after content cycle.');
              assert.equal(state.pendingPreview, false);
              assert.equal(state.subscribers.projectSourceSaved, 0, 'Project listener retained after content cycle.');
              assert.deepEqual(state.failures, []);
              assert.equal(state.calls.some(name => /terminal\.create|runConsole\.start|updates\.check|formatting\.run|languageTools\.query/.test(name)), false);
              assert.equal(await editorElement.evaluate(element => element.isConnected), true, 'Content cycle replaced original Monaco widget.');
              assert.equal(await page.locator('.monaco-editor').count(), 1);
              assert.equal(await page.locator('.monaco-editor .view-lines').innerText(), originalSource, 'Content cycles changed source text.');
            };
            await sample(0);
            for (let cycle = 1; cycle <= cycles; cycle++) {
              await page.evaluate(() => window.__ionBrowserFixture.command('toggle-marketplace'));
              await content.locator('[data-testid="content-import"]:not(:disabled)').waitFor();
              await page.keyboard.press('Escape');
              await content.waitFor({ state: 'detached' });
              if (cycle % 5 === 0 || cycle === cycles) await sample(cycle);
            }
            await cdp.send('HeapProfiler.disable');
            scenario.assertions.push(`${cycles} real Content Settings open/Escape-close cycles preserve source/widget and release preview/project resources; forced-GC browser metrics sampled every five cycles.`);
          }
        }
      }
      scenario.fixture = await page.evaluate(() => window.__ionBrowserFixture.inspect());
      assert.deepEqual(scenario.fixture.failures, [], 'Unsupported bridge methods called.');
      if (catalog) { assert.equal(scenario.fixture.previewTokens, 0); assert.equal(scenario.fixture.calls.includes('learningPacks.install'), false); }
      assert.equal(scenario.fixture.calls.some(name => /terminal\.create|runConsole\.start|updates\.check|formatting\.run/.test(name)), false);
      if (next) assert.equal(scenario.fixture.subscribers.projectSourceSaved, 0, 'Project listener leaked after leaving Projects.');
      assert.deepEqual(scenario.errors, [], 'Renderer, request or console errors.');
      const consoleErrors = scenario.console.filter(item => item.type === 'error');
      assert.deepEqual(consoleErrors, [], 'Console errors.');
      scenario.status = 'passed';
    } catch (error) {
      scenario.status = 'failed'; scenario.errors.push(error.stack ?? String(error)); throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(serverErrors, [], 'Static asset server errors.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  report.server = { requestCount, servedBytes, errors: serverErrors };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios.map(({ label, status }) => ({ label, status })), output }));
