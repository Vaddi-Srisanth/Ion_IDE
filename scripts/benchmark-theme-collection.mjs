import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, editorShows, eventually, launch, openFolder, openFromExplorer,
  resourceSnapshot, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  out: { type: 'string' },
  switches: { type: 'string', default: '500' },
  sizes: { type: 'string', default: '5,20,50,100' },
  legacy: { type: 'boolean' },
  help: { type: 'boolean' },
  'profile-layers': { type: 'boolean' },
  'flatten-list': { type: 'boolean' },
  context: { type: 'string', default: 'editor' },
} })
if (values.help) {
  console.log('npm run bench:themes -- [--target dist] [--legacy] [--sizes 5,20,50,100] [--switches 500] [--context editor|terminal|lens] [--out report.json]')
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'This sampler uses macOS process accounting.')
assert.ok(['editor', 'terminal', 'lens'].includes(values.context))
const target = await artifact(values.target)
const sizes = values.sizes.split(',').map(Number)
const switchCount = Number(values.switches)
assert.ok(sizes.every((n) => Number.isInteger(n) && n > 0 && n <= 1000))
assert.ok(Number.isInteger(switchCount) && switchCount > 0 && switchCount <= 10000)
const mib = (n) => n / 2 ** 20
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const report = { target: values.target, context: values.context, switches: switchCount, installedCustomCounts: sizes,
  system: execFileSync('/usr/bin/sw_vers', { encoding: 'utf8' }).trim(),
  hardware: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string', 'hw.memsize'], { encoding: 'utf8' }).trim(),
  power: execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' }).split('\n')[0],
  mode: 'hidden production, offline; switch to two renderer frames; custom counts exclude built-ins', results: [] }

