import { dialog, safeStorage, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ProjectRecord, ProjectTest } from '../../shared/projects'
import { isWithin, maxFileBytes, revision, type WorkspaceFiles } from '../files'
import type { CRunner } from '../runner'
import { isSelfContainedC, maxAutomaticSourceBytes, SavedTestQueue, type SavedTestSource } from './automatic'
import { judgeTest, unavailableTest } from './evidence'
import { ProviderVault, requestProject } from './provider'
import { ProjectRepository, type SavedProject } from './repository'
import { boundedText } from './spec'

interface ProjectOptions {
  profile(): string
  files(): WorkspaceFiles
  runner: CRunner
  isCurrent(target: BrowserWindow): boolean
  isBusy(): boolean
  isFull(): boolean
}

interface AutomaticPermission {
  source: string
  definition: string
  controller: AbortController
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

function testSummary(test: ProjectTest): string {
  return [
    'Compile and run: ' + test.source, 'Working directory: ' + dirname(test.source),
    'Standard input: ' + (test.stdin ? JSON.stringify(test.stdin) : '(empty)'),
    'Expected standard output (' + test.match + '): ' + JSON.stringify(test.expectedOutput),
    'Expected exit code: ' + test.exitCode,
  ].join('\n')
}

export function createProjectHandlers({ profile, files, runner, isCurrent, isBusy, isFull }: ProjectOptions) {
  const store = new ProjectRepository(join(profile(), 'projects-v1'))
  const providerVault = new ProviderVault(join(profile(), 'planning-provider-v1.json'), {
    async available() {
      if (!await safeStorage.isAsyncEncryptionAvailable()) return false
      return process.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend())
    },
    encrypt: value => safeStorage.encryptStringAsync(value),
    async decrypt(value) {
      const result = await safeStorage.decryptStringAsync(value)
      if (result.shouldReEncrypt) return (await safeStorage.decryptStringAsync(value)).result
      return result.result
    },
  })
  let opened: { target: BrowserWindow; path: string } | null = null
  let panelRevision = 0
  let running = false
  let online: AbortController | null = null
  let approval: AbortController | null = null
  const automatic = new Map<string, AutomaticPermission>()
  const savedTests = new SavedTestQueue(runAutomatic)

  function revoke(id: string): void {
    const permission = automatic.get(id)
    if (!permission) return
    permission.controller.abort()
    automatic.delete(id)
    if (![...automatic.values()].some(other => other.source === permission.source)) savedTests.remove(permission.source)
  }

  function releaseAutomatic(): void {
    approval?.abort()
    savedTests.clear()
    for (const id of automatic.keys()) revoke(id)
  }

  function close(): void {
    ++panelRevision
    opened = null
    online?.abort()
    releaseAutomatic()
  }

  function announce(path: string): void {
    if (opened && isCurrent(opened.target) && isWithin(opened.path, path)) {
      opened.target.webContents.send('ion:projects-source-saved', path)
    }
  }

  function reconcile(path: string, record: SavedProject): void {
    if (opened?.path !== path) return
    for (const [id, permission] of automatic) {
      const test = record.spec.tests.find(candidate => candidate.id === id)
      if (!test || !record.approved.includes(id) || JSON.stringify(test) !== permission.definition) revoke(id)
    }
  }

  async function runAutomatic(path: string, expected: SavedTestSource, signal: AbortSignal): Promise<void> {
    const panel = opened
    if (signal.aborted || !panel || !isFull() || running || runner.busy || isBusy()) return
    const scope = files()
    const savedRevision = expected.revision
    const current = await scope.inspect(path, 'file')
    if (signal.aborted || current.stats.size > BigInt(maxAutomaticSourceBytes) || revision(current.stats) !== savedRevision) return
    const saved = await scope.read(path)
    if (saved.revision !== savedRevision || !isSelfContainedC(saved.text) || digest(saved.text) !== expected.digest) return
    for (const [id, permission] of automatic) {
      if (permission.source !== path) continue
      const runSignal = AbortSignal.any([signal, permission.controller.signal])
      const active = () => !runSignal.aborted && isFull() && opened === panel && isCurrent(panel.target)
        && automatic.get(id) === permission && !running && !isBusy()
      if (!active() || runner.busy) continue
      const record = await store.read(panel.path)
      const test = record?.spec.tests.find(candidate => candidate.id === id)
      if (!record || !test || !record.approved.includes(id) || JSON.stringify(test) !== permission.definition) continue
      const stillCurrent = async () => {
        if (!active()) return false
        const [checked, latest] = await Promise.all([
          source(scope, panel.path, test).catch(() => undefined),
          store.read(panel.path).catch(() => undefined),
        ])
        return active() && checked?.path === path && checked.revision === savedRevision && latest?.revision === record.revision
      }
      if (!await stillCurrent()) continue
      const result = await runner.runSavedSnapshot(path, saved.text, test.stdin, stillCurrent, runSignal)
      if (result.status === 'cancelled') break
      if (result.status === 'rejected' || !await stillCurrent()) continue
      await store.evidence(panel.path, judgeTest(test, result, savedRevision), record.revision)
      announce(path)
    }
  }

