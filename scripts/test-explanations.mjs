import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { artifact, atPath, close, editorShows, eventually, launch, openFolder, openFromExplorer, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'
import { processTree } from './development-workflow-fixtures.mjs'
import { identityCpuPercent } from './process-family.mjs'

// Native CI only: actual production UI, preload, IPC, context/session and local
// persistence. Only synthetic HTTPS transport and (if unavailable) OS crypto are
// test adapters. Never launch this fixture against the installed application.
const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' },
  'measure-resources': { type: 'boolean', default: false },
  out: { type: 'string', default: 'performance-results/explanations-native.json' } } })
assert.ok(['darwin', 'win32'].includes(process.platform), 'Run this fixture on native macOS or Windows.')
const target = await artifact(values.target)
assert.equal(target.args.length, 1, 'Use an unpackaged production build with a disposable wrapper.')
const output = resolve(values.out)
await mkdir(dirname(output), { recursive: true })
const modules = await readdir(join(target.path, 'renderer/assets'))
const editorModule = modules.find(name => /^editor\.api-[\w-]+\.js$/.test(name))
assert.ok(editorModule, 'The compiled Monaco module must exist.')
const hash = value => createHash('sha256').update(value).digest('hex')
const report = { schemaVersion: 1, protocol: 'explanations-native-v1', complete: false, platform: process.platform,
  arch: process.arch, mainBuildHash: hash(await readFile(target.args[0])),
  transport: 'Synthetic main-process HTTPS response; no live provider or model-quality claim.',
  consent: 'UI Review/Send exercised; disposable native confirmation automatically accepts only Send Reviewed Context.',
  checks: {}, crypto: 'not-observed', unverified: [], cleanupVerified: false }