await withScratch('theme-collection', async (scratch) => {
  const probe = join(scratch, 'probe')
  execFileSync('/usr/bin/clang', ['-O2', 'scripts/benchmark-resources-probe.c', '-o', probe])
  const project = await createProject(join(scratch, 'fixture'), { fileCount: 2 })
  if (values.context === 'terminal') {
    const zsh = join(scratch, 'zsh')
    await mkdir(zsh)
    process.env.ZDOTDIR = zsh
  }
  const dark = JSON.parse(await readFile(join(target.path, 'main/themes/dark.json'), 'utf8'))
  const light = JSON.parse(await readFile(join(target.path, 'main/themes/light.json'), 'utf8'))
  const samples = async (session, cdp) => {
    const tree = await resourceSnapshot(session, { details: true })
    const records = execFileSync(probe, tree.members.map(({ pid }) => String(pid)), { encoding: 'utf8' })
      .trim().split('\n').map((line) => line.split(' ').map(Number))
    const gpu = tree.members.find(({ kind }) => kind === 'gpu-process')
    const heap = await cdp.send('Runtime.getHeapUsage')
    return { time: tree.timeMs, rssMiB: tree.rssMiB, heapMiB: mib(heap.usedSize),
      footprintMiB: mib(records.reduce((sum, [, bytes]) => sum + bytes, 0)),
      gpuFootprintMiB: mib(records.find(([pid]) => pid === gpu?.pid)?.[1] ?? 0),
      cpuNs: records.reduce((sum, [, , cpu]) => sum + cpu, 0),
      children: tree.members.filter(({ kind }) => kind === 'child').length }
  }
  for (const count of sizes) {
    const profile = join(scratch, 'profile-' + count)
    const themeDir = join(profile, 'themes')
    await mkdir(themeDir, { recursive: true })
    const registry = []
    for (let index = 0; index < count; index++) {
      const base = index % 2 === 0 ? dark : light
      const id = 'custom-00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0')
      const name = 'Fixture ' + (index + 1)
      registry.push({ id, name, appearance: base.appearance, source: 'custom' })
      await writeFile(join(themeDir, id + '.json'), JSON.stringify({ ...base, name }))
    }
    await writeFile(join(themeDir, 'registry.json'), JSON.stringify({ version: 1, themes: registry }))
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
      settings: { theme: 'dark', autoSave: false, openFullScreen: false, resourceProfile: 'minimal', showOutput: values.context === 'terminal' }, recents: [] }))
    const fresh = await launch(target, profile)
    const freshMs = fresh.startupMs
    await close(fresh)
    const session = await launch(target, profile)
    try {
      const { app, page } = session
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory, allowRun: values.context === 'lens' })
      const cdp = await page.context().newCDPSession(page)
      if (values.context === 'lens') {
        await page.getByTestId('workspace-learn').click()
        await page.getByTestId('learning-pane').waitFor()
        await page.getByTestId('toggle-marketplace').click()
        await page.locator('[data-testid="marketplace-install"][data-pack="c"]').click()
        await page.locator('[data-testid="marketplace-use"][data-pack="c"]').click()
        await page.getByTestId('marketplace-pane').waitFor({ state: 'detached' })
        await page.getByTestId('open-folder').first().click()
      } else await openFolder(page, project)
      await openFromExplorer(page, project.files[0], 'Ion fixture')
      await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
      if (values.context === 'lens') {
        await openFromExplorer(page, project.broken, 'return 0')
        await page.getByTestId('run').click()
        await page.locator('[data-testid="output"][data-status="compile-error"]').waitFor()
        await page.locator('#bottom-tab-problems').click()
        await page.getByTestId('problem-explain').first().click()
        await page.getByTestId('learning-concept').first().waitFor()
        await page.getByTestId('tab').filter({ hasText: 'program.c' }).locator('.tab-name').click()
        await editorShows(page, 'ION-DESKTOP-RUN-OK')
      } else if (values.context === 'terminal') {
        await page.getByTestId('bottom-terminal-tab').click()
        await page.getByTestId('terminal-input').waitFor()
        await page.getByTestId('terminal-pane').locator('.xterm').evaluate((node) => { node.dataset.collectionTerminal = 'original' })
      }
      assert.ok(await page.getByTestId('tab').count() >= 2)
      const editor = page.locator('.monaco-editor').first()
      await editor.evaluate((node) => { node.dataset.collectionEditor = 'original' })
      await editor.locator('.view-line').first().click()
      const typingStart = performance.now()
      await page.keyboard.insertText('/*ion-mem*/')
      await editorShows(page, 'ion-mem')
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const typingMs = performance.now() - typingStart
      await sleep(3000)
      const idleStart = await samples(session, cdp)
      await sleep(2000)
      const idle = await samples(session, cdp)
      const idleCpu = (idle.cpuNs - idleStart.cpuNs) / 1e4 / (idle.time - idleStart.time)
      await page.getByTestId('settings').click()
      const preferences = page.getByRole('dialog', { name: 'Preferences' })
      if (values.legacy) {
        await preferences.locator(`[data-testid="theme-picker"] option[value="${registry[0].id}"]`).waitFor({ state: 'attached' })
      } else {
        await preferences.getByTestId('theme-browse').click()
        await preferences.locator(`[data-theme-choice="${registry[0].id}"]`).waitFor()
      }
      let layers = []
      if (values['profile-layers']) {
        cdp.on('LayerTree.layerTreeDidChange', (event) => { layers = event.layers ?? [] })
        await cdp.send('LayerTree.enable')
      }
      if (values['flatten-list']) {
        await page.addStyleTag({ content: '.theme-results { overflow: visible; max-height: none; }' })
      }
      const checkpoints = []
      const timings = []
      const ids = registry.map(({ id }) => id)
      for (let index = 0; index < switchCount; index++) {
        const id = ids[index % ids.length]
        timings.push(await page.evaluate(async ({ id, legacy }) => {
          const started = performance.now()
          const paint = new Promise((resolve, reject) => {
            const root = document.querySelector('.app-shell')
            const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Theme switch timed out.')) }, 4000)
            const observer = new MutationObserver(() => {
              if (root.dataset.themeId !== id) return
              observer.disconnect()
              requestAnimationFrame(() => requestAnimationFrame(() => {
                clearTimeout(timeout)
                resolve(performance.now() - started)
              }))
            })
            observer.observe(root, { attributes: true, attributeFilter: ['data-theme-id'] })
          })
          if (legacy) {
            const picker = document.querySelector('[data-testid="theme-picker"]')
            picker.value = id
            picker.dispatchEvent(new Event('change', { bubbles: true }))
          } else document.querySelector(`[data-theme-choice="${id}"]`).click()
          return paint
        }, { id, legacy: Boolean(values.legacy) }))
        if ((index + 1) % 100 === 0 || index + 1 === switchCount) {
          const layerProfile = values['profile-layers'] ? await Promise.all(layers.filter(({ drawsContent }) => drawsContent)
            .map(async ({ layerId, width, height }) => ({ width, height,
              reasons: (await cdp.send('LayerTree.compositingReasons', { layerId }).catch(() => null))?.compositingReasons }))) : undefined
          checkpoints.push({ switched: index + 1, ...await samples(session, cdp), layerProfile })
        }
      }
      if (!values.legacy) await preferences.getByTestId('theme-preview-cancel').click()
      await preferences.getByRole('button', { name: 'Done', exact: true }).click()
      assert.equal(await editor.getAttribute('data-collection-editor'), 'original')
      await editorShows(page, 'ion-mem')
      await editor.locator('.view-line').first().click()
      await page.keyboard.press('Meta+z')
      await page.waitForFunction(() => !document.querySelector('.monaco-editor .view-lines').textContent.includes('ion-mem'))
      await page.getByTestId('save-file').click()
      await page.locator('.tab-dirty').waitFor({ state: 'detached' })
      await sleep(3000)
      if (values.context === 'terminal') {
        assert.equal(await page.getByTestId('terminal-pane').locator('.xterm').getAttribute('data-collection-terminal'), 'original')
        await page.getByTestId('terminal-close').click()
        await eventually(async () => !(await resourceSnapshot(session, { details: true })).members.some(({ kind }) => kind === 'child'),
          'A terminal process remained after closing the session.')
      }
      if (values.context === 'lens') await page.getByTestId('learning-pane').waitFor()
      if (values.context === 'lens') await page.getByTestId('learning-concept').first().waitFor()
      const after = await samples(session, cdp)
      await cdp.send('HeapProfiler.collectGarbage')
      const collected = await samples(session, cdp)
      const result = { customThemes: count, freshMs, warmMs: session.startupMs, typingMs, idleCpu, idle,
        switchP50Ms: percentile(timings, .5), switchP95Ms: percentile(timings, .95), checkpoints, after, collected }
      assert.deepEqual(session.requests, [])
      assert.deepEqual(session.errors, [])
      report.results.push(result)
      if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
      console.log(JSON.stringify({ customThemes: count, freshMs, warmMs: session.startupMs, typingMs,
        idleCpu, idleMiB: idle.footprintMiB, switchP50Ms: result.switchP50Ms, switchP95Ms: result.switchP95Ms,
        idleHeapMiB: idle.heapMiB, afterHeapMiB: after.heapMiB }))
    } catch (error) {
      console.error(error.message)
      const done = session.page.getByRole('button', { name: 'Done', exact: true })
      if (await done.isVisible()) await done.click().catch(() => {})
      throw error
    } finally { await close(session) }
  }
})