  async function selected(target: BrowserWindow, root: unknown): Promise<string> {
    const { path } = await files().inspect(root, 'folder')
    if (!isCurrent(target)) throw new Error('The project window closed.')
    return path
  }

  async function testFor(path: string, testId: unknown, token: unknown): Promise<{ record: SavedProject; test: ProjectTest }> {
    const record = await store.read(path)
    if (!record || record.revision !== token) throw new Error('The saved project changed. Reload it and try again.')
    const test = record.spec.tests.find(item => item.id === testId)
    if (!test) throw new Error('The selected test is no longer in the project.')
    return { record, test }
  }

  async function source(scope: WorkspaceFiles, root: string, test: ProjectTest) {
    const source = join(root, test.source)
    if (!isWithin(root, source)) throw new Error('Test source must stay inside its project.')
    const inspected = await scope.inspect(source, 'file')
    if (inspected.stats.size > BigInt(maxFileBytes)) throw new Error('Test source exceeds the C runner file limit.')
    return { path: inspected.path, revision: revision(inspected.stats), size: Number(inspected.stats.size) }
  }

  async function view(path: string, record: SavedProject): Promise<ProjectRecord> {
    const scope = files()
    const current = new Map<string, Promise<string | undefined>>()
    const tests = new Map(record.spec.tests.map(test => [test.id, test]))
    const evidence = await Promise.all(record.evidence.map(async ({ sourceRevision, ...item }) => {
      const test = tests.get(item.testId)
      if (!test) return { ...item, stale: true }
      let checked = current.get(test.source)
      if (!checked) {
        checked = source(scope, path, test).then(result => result.revision, () => undefined)
        current.set(test.source, checked)
      }
      const latest = await checked
      return { ...item, stale: sourceRevision === null ? latest !== undefined : latest !== sourceRevision }
    }))
    const automaticTests = isFull() && opened?.path === path ? [...automatic.keys()] : []
    return { ...record, evidence, automatic: automaticTests }
  }