if (values['measure-resources']) report.resources = { complete: false, maximumDurationMs: 300_000, cycles: 0,
  protocol: { idleWindowMs: 1400, settleMs: 350, maximumSamples: 24, repeats: 20,
    memory: process.platform === 'darwin' ? 'Full app process-tree RSS and macOS-attributed footprint reported separately; shared RSS pages can be counted more than once.'
      : 'Full app process-tree working set and private bytes from native Windows counters, reported separately.',
    cpu: 'Identity-matched process CPU delta as percent of one logical core over the recorded interval, including probe overhead; null when membership changes. Short-lived exited process CPU is not captured.',
    scope: 'One candidate session; no baseline comparison. Tiny selected source prefix and bounded project structure. Endpoint snapshots are not peak memory measurements.',
    transport: 'Synthetic main-process fetch: live TLS, provider latency, network buffering and model processing are not measured.',
    recovery: 'Code-only checks at 20 and 60 seconds after optional panels close. No forced garbage collection.' }, samples: [] }
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
const failureLocation = (error, failurePhase) => {
  const location = String(error?.stack ?? '').match(/test-explanations\.mjs:(\d+):(\d+)/)
  return { phase: failurePhase, fixtureLine: location ? Number(location[1]) : null,
    fixtureColumn: location ? Number(location[2]) : null,
    kind: ['TimeoutError', 'AssertionError', 'Error', 'AggregateError'].includes(error?.name) ? error.name : 'unknown',
    message: 'Native explanation verification failed. Inspect the named phase with the disposable fixture.' }
}
let phase = 'fixture'
await persist()
try {
  await withScratch('explanations-native', async scratch => {
    const root = join(scratch, 'Project ü with spaces'), profile = join(scratch, 'profile')
    const source = join(root, 'src/main.py'), original = 'print("saved fixture")\n'
    const evidenceFile = join(root, 'src/evidence.py'), evidenceText = 'def fixture_value():\n    return 3\n'
    const endpoint = 'https://ion-fixture.invalid/v1', credential = 'synthetic-fixture-' + randomUUID()
    const exitReceipt = join(scratch, 'exit-receipt.json')
    await mkdir(join(root, 'src'), { recursive: true }); await mkdir(profile)
    await writeFile(source, original)
    await writeFile(evidenceFile, evidenceText)
    await writeFile(join(root, 'main.c'), 'int main(void) { return 0; }\n')
    await writeFile(join(root, 'package.json'), '{"name":"disposable-explanation-fixture","dependencies":{"react":"19"}}\n')
    await writeFile(join(root, '.env'), 'PRIVATE_SYNTHETIC_NOT_SELECTED=not-a-live-secret\n')
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: {
      resourceProfile: 'full', autoSave: false, checkUpdatesOnLaunch: false, openFullScreen: false }, recents: [] }))
    const wrapper = join(scratch, 'explanation-entry.cjs')
    const execute = promisify(execFile), mib = 1024 ** 2
    const probe = join(scratch, 'explanation-resource-probe')
    if (values['measure-resources'] && process.platform === 'darwin') {
      await execute('/usr/bin/xcrun', ['clang', '-O2', 'scripts/benchmark-resources-probe.c', '-o', probe],
        { timeout: 20_000, maxBuffer: 128_000 })
    }
    await writeFile(wrapper, `const fs = require('node:fs');
const { ipcMain, safeStorage } = require('electron');
const Module = require('node:module');
const state = globalThis.ionExplanationFixture = { calls: 0, active: 0, aborted: 0, approvals: 0, unexpected: 0,
  mode: 'success', waiting: false, release: null, lastBody: null, lastReview: null, lastReply: null,
  streams: 0, streamPending: false, finishStream: null,
  sendsActive: 0, reviews: 0, projectActions: 0, modules: [], crypto: 'not-observed', encrypted: 0, decrypted: 0 };
const endpoint = ${JSON.stringify(endpoint)};
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (typeof request === 'string' && /(?:explanations[\\\\/](?:session|context)|provider-vault)\\.cjs$/.test(request)
    && state.modules.length < 32) state.modules.push(request.split(/[\\\\/]/).slice(-2).join('/'));
  return originalLoad.call(this, request, ...args);
};
const available = safeStorage.isAsyncEncryptionAvailable.bind(safeStorage);
const encrypt = safeStorage.encryptStringAsync.bind(safeStorage), decrypt = safeStorage.decryptStringAsync.bind(safeStorage);
safeStorage.isAsyncEncryptionAvailable = async function() {
  const supported = await available();
  state.crypto = supported ? 'real-os-backed-safeStorage' : 'synthetic-test-only-adapter-os-crypto-unavailable';
  return true;
};
safeStorage.encryptStringAsync = async function(value) {
  state.encrypted++;
  return state.crypto === 'real-os-backed-safeStorage' ? encrypt(value) : Buffer.from('ION_SYNTHETIC_TEST_ONLY:' + value);
};
safeStorage.decryptStringAsync = async function(value) {
  state.decrypted++;
  return state.crypto === 'real-os-backed-safeStorage' ? decrypt(value)
    : { result: value.toString().slice('ION_SYNTHETIC_TEST_ONLY:'.length), shouldReEncrypt: false };
};
const originalHandle = ipcMain.handle;
ipcMain.handle = function(channel, listener) {
  if (/^ion:projects-(?:approve|run|run-suite|automatic)$/.test(channel)) {
    return originalHandle.call(this, channel, function(...args) { state.projectActions++; return listener.apply(this, args); });
  }
  if (!/^ion:explanations-/.test(channel)) return originalHandle.call(this, channel, listener);
  return originalHandle.call(this, channel, async function(...args) {
    if (channel === 'ion:explanations-review') state.reviews++;
    if (channel === 'ion:explanations-send') state.sendsActive++;
    try {
      const result = await listener.apply(this, args);
      if (channel === 'ion:explanations-review') state.lastReview = structuredClone(result);
      if (channel === 'ion:explanations-send' && result) state.lastReply = structuredClone(result);
      return result;
    } finally { if (channel === 'ion:explanations-send') state.sendsActive--; }
  });
};
globalThis.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : input.url;
  if (url !== endpoint + '/chat/completions') { state.unexpected++; throw new Error('Unexpected external network request refused by fixture.'); }
  state.calls++; state.active++;
  try {
    if (init.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string'
      || Buffer.byteLength(init.body) > 80 * 1024) throw new Error('Invalid fixture transport envelope.');
    if (!init.headers.authorization?.startsWith('Bearer synthetic-fixture-') || init.headers['content-type'] !== 'application/json') {
      throw new Error('Invalid synthetic fixture authorization envelope.');
    }
    state.lastBody = init.body;
    if (state.mode === 'hold') {
      state.waiting = true;
      await new Promise((resolve, reject) => {
        const aborted = () => { state.aborted++; reject(new Error('Synthetic request cancelled.')); };
        const finish = () => { init.signal.removeEventListener('abort', aborted); resolve(); };
        state.release = finish;
        init.signal.addEventListener('abort', aborted, { once: true });
        if (init.signal.aborted) aborted();
      });
    }
    if (state.mode === 'http-error') return new Response('{"private":"provider-body-must-not-be-rendered"}', { status: 503 });
    const envelope = JSON.parse(init.body);
    if ((envelope.stream === true) !== (state.lastReview?.stream === true)) throw new Error('Transport differs from review.');
    const inputData = JSON.parse(envelope.messages[1].content);
    const source = inputData.sources.find(item => item.origin === 'saved-file') || inputData.sources[0];
    const citations = source ? [{ sourceId: state.mode === 'invalid-citation' ? 'invented-source' : source.id,
      startLine: source.startLine, endLine: source.startLine }] : [];
    const answer = { summary: 'Synthetic fixture explanation; not a model quality test.',
      sections: [{ kind: source ? 'observed' : 'unknown', title: source ? 'Reviewed excerpt' : 'No evidence selected',
        text: source ? 'This assertion refers only to the selected excerpt.' : 'No code or project behavior can be established.', citations }],
      questions: ['Which independent evidence would strengthen this explanation?'],
      recommendations: [{ id: 'inspect', title: 'Inspect a representative input', description: 'Explain the behavior using your own observations.',
        acceptance: ['Describe one input and its expected behavior.'], dependsOn: [], citations }] };
    if (envelope.stream === true) {
      state.streams++;
      answer.summary = 'The streamed fixture received the reviewed evidence.';
      const frame = (delta, finish = null) => 'data: ' + JSON.stringify({
        id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1700000000, model: envelope.model,
        choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      }) + '\\n\\n';
      const encoder = new TextEncoder(), text = JSON.stringify(answer), split = Math.floor(text.length / 2);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(frame({ role: 'assistant', content: '' }) + frame({ content: text.slice(0, split) })));
          const finish = () => {
            state.streamPending = false; state.finishStream = null;
            controller.enqueue(encoder.encode(frame({ content: text.slice(split) }) + frame({}, 'stop') + 'data: [DONE]\\n\\n'));
            controller.close();
          };
          if (state.mode === 'hold-stream') { state.streamPending = true; state.finishStream = finish; }
          else finish();
        },
        cancel() { state.streamPending = false; state.finishStream = null; },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));
  } finally { state.active--; state.waiting = false; state.release = null; }
};
process.on('exit', () => {
  fs.writeFileSync(${JSON.stringify(exitReceipt)}, JSON.stringify({ calls: state.calls, active: state.active, aborted: state.aborted,
    sendsActive: state.sendsActive, unexpected: state.unexpected, crypto: state.crypto }));
});
require(${JSON.stringify(target.args[0])});\n`)
    let session, failure
    let resourceStarted, baselineChildren, resourceViewport, resourceTimer, rejectResourceDeadline
    const resourceDeadline = values['measure-resources'] ? new Promise((_, reject) => { rejectResourceDeadline = reject }) : undefined
    function resourceBudget(requiredMs = 0) {
      if (resourceStarted === undefined) {
        resourceStarted = performance.now()
        // Opt-in fixture deadline, not an application timeout or a retry. The
        // outer finally closes the same disposable session on expiry.
        resourceTimer = setTimeout(() => {
          report.resources.deadlineExceeded = true
          rejectResourceDeadline(new Error('The optional resource profile exceeded five minutes; partial evidence is retained.'))
        }, report.resources.maximumDurationMs)
      }
      assert.ok(performance.now() - resourceStarted + requiredMs < report.resources.maximumDurationMs,
        'The optional resource profile reached its bounded five-minute budget; incomplete samples are preserved.')
    }
    async function snapshotResources() {
      resourceBudget(20_000)
      const tree = await processTree(session)
      assert.ok(tree.members.length <= 64, 'Resource process family exceeds the bounded fixture log capacity.')
      let ledger
      let timeMs = tree.timeMs
      if (process.platform === 'darwin' && tree.members.length) {
        resourceBudget(10_000)
        const began = performance.now()
        const { stdout } = await execute(probe, tree.members.map(member => String(member.pid)), { timeout: 10_000, maxBuffer: 32_000 })
        timeMs = (began + performance.now()) / 2
        ledger = new Map(stdout.trim().split('\n').filter(Boolean).map(row => {
          const [pid, footprint, cpuNs] = row.trim().split(/\s+/).map(Number)
          assert.ok([pid, footprint, cpuNs].every(Number.isFinite), 'Invalid native resource counter.')
          return [pid, { footprintMiB: footprint / mib, cpuSeconds: cpuNs / 1e9 }]
        }))
      }
      const members = tree.members.map(member => ({ pid: member.pid, startedMs: member.startedMs, kind: member.kind,
        cpuSeconds: ledger ? ledger.get(member.pid)?.cpuSeconds ?? null : member.cpuSeconds,
        ...(process.platform === 'darwin' ? { rssMiB: member.rssMiB, footprintMiB: ledger?.get(member.pid)?.footprintMiB ?? null }
          : { workingSetMiB: member.workingSet / mib, privateMiB: member.privateBytes / mib }) }))
      const sum = key => members.reduce((total, member) => total + member[key], 0)
      const completeCpu = members.every(member => Number.isFinite(member.cpuSeconds) && Number.isFinite(member.startedMs))
      return { elapsedMs: timeMs - resourceStarted, timeMs, rootAlive: tree.rootAlive, members,
        cpuSecondsByIdentity: completeCpu ? Object.fromEntries(members.map(member => [member.pid + ':' + member.startedMs, member.cpuSeconds])) : null,
        ...(process.platform === 'darwin' ? { rssMiB: sum('rssMiB'),
          footprintMiB: members.every(member => Number.isFinite(member.footprintMiB)) ? sum('footprintMiB') : null }
          : { workingSetMiB: sum('workingSetMiB'), privateMiB: sum('privateMiB') }) }
    }
    async function resourceStage(label, extra = {}) {
      if (!values['measure-resources']) return
      resourceBudget(45_000)
      const samples = report.resources.samples
      assert.ok(samples.length < report.resources.protocol.maximumSamples, 'Bounded resource sample count exceeded.')
      const sample = { label, complete: false, ...extra }
      samples.push(sample); await persist()
      await sleep(report.resources.protocol.settleMs)
      sample.ui = await session.page.evaluate(async moduleName => {
        const { editor } = await import(new URL('assets/' + moduleName, location.href).href)
        const bounds = document.querySelector('[data-testid="editor"]')?.getBoundingClientRect()
        return { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
          editorWidth: bounds?.width ?? null, editorHeight: bounds?.height ?? null,
          editorCount: editor.getEditors().length, modelCount: editor.getModels().length,
          dialogCount: document.querySelectorAll('[data-testid="explanation-dialog"]').length,
          learnVisible: !!document.querySelector('[data-testid="learning-language"]'),
          lensVisible: !!document.querySelector('[data-testid="project-lens"]') }
      }, editorModule)
      const viewport = [sample.ui.width, sample.ui.height, sample.ui.deviceScaleFactor]
      if (!resourceViewport) resourceViewport = viewport
      assert.deepEqual(viewport, resourceViewport, 'Resource checkpoints must keep the same visible window dimensions and scale.')
      sample.first = await snapshotResources(); await persist()
      await sleep(report.resources.protocol.idleWindowMs)
      sample.last = await snapshotResources()
      sample.intervalMs = sample.last.timeMs - sample.first.timeMs
      sample.cpuPercent = sample.first.cpuSecondsByIdentity && sample.last.cpuSecondsByIdentity
        ? identityCpuPercent(sample.first, sample.last) : null
      sample.nativeChildCount = sample.last.members.filter(member => member.kind === 'child').length
      sample.complete = true; await persist()
      return sample
    }
    const stats = () => session.app.evaluate(() => {
      const state = globalThis.ionExplanationFixture
      return { calls: state.calls, active: state.active, aborted: state.aborted, approvals: state.approvals, unexpected: state.unexpected,
        sendsActive: state.sendsActive, reviews: state.reviews, projectActions: state.projectActions, modules: [...state.modules], crypto: state.crypto,
        encrypted: state.encrypted, decrypted: state.decrypted, waiting: state.waiting, streams: state.streams, streamPending: state.streamPending }
    })
    const reviewed = () => session.app.evaluate(() => globalThis.ionExplanationFixture.lastReview)
    const reply = () => session.app.evaluate(() => globalThis.ionExplanationFixture.lastReply)
    const mode = async value => {
      // ElectronApp.evaluate supplies Electron first and the caller's value
      // second; Page.evaluate has a different callback signature.
      const applied = await session.app.evaluate((_electron, selected) => {
        globalThis.ionExplanationFixture.mode = selected
        return globalThis.ionExplanationFixture.mode
      }, value)
      assert.equal(applied, value, 'The synthetic transport mode was not applied.')
    }
    const dialog = () => session.page.getByTestId('explanation-dialog')
    const closeDialog = async () => {
      await session.page.getByRole('dialog').filter({ has: dialog() }).getByRole('button', { name: 'Close dialog', exact: true }).click()
      await dialog().waitFor({ state: 'detached' })
    }
    const review = async () => {
      await dialog().getByLabel('Your question').fill('Explain only the evidence I explicitly selected.')
      await dialog().getByTestId('explanation-review').click()
      await dialog().getByTestId('explanation-review-content').waitFor()
      return reviewed()
    }
    const send = async () => {
      await dialog().getByTestId('explanation-send').click()
      await dialog().getByTestId('explanation-answer').waitFor()
      return reply()
    }
    const editor = async operation => session.page.evaluate(async ({ moduleName, operation }) => {
      const { editor } = await import(new URL('assets/' + moduleName, location.href).href)
      const instance = editor.getEditors().find(item => item.getDomNode()?.closest('[data-testid="editor"]'))
      if (!instance?.getModel()) throw new Error('Actual active Monaco editor unavailable.')
      const model = instance.getModel()
      if (operation === 'append') {
        const position = model.getPositionAt(model.getValueLength())
        instance.pushUndoStop()
        instance.executeEdits('native-explanation-fixture', [{ range: { startLineNumber: position.lineNumber,
          startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }, text: '# pending user edit\n' }])
        instance.pushUndoStop()
      }
      return model.getValue()
    }, { moduleName: editorModule, operation })
    try {
      const workflow = async () => {
      phase = 'launch-and-dormancy'
      session = await launch({ ...target, args: [wrapper] }, profile)
      const { app, page } = session
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: root })
      await app.evaluate(({ dialog }) => {
        const previous = dialog.showMessageBox
        dialog.showMessageBox = async function(window, options) {
          if (options.buttons?.includes('Send Reviewed Context')) {
            globalThis.ionExplanationFixture.approvals++
            return { response: options.buttons.indexOf('Send Reviewed Context'), checkboxChecked: false }
          }
          return previous.call(this, window, options)
        }
      })
      assert.deepEqual((await stats()).modules, [])
      assert.equal((await stats()).calls, 0)
      assert.equal((await stats()).encrypted, 0)
      phase = 'open-disposable-workspace'
      // openFolder waits for an immediate explorer child. The source lives in
      // a collapsed directory, so wait for main.c then explicitly expand src.
      await openFolder(page, { directory: root, program: join(root, 'main.c') })
      await atPath(page, 'explorer-entry', join(root, 'src')).click()
      phase = 'open-disposable-source'
      await openFromExplorer(page, source, 'saved fixture')
      await page.getByTestId('editor').evaluate(node => { node.dataset.explanationInstance = 'preserve-this-editor' })
      assert.deepEqual((await stats()).modules, [])
      assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
        .some(entry => /ExplanationDialog|ProviderConfiguration/.test(entry.name))), false)
      report.checks.dormantBeforeExplicitOpen = 'passed'
      const codeResource = await resourceStage('code-one-file-before-optional')
      if (codeResource) baselineChildren = new Set(codeResource.last.members.filter(member => member.kind === 'child')
        .map(member => member.pid + ':' + member.startedMs))

      phase = 'actual-lesson-and-provider-configuration'
      await page.getByTestId('navigate-learn').click()
      await page.getByTestId('learning-language').selectOption('python')
      await page.locator('.learning-topic-list button').filter({ hasText: 'Values, names, and output' }).click()
      await resourceStage('learn-installed-lesson-before-ai')
      const openTutor = async () => {
        await page.getByTestId('lesson-ask-tutor').click(); await dialog().waitFor()
      }
      await openTutor()
      assert.equal(await dialog().getByRole('checkbox').evaluateAll(nodes => nodes.some(node => node.checked)), false)
      await dialog().locator('.explanation-provider-details summary').click()
      await dialog().getByLabel('Provider base URL').fill(endpoint)
      await dialog().getByLabel('Model ID').fill('synthetic-native-fixture')
      await dialog().getByLabel('API key', { exact: true }).fill(credential)
      await dialog().getByRole('button', { name: 'Save Provider', exact: true }).click()
      await eventually(async () => (await page.evaluate(() => window.ion.explanations.provider())).hasKey,
        'Actual local provider configuration was not persisted.')
      assert.equal(await dialog().getByLabel('API key', { exact: true }).inputValue(), '')
      assert.equal((await readFile(join(profile, 'planning-provider-v1.json'), 'utf8')).includes(credential), false)
      report.crypto = (await stats()).crypto
      if (report.crypto !== 'real-os-backed-safeStorage') report.unverified.push({ check: 'real OS credential encryption',
        reason: 'OS crypto reported unavailable. This lane explicitly uses a wrapper-only synthetic adapter; production has no fallback.' })
      report.checks.explicitProviderConfiguration = 'passed'

      phase = 'question-only-review-and-send'
      const questionReview = await review()
      await resourceStage('tutor-question-only-review')
      assert.deepEqual(questionReview.sources, [])
      assert.equal((await stats()).calls, 0)
      await send()
      await resourceStage('tutor-question-only-reply')
      assert.equal((await stats()).calls, 1)
      assert.equal((await stats()).approvals, 1)
      const questionPayload = await app.evaluate(() => globalThis.ionExplanationFixture.lastBody)
      assert.equal(Buffer.byteLength(questionPayload), questionReview.bodyBytes)
      assert.equal(Object.hasOwn(JSON.parse(questionPayload), 'stream'), false)
      assert.deepEqual(JSON.parse(JSON.parse(questionPayload).messages[1].content).sources, [])
      assert.equal(questionPayload.includes(credential), false)
      await assert.rejects(page.evaluate(token => window.ion.explanations.send(token), questionReview.token))
      await assert.rejects(page.evaluate(() => window.ion.explanations.send('forged-token')))
      const received = await reply()
      await assert.rejects(page.evaluate(token => window.ion.explanations.openCitation(token, 'forged-source', { startLine: 1, endLine: 1 }), received.token))
      assert.equal((await stats()).calls, 1)
      report.checks.explicitReviewExactBytesSingleUseConsent = 'passed'
      report.checks.forgedTokenAndCitationRejected = 'passed'
      await closeDialog()

      phase = 'opt-in-streamed-lesson-and-validated-answer'
      await openTutor()
      const transport = dialog().getByRole('checkbox', { name: 'Stream provider response', exact: true })
      assert.equal(await transport.isChecked(), false)
      await dialog().getByRole('checkbox', { name: /^Installed lesson:/ }).check()
      await transport.check()
      const beforeStream = await stats(), streamReview = await review()
      assert.equal(streamReview.stream, true)
      assert.deepEqual(streamReview.sources.map(item => item.origin), ['lesson'])
      await dialog().getByTestId('explanation-review-content').getByText('Streaming', { exact: true }).waitFor()
      assert.equal((await stats()).calls, beforeStream.calls)
      await mode('hold-stream')
      await dialog().getByTestId('explanation-send').click()
      await eventually(async () => (await stats()).streamPending, 'The synthetic provider did not open its reviewed event stream.')
      assert.equal(await dialog().getByTestId('explanation-answer').count(), 0)
      assert.ok(!(await dialog().textContent()).includes('The streamed fixture received the reviewed evidence.'))
      assert.equal((await stats()).approvals, beforeStream.approvals + 1)
      await app.evaluate(() => globalThis.ionExplanationFixture.finishStream())
      const answer = dialog().getByTestId('explanation-answer')
      await answer.getByText('The streamed fixture received the reviewed evidence.', { exact: true }).waitFor()
      const streamReply = await reply(), afterStream = await stats()
      assert.equal(streamReply.sections[0].citations[0].sourceId, streamReview.sources[0].id)
      assert.notEqual(streamReply.token, streamReview.token)
      const streamedBody = await app.evaluate(() => globalThis.ionExplanationFixture.lastBody)
      assert.equal(Buffer.byteLength(streamedBody), streamReview.bodyBytes)
      const streamEnvelope = JSON.parse(streamedBody)
      assert.equal(streamEnvelope.stream, true)
      assert.equal(streamEnvelope.store, false)
      assert.deepEqual(JSON.parse(streamEnvelope.messages[1].content).sources, streamReview.sources)
      assert.ok(!streamedBody.includes(credential) && !streamedBody.includes('PRIVATE_SYNTHETIC_NOT_SELECTED'))
      await assert.rejects(page.evaluate(token => window.ion.explanations.send(token), streamReview.token))
      assert.equal(afterStream.streams, beforeStream.streams + 1)
      assert.equal((await stats()).calls, beforeStream.calls + 1)
      await mode('success')
      await closeDialog()
      report.checks.optInStreamedLessonConsentPrivacyAndValidatedAnswer = 'passed'

      phase = 'read-only-code-actions-require-selected-excerpt'
      for (const [action, prompt] of [
        ['explain-file', 'control/data flow'], ['find-bug', 'likely bugs'], ['design-tests', 'test cases'],
      ]) {
        const before = await stats()
        await openTutor()
        await dialog().getByLabel('Action').selectOption(action)
        const codeContext = dialog().getByRole('checkbox', { name: /^Current unsaved code:/ })
        assert.equal(await codeContext.isChecked(), false, 'Code remains unchecked until the user opts in for each action.')
        assert.equal(await dialog().getByTestId('explanation-review').isDisabled(), true,
          'The request cannot be reviewed until a nonempty code excerpt is selected.')
        await codeContext.check()
        const actionReview = await review()
        assert.equal(actionReview.action, action)
        assert.deepEqual(actionReview.sources.map(item => item.origin), ['editor-buffer'])
        assert.equal(before.calls, (await stats()).calls, 'Review never sends source to the provider.')
        await send()
        const body = await app.evaluate(() => globalThis.ionExplanationFixture.lastBody)
        const envelope = JSON.parse(body), input = JSON.parse(envelope.messages[1].content)
        assert.equal(input.action, action)
        assert.deepEqual(input.sources, actionReview.sources)
        assert.ok(envelope.messages[0].content.includes(prompt), 'The selected action must use its dedicated evidence-bound guidance.')
        assert.ok(!body.includes(credential))
        assert.equal(await readFile(source, 'utf8'), original)
        await closeDialog()
      }
      report.checks.readOnlyCodeActionsRequireSelectedExcerpt = 'passed'

      phase = 'explicit-lesson-buffer-and-revision-invalidation'
      await editor('append')
      const userBuffer = await editor('read')
      await openTutor()
      await dialog().getByRole('checkbox', { name: /^Installed lesson:/ }).check()
      await dialog().getByRole('checkbox', { name: /^Current unsaved code:/ }).check()
      const bufferReview = await review()
      assert.deepEqual(bufferReview.sources.map(item => item.origin), ['lesson', 'editor-buffer'])
      assert.equal(bufferReview.sources[1].text, userBuffer)
      assert.equal(await readFile(source, 'utf8'), original)
      assert.ok(bufferReview.exclusions.some(value => value.includes('unverified')))
      const callsBeforeEdit = (await stats()).calls
      await editor('append')
      await dialog().getByTestId('explanation-review-content').waitFor({ state: 'detached' })
      await assert.rejects(page.evaluate(token => window.ion.explanations.send(token), bufferReview.token))
      assert.equal((await stats()).calls, callsBeforeEdit)
      await closeDialog()
      await page.getByTestId('editor').locator('.view-line').first().click()
      await page.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+z')
      assert.equal(await editor('read'), userBuffer)
      assert.equal(await page.getByTestId('editor').getAttribute('data-explanation-instance'), 'preserve-this-editor')
      report.checks.installedLessonUnsavedBufferUndoAndInvalidation = 'passed'

      phase = 'ask-ion-question-and-optional-editor-excerpt'
      await assert.rejects(page.evaluate(() => window.ion.explanations.provider('ask')))
      await page.getByRole('button', { name: 'Code', exact: true }).click()
      const openAsk = async () => {
        await page.getByTestId('command-palette').click()
        await page.getByTestId('command-palette-input').fill('Ask Ion')
        await page.getByRole('option', { name: 'Ask Ion…', exact: true }).click()
        await dialog().waitFor()
        await page.getByRole('dialog', { name: 'Ask Ion', exact: true }).waitFor()
      }
      const beforeAsk = await stats()
      await openAsk()
      const excerpt = dialog().getByRole('checkbox', { name: /^Editor excerpt:/ })
      assert.equal(await excerpt.isChecked(), false)
      assert.equal(await dialog().getByTestId('explanation-review').isDisabled(), true)
      const askOnly = await review()
      assert.equal(askOnly.purpose, 'ask')
      assert.equal(askOnly.action, 'ask-question')
      assert.deepEqual(askOnly.sources, [])
      assert.equal((await stats()).calls, beforeAsk.calls)
      await send()
      const askBody = await app.evaluate(() => globalThis.ionExplanationFixture.lastBody)
      assert.deepEqual(JSON.parse(JSON.parse(askBody).messages[1].content).sources, [])
      assert.ok(!askBody.includes(credential) && !askBody.includes('pending user edit'))
      await closeDialog()
      await openAsk()
      await excerpt.check()
      const askWithCode = await review()
      assert.deepEqual(askWithCode.sources.map(item => item.origin), ['editor-buffer'])
      assert.equal(askWithCode.sources[0].text, userBuffer)
      await send()
      const excerptBody = await app.evaluate(() => globalThis.ionExplanationFixture.lastBody)
      assert.deepEqual(JSON.parse(JSON.parse(excerptBody).messages[1].content).sources, askWithCode.sources)
      assert.ok(!excerptBody.includes(credential) && !excerptBody.includes(root))
      assert.equal((await stats()).calls, beforeAsk.calls + 2)
      assert.equal((await stats()).approvals, beforeAsk.approvals + 2)
      assert.equal(await readFile(source, 'utf8'), original)
      assert.equal(await editor('read'), userBuffer)
      await closeDialog()
      report.checks.askIonExplicitScopeAndReadOnlyAnswer = 'passed'

      phase = 'actual-project-snapshot-and-selected-prefix'
      await page.getByTestId('navigate-projects').click()
      const initialProject = { version: 1, title: 'Existing verified local plan', description: 'Keep all existing local work.',
        goal: 'Preserve old milestones and tests while reviewing new drafts.', technologies: [], files: [], environment: [],
        milestones: [{ id: 'old-work', title: 'Existing manual progress', description: 'Original milestone.',
          acceptance: ['Original acceptance requirement.'], dependsOn: [], status: 'manually-completed' }],
        tests: [{ id: 'old-test', milestoneId: 'old-work', title: 'Existing test definition', source: 'main.c',
          stdin: '', expectedOutput: '', match: 'exact', exitCode: 0 }] }
      const initialRecord = await page.evaluate(({ root, spec }) => window.ion.projects.save(root, spec, null), { root, spec: initialProject })
      await page.getByTestId('project-view-lens').click()
      const lens = page.getByTestId('project-lens')
      await resourceStage('lens-before-analysis')
      await lens.getByTestId('project-lens-analyze').click()
      await lens.getByTestId('project-lens-summary').waitFor()
      await resourceStage('lens-after-analysis')
      await lens.getByLabel('Add project source evidence').selectOption('src/evidence.py')
      const openProject = async () => {
        await lens.getByTestId('project-lens-explain').click(); await dialog().waitFor()
      }
      await openProject()
      await dialog().getByRole('checkbox', { name: 'Bounded offline project structure', exact: true }).check()
      await dialog().getByRole('checkbox', { name: 'src/evidence.py', exact: true }).check()
      const projectReview = await review()
      await resourceStage('project-selected-evidence-review')
      const savedSource = projectReview.sources.find(item => item.origin === 'saved-file')
      assert.equal(savedSource.text, evidenceText)
      assert.equal(savedSource.label, 'src/evidence.py')
      assert.ok(projectReview.sources.some(item => item.origin === 'structure'))
      const structureSource = projectReview.sources.find(item => item.origin === 'structure')
      assert.ok(Buffer.byteLength(structureSource.text) <= 8192)
      const structureSummary = JSON.parse(structureSource.text)
      assert.ok(structureSummary.files.some(file => file.path === 'src/evidence.py'))
      assert.ok(structureSummary.manifests.some(manifest => manifest.path === 'package.json'))
      assert.equal(projectReview.sources.some(item => item.text.includes('PRIVATE_SYNTHETIC_NOT_SELECTED')), false)
      const projectReply = await send()
      await resourceStage('project-selected-evidence-reply')
      const payload = await app.evaluate(() => globalThis.ionExplanationFixture.lastBody)
      assert.equal(Buffer.byteLength(payload), projectReview.bodyBytes)
      assert.deepEqual(JSON.parse(JSON.parse(payload).messages[1].content).sources, projectReview.sources)
      const citation = projectReply.sections[0].citations[0]
      await assert.rejects(page.evaluate(({ token, sourceId }) => window.ion.explanations.openCitation(token, sourceId,
        { startLine: 1, endLine: 999999 }), { token: projectReply.token, sourceId: citation.sourceId }))
      assert.equal(await readFile(source, 'utf8'), original)
      report.checks.mainVerifiedSelectedStructureAndSource = 'passed'
      await dialog().getByRole('button', { name: 'Source ' + citation.sourceId + ' · ' + citation.startLine + '–' + citation.endLine, exact: true }).click()
      await dialog().waitFor({ state: 'detached' })
      await atPath(page, 'tab', evidenceFile).waitFor()
      await editorShows(page, 'fixture_value')
      await atPath(page, 'tab', source).locator('.tab-name').click()
      await editorShows(page, 'pending user edit')
      assert.equal(await editor('read'), userBuffer)
      report.checks.actualCitationNavigationPreservesUnsavedEditor = 'passed'
      await openProject()
      await dialog().getByRole('checkbox', { name: 'Bounded offline project structure', exact: true }).check()
      await dialog().getByRole('checkbox', { name: 'src/evidence.py', exact: true }).check()
      await review(); await send()

      phase = 'reviewed-recommendation-persistence'
      await dialog().getByRole('button', { name: 'Review suggested milestones', exact: true }).click()
      const proposals = page.getByTestId('recommendation-review')
      await proposals.waitFor()
      phase = 'recommendation-select-and-edit'
      await proposals.getByRole('checkbox', { name: 'Add this milestone', exact: true }).check()
      await proposals.getByLabel('Title', { exact: true }).fill('User-reviewed improvement')
      await proposals.getByLabel('Description', { exact: true }).fill('Explain two cases after independent review.')
      await proposals.getByLabel('Acceptance criteria (one per line)', { exact: true }).fill('Explain two representative inputs.')
      phase = 'recommendation-save-reviewed-draft'
      await proposals.getByTestId('recommendation-save').click()
      await proposals.waitFor({ state: 'detached' })
      phase = 'recommendation-verify-saved-record'
      const merged = await page.evaluate(root => window.ion.projects.open(root), root)
      assert.deepEqual(merged.spec.milestones[0], initialRecord.spec.milestones[0])
      assert.deepEqual(merged.spec.tests, initialRecord.spec.tests)
      assert.deepEqual(merged.approved, initialRecord.approved)
      assert.deepEqual(merged.evidence, initialRecord.evidence)
      assert.equal(merged.spec.milestones[1].title, 'User-reviewed improvement')
      assert.equal(merged.spec.milestones[1].status, 'not-started')
      assert.match(merged.spec.milestones[1].description, /Reviewed context \(not verification\)/)
      assert.equal((await stats()).projectActions, 0)
      report.checks.recommendationSavePreservesExistingWorkAndNeverRuns = 'passed'

      phase = 'roadmap-conflict-preserves-proposal-draft'
      await openProject()
      await review(); await send()
      await dialog().getByRole('button', { name: 'Review suggested milestones', exact: true }).click()
      await proposals.waitFor()
      await proposals.getByRole('checkbox', { name: 'Add this milestone', exact: true }).check()
      await proposals.getByLabel('Title', { exact: true }).fill('Preserve this conflict draft')
      const concurrent = await page.evaluate(async root => {
        const record = await window.ion.projects.open(root)
        return window.ion.projects.save(root, { ...record.spec, title: 'Concurrent local record edit' }, record.revision)
      }, root)
      await proposals.getByTestId('recommendation-save').click()
      await proposals.getByRole('alert').filter({ hasText: /changed|Reload|reload/ }).waitFor()
      assert.equal(await proposals.getByLabel('Title', { exact: true }).inputValue(), 'Preserve this conflict draft')
      const untouched = await page.evaluate(root => window.ion.projects.open(root), root)
      assert.equal(untouched.revision, concurrent.revision)
      assert.equal(untouched.spec.milestones.length, 2)
      await proposals.getByRole('button', { name: 'Reload current roadmap', exact: true }).click()
      await eventually(() => proposals.getByRole('button', { name: 'Reload current roadmap', exact: true }).isEnabled(), 'Actual roadmap reload did not finish.')
      assert.equal(await proposals.getByLabel('Title', { exact: true }).inputValue(), 'Preserve this conflict draft')
      await proposals.getByTestId('recommendation-save').click()
      await proposals.waitFor({ state: 'detached' })
      const resolved = await page.evaluate(root => window.ion.projects.open(root), root)
      assert.equal(resolved.spec.title, 'Concurrent local record edit')
      assert.equal(resolved.spec.milestones.length, 3)
      assert.equal(resolved.spec.milestones[2].title, 'Preserve this conflict draft')
      assert.equal(resolved.spec.milestones[2].status, 'not-started')
      assert.deepEqual(resolved.spec.tests, initialRecord.spec.tests)
      assert.deepEqual(resolved.evidence, initialRecord.evidence)
      assert.deepEqual(resolved.approved, initialRecord.approved)
      assert.equal((await stats()).projectActions, 0)
      report.checks.recommendationConflictReloadPreservesDraft = 'passed'

      phase = 'stale-saved-source-rejected'
      await openProject()
      await dialog().getByRole('checkbox', { name: 'Bounded offline project structure', exact: true }).check()
      await dialog().getByRole('checkbox', { name: 'src/evidence.py', exact: true }).check()
      const staleReview = await review(), beforeStale = (await stats()).calls
      await writeFile(evidenceFile, evidenceText + '# external modification\n')
      await assert.rejects(page.evaluate(token => window.ion.explanations.send(token), staleReview.token))
      assert.equal((await stats()).calls, beforeStale)
      report.checks.externalSourceChangePreventsSend = 'passed'
      await closeDialog()

      // Refresh the actual metadata snapshot after the intentional external edit.
      await lens.getByTestId('project-lens-analyze').click()
      await lens.getByTestId('project-lens-summary').waitFor()
      phase = 'provider-failures-and-invalid-citations'
      for (const transportMode of ['http-error', 'invalid-citation']) {
        await mode(transportMode)
        await openProject()
        // Question-only invalid-citation needs evidence to exercise strict source validation.
        if (transportMode === 'invalid-citation') await dialog().getByRole('checkbox', { name: 'Bounded offline project structure', exact: true }).check()
        await review()
        await dialog().getByTestId('explanation-send').click()
        await dialog().locator('.explanation-status').filter({ hasText: /request failed|context changed/ }).waitFor()
        assert.equal(await dialog().getByTestId('explanation-answer').count(), 0)
        assert.equal((await dialog().textContent()).includes('provider-body-must-not-be-rendered'), false)
        await closeDialog()
      }
      report.checks.providerFailureAndCitationValidation = 'passed'

      phase = 'pending-cancel-and-unmount'
      await mode('hold')
      for (const closePane of [false, true]) {
        await openProject(); await review()
        await dialog().getByTestId('explanation-send').click()
        await eventually(async () => (await stats()).waiting, 'Synthetic held request was not observed.')
        if (closePane) await closeDialog()
        else await dialog().getByRole('button', { name: 'Cancel request', exact: true }).click()
        await eventually(async () => { const value = await stats(); return value.active === 0 && value.sendsActive === 0 },
          'The actual explanation operation did not unwind after cancellation.')
        if (!closePane) await closeDialog()
      }
      report.checks.pendingCancellationAndUnmountCleanup = 'passed'
      assert.equal(await page.getByTestId('editor').getAttribute('data-explanation-instance'), 'preserve-this-editor')
      assert.equal(await editor('read'), userBuffer)
      report.sourceIntegrity = { savedBefore: hash(original), savedAfter: hash(await readFile(source)),
        editorMatchesPreRequestUnsavedState: true }
      assert.equal(report.sourceIntegrity.savedBefore, report.sourceIntegrity.savedAfter)
      assert.equal((await stats()).unexpected, 0)
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])

      if (values['measure-resources']) {
        phase = 'optional-resource-repeat-cycles'
        await mode('success')
        // A fresh Analyze cleared the UI's selected references earlier. This
        // explicit source selection is reused in each reviewed request below.
        await lens.getByLabel('Add project source evidence').selectOption('src/evidence.py')
        const beforeCycles = await resourceStage('cycle-baseline-dialog-closed')
        report.resources.cycleSamples = []
        for (let cycle = 1; cycle <= 20; cycle++) {
          resourceBudget(45_000)
          phase = 'optional-resource-cycle-' + cycle
          const sample = { cycle, complete: false }
          report.resources.cycleSamples.push(sample)
          await persist()
          const began = performance.now(), before = await stats()
          await openProject()
          await dialog().getByRole('checkbox', { name: 'Bounded offline project structure', exact: true }).check()
          await dialog().getByRole('checkbox', { name: 'src/evidence.py', exact: true }).check()
          const prepared = await review()
          assert.ok(prepared.sources.some(source => source.origin === 'saved-file'))
          await send(); await closeDialog()
          const after = await stats()
          assert.equal(after.calls, before.calls + 1)
          assert.equal(after.approvals, before.approvals + 1)
          assert.equal(after.active, 0); assert.equal(after.sendsActive, 0)
          sample.elapsedMs = performance.now() - began
          sample.complete = true; report.resources.cycles = cycle
          await persist()
          if (cycle % 5 === 0) {
            const checkpoint = await resourceStage('cycles-' + cycle + '-dialog-closed', { cycle })
            assert.equal(checkpoint.ui.modelCount, beforeCycles.ui.modelCount,
              'Repeated AI dialogs must not create additional Monaco models.')
            assert.equal(checkpoint.ui.editorCount, beforeCycles.ui.editorCount)
            assert.ok(checkpoint.last.members.filter(member => member.kind === 'child')
              .every(member => baselineChildren.has(member.pid + ':' + member.startedMs)),
            'Optional explanations left an unexpected native child process.')
          }
        }
        phase = 'optional-resource-code-recovery'
        await page.getByRole('button', { name: 'Code', exact: true }).click()
        await page.getByTestId('projects-panel').waitFor({ state: 'detached' })
        const closedAt = performance.now()
        await resourceStage('optional-panels-closed-code', { sinceCloseMs: performance.now() - closedAt })
        for (const seconds of [20, 60]) {
          const remaining = Math.max(0, seconds * 1000 - (performance.now() - closedAt))
          resourceBudget(remaining + 45_000)
          if (remaining) await sleep(remaining)
          await resourceStage('optional-panels-closed-' + seconds + 's', { sinceCloseMs: performance.now() - closedAt })
        }
        const final = await stats()
        assert.equal(final.active, 0); assert.equal(final.sendsActive, 0)
        report.resources.profileElapsedMs = performance.now() - resourceStarted
        // Restore the existing fixture's explicit final shutdown scenario.
        await page.getByTestId('navigate-projects').click()
        await page.getByTestId('project-view-lens').click()
        await lens.getByTestId('project-lens-analyze').click()
        await lens.getByTestId('project-lens-summary').waitFor()
        await mode('hold')
      }

      phase = 'pending-request-window-shutdown'
      await openProject(); await review()
      await dialog().getByTestId('explanation-send').click()
      await eventually(async () => (await stats()).waiting, 'Final held request was not observed.')
      report.observations = await stats()
      // The final shutdown itself must abort the request and await its finally.
      // Source buffers are retained via the application's actual recovery flow.
      }
      const running = workflow()
      await (resourceDeadline ? Promise.race([running, resourceDeadline]) : running)
    } catch (error) {
      failure = error
      // Capture the original failure before cleanup can throw its own error.
      report.failure = failureLocation(error, phase)
      if (session && !session.page.isClosed()) {
        report.failureUi = await session.page.evaluate(() => {
          const proposal = document.querySelector('[data-testid="recommendation-review"]')
          const save = proposal?.querySelector('[data-testid="recommendation-save"]')
          const categories = [...document.querySelectorAll('[role="alert"]')].slice(0, 8).map(node => {
            const text = node.textContent ?? ''
            return /changed|reload/i.test(text) ? 'conflict' : /limit|maximum|within|exceed/i.test(text) ? 'limit'
              : /prerequisite|dependenc|cycle/i.test(text) ? 'dependency' : /citation|source|excerpt/i.test(text) ? 'citation'
                : /invalid|review|criteria/i.test(text) ? 'validation' : 'other'
          })
          return { aiDialogCount: document.querySelectorAll('[data-testid="explanation-dialog"]').length,
            proposalCount: proposal ? 1 : 0, proposalSaveDisabled: save instanceof HTMLButtonElement ? save.disabled : null,
            selectedMilestones: proposal?.querySelectorAll('input[type="checkbox"]:checked').length ?? 0,
            dialogCount: document.querySelectorAll('[role="dialog"]').length, alertCategories: categories }
        }).catch(() => ({ unavailable: true }))
      }
      await persist()
      throw error
    }
    finally {
      clearTimeout(resourceTimer)
      if (session) {
        // Failure-only recovery of disposable UI state. Preserve the primary
        // error while releasing AI requests and unsaved proposal selections.
        if (failure && !session.page.isClosed()) {
          try {
            let cancellationTimer
            try {
              await Promise.race([session.page.evaluate(() => window.ion.explanations.cancel()), new Promise((_, reject) => {
                cancellationTimer = setTimeout(() => reject(new Error('Disposable AI cancellation did not drain within the existing eight-second fixture limit.')), 8000)
              })])
            } finally { clearTimeout(cancellationTimer) }
            const ai = session.page.getByRole('dialog').filter({ has: dialog() })
            if (await dialog().count()) {
              await ai.getByRole('button', { name: 'Close dialog', exact: true }).click()
              await dialog().waitFor({ state: 'detached' })
            }
            const proposals = session.page.getByTestId('recommendation-review')
            if (await proposals.count()) {
              await proposals.getByRole('button', { name: 'Cancel', exact: true }).click()
              await eventually(async () => !await proposals.count()
                || await proposals.getByRole('button', { name: 'Discard proposals', exact: true }).isVisible(),
              'Disposable proposal did not close or request explicit discard.')
              if (await proposals.count()) await proposals.getByRole('button', { name: 'Discard proposals', exact: true }).click()
              await proposals.waitFor({ state: 'detached' })
            }
          } catch (cleanupError) {
            report.failureUiCleanup = failureLocation(cleanupError, 'failure-ui-cleanup')
            await persist()
          }
        }
        const closing = close(session)
        const keep = session.page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
          .getByRole('button', { name: 'Keep Drafts and Quit', exact: true })
        await Promise.race([closing.then(() => false, () => false), keep.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)])
          .then(async visible => { if (visible) await keep.click() })
        try {
          await closing
          assert.equal(session.appProcess.exitCode, 0)
          assert.equal(session.appProcess.signalCode, null)
          const exited = JSON.parse(await readFile(exitReceipt, 'utf8'))
          assert.equal(exited.active, 0); assert.equal(exited.sendsActive, 0); assert.equal(exited.unexpected, 0)
          report.exit = exited; report.cleanupVerified = true
          if (values['measure-resources']) {
            const family = await processTree(session)
            report.resources.postShutdownMembers = family.members.map(member => ({ pid: member.pid,
              startedMs: member.startedMs, kind: member.kind }))
            assert.equal(family.members.length, 0, 'Owned application processes remained after verified shutdown.')
            report.resources.processCleanupVerified = true
            report.resources.complete = !failure && report.resources.cycles === 20
          }
          if (!failure) report.checks.pendingRequestShutdownDrain = 'passed'
        } catch (cleanupError) {
          report.cleanupVerified = false
          report.cleanupFailure = failureLocation(cleanupError, 'application-cleanup')
          await persist()
          if (!failure) throw cleanupError
        }
      }
    }
    report.complete = true
  })
} catch (error) {
  // Never dump provider bodies, credentials, source text or disposable paths.
  report.complete = false; report.failure ??= failureLocation(error, phase)
  await persist()
  throw new Error('Native explanation verification failed during ' + phase + '. Sanitized receipt: ' + output)
}
await persist()
console.log(output)