  return {
    async setActive(target: BrowserWindow, root: unknown) {
      if (root === null) {
        close()
        return
      }
      if (opened?.target === target && opened.path === root) return
      close()
      const expected = panelRevision
      const path = await selected(target, root)
      if (expected === panelRevision && isCurrent(target)) opened = { target, path }
    },
    async open(target: BrowserWindow, root: unknown) {
      const path = await selected(target, root)
      const record = await store.read(path)
      if (record) reconcile(path, record)
      return record && view(path, record)
    },
    async save(target: BrowserWindow, root: unknown, value: unknown, token: unknown) {
      const path = await selected(target, root)
      const record = await store.save(path, value, token)
      reconcile(path, record)
      return view(path, record)
    },
    async approve(target: BrowserWindow, root: unknown, testId: unknown, token: unknown) {
      const path = await selected(target, root)
      const { record, test } = await testFor(path, testId, token)
      const answer = await dialog.showMessageBox(target, {
        type: 'question', buttons: ['Cancel', 'Approve Test'], cancelId: 0, defaultId: 0,
        message: 'Approve this local behavior test?',
        detail: testSummary(test) + '\n\nThis approves the test definition. Running it still needs your consent. Changing the test clears approval.',
      })
      if (!isCurrent(target) || answer.response !== 1) return view(path, record)
      await selected(target, root)
      return view(path, await store.approve(path, test, token))
    },
    async setAutomatic(target: BrowserWindow, root: unknown, testId: unknown, token: unknown, enabled: unknown) {
      if (typeof enabled !== 'boolean') throw new Error('Invalid automatic-test setting.')
      const path = await selected(target, root)
      const panel = opened
      if (!panel || panel.target !== target || panel.path !== path || !isFull()) {
        throw new Error('Open Projects in Full mode to change automatic tests.')
      }
      const { record, test } = await testFor(path, testId, token)
      if (!enabled) {
        revoke(test.id)
        return view(path, record)
      }
      if (!record.approved.includes(test.id)) throw new Error('Review and approve the test before enabling automatic runs.')
      if (automatic.has(test.id)) return view(path, record)
      const scope = files()
      const selectedSource = await source(scope, path, test)
      if (selectedSource.size > maxAutomaticSourceBytes) throw new Error('Automatic tests support C files up to 128 KiB.')
      const before = await scope.read(selectedSource.path)
      if (before.revision !== selectedSource.revision || !isSelfContainedC(before.text)) {
        throw new Error('Automatic tests require a self-contained C17 file with standard angle-bracket headers only. Use Run Test for other sources.')
      }
      if (opened !== panel || !isFull() || !isCurrent(target)) return view(path, record)
      if (approval) throw new Error('An automatic test approval is already open.')
      const controller = new AbortController()
      approval = controller
      try {
        const answer = await dialog.showMessageBox(target, {
          type: 'warning', buttons: ['Cancel', 'Enable Automatic Test'], cancelId: 0, defaultId: 0, signal: controller.signal,
          message: 'Run this approved test automatically on Ion saves?',
          detail: testSummary(test) + '\n\nIon will compile and run future saves of this C file without asking again while Projects is open in Full mode. Programs run with your OS permissions. Enable only if you trust the source and your future edits. External edits and unsupported C sources do not trigger a run.',
        })
        if (controller.signal.aborted || answer.response !== 1 || opened !== panel || !isFull() || !isCurrent(target)) {
          return view(path, record)
        }
        const after = await source(scope, path, test)
        if (after.revision !== before.revision) throw new Error('The source changed. Review it and enable the automatic test again.')
        const latest = await testFor(path, testId, token)
        if (controller.signal.aborted || opened !== panel || !isFull() || !isCurrent(target)) return view(path, latest.record)
        automatic.set(test.id, {
          source: selectedSource.path, definition: JSON.stringify(test), controller: new AbortController(),
        })
        return view(path, latest.record)
      } finally {
        if (approval === controller) approval = null
      }
    },
    async run(target: BrowserWindow, root: unknown, testId: unknown, token: unknown) {
      if (running || runner.busy || isBusy()) throw new Error('A program or test is already compiling or running.')
      running = true
      try {
        const path = await selected(target, root)
        const { record, test } = await testFor(path, testId, token)
        if (!record.approved.includes(test.id)) throw new Error('Review and approve the test before running it.')
        const scope = files()
        let saved: { path: string; revision: string }
        try {
          saved = await source(scope, path, test)
        } catch {
          const evidence = unavailableTest(test, 'The source is missing, inaccessible, too large, or outside the project. Check the test configuration.')
          return view(path, await store.evidence(path, evidence, token))
        }
        const answer = await dialog.showMessageBox(target, {
          type: 'warning', buttons: ['Cancel', 'Run Test'], cancelId: 0, defaultId: 0,
          message: 'Run the approved test against your saved code?',
          detail: testSummary(test) + '\n\nOnly run code you trust. The program runs with your OS permissions. Time and output limits apply.',
        })
        if (!isCurrent(target) || answer.response !== 1) return view(path, record)
        await selected(target, root)
        if (runner.busy || isBusy()) throw new Error('A program or test is already compiling or running.')
        await testFor(path, testId, token)
        const sourceStillCurrent = async () => {
          if (!isCurrent(target)) return false
          const checked = await source(scope, path, test).catch(() => undefined)
          return checked?.revision === saved.revision
        }
        if (!await sourceStillCurrent()) throw new Error('The source changed. Review it and run the test again.')
        const result = await runner.run(saved.path, test.stdin, sourceStillCurrent)
        return view(path, await store.evidence(path, judgeTest(test, result, saved.revision), token))
      } finally {
        running = false
      }
    },
    async provider(_target: BrowserWindow) {
      return providerVault.get()
    },
    async configure(_target: BrowserWindow, value: unknown) {
      if (!isFull()) throw new Error('Online planning is available in Full mode.')
      if (online) throw new Error('Wait for the planning request to finish before changing provider settings.')
      return providerVault.update(value)
    },
    async propose(target: BrowserWindow, input: unknown) {
      if (!isFull() || opened?.target !== target) throw new Error('Open Projects in Full mode to plan online.')
      if (online) throw new Error('A planning request is already pending.')
      const goal = boundedText(input, 4000, 'Project description')
      const operation = new AbortController()
      online = operation
      try {
        const settings = await providerVault.get()
        if (!settings.hasKey || !settings.model) throw new Error('Configure a provider, model, and API key first.')
        if (!isCurrent(target) || operation.signal.aborted || !isFull()) return null
        const answer = await dialog.showMessageBox(target, {
          type: 'question', buttons: ['Cancel', 'Send Project Description'], defaultId: 0, cancelId: 0, signal: operation.signal,
          message: 'Send your project description online?',
          detail: `Provider: ${settings.endpoint}\nModel: ${settings.model}\n\n${goal}\n\nIon sends this description and planning instructions. You can review the proposed plan before saving it.`,
        })
        if (!isCurrent(target) || answer.response !== 1 || operation.signal.aborted || !isFull()) return null
        const provider = await providerVault.unlock(settings)
        if (!isCurrent(target) || operation.signal.aborted || !isFull()) return null
        return (await requestProject(provider, goal, operation.signal)).spec
      } finally {
        if (online === operation) online = null
      }
    },
    sourceSaved(path: string, savedRevision?: string, text?: unknown) {
      announce(path)
      if (!savedRevision) {
        for (const [id, permission] of automatic) if (isWithin(path, permission.source)) revoke(id)
        return
      }
      if (!isFull() || !opened || !isCurrent(opened.target)
        || ![...automatic.values()].some(permission => permission.source === path)) return
      if (typeof text !== 'string' || text.length > maxAutomaticSourceBytes) return savedTests.remove(path)
      savedTests.push(path, { revision: savedRevision, digest: digest(text) })
    },
    stopAutomatic() { savedTests.clear() },
    profileChanged() {
      if (isFull()) return
      online?.abort()
      releaseAutomatic()
    },
    close,
  }
}
