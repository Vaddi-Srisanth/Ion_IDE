import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, launch, openFolder, openFromExplorer, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, candidate: { type: 'string', default: 'dist' },
  out: { type: 'string', default: 'performance-results' },
} })
assert.ok(values.baseline, 'Provide --baseline followed by the preserved production build directory.')
const output = resolve(values.out, `editor-compositor-${new Date().toISOString().replaceAll(':', '-')}`)
await mkdir(output, { recursive: true })

async function inspectLayers(page) {
  const cdp = await page.context().newCDPSession(page)
  try {
    let layers
    cdp.on('LayerTree.layerTreeDidChange', (event) => { layers = event.layers })
    await cdp.send('LayerTree.enable')
    for (let attempt = 0; !layers && attempt < 20; attempt += 1) await sleep(50)
    if (!layers) return null
    const { root } = await cdp.send('DOM.getDocument')
    const inspect = async (selector) => {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      const { node } = await cdp.send('DOM.describeNode', { nodeId })
      const layer = layers.find(({ backendNodeId }) => backendNodeId === node.backendNodeId)
      return layer ? await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId }) : null
    }
    return {
      total: layers.length,
      drawsContent: layers.filter(({ drawsContent }) => drawsContent).length,
      lines: await inspect('.monaco-editor .lines-content'),
      margin: await inspect('.monaco-editor .margin'),
    }
  } finally {
    await cdp.detach()
  }
}

async function scrollSamples(page) {
  const editor = page.locator('.monaco-editor').first()
  const bounds = await editor.boundingBox()
  assert.ok(bounds)
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await editor.evaluate((element) => {
    const lines = element.querySelector('.lines-content')
    const timings = []
    const wheel = () => {
      const started = performance.now()
      const before = lines.style.top
      let frames = 0
      function waitForScroll() {
        if (lines.style.top !== before) requestAnimationFrame(() => timings.push(performance.now() - started))
        else if (++frames === 60) timings.push(null)
        else requestAnimationFrame(waitForScroll)
      }
      requestAnimationFrame(waitForScroll)
    }
    element.addEventListener('wheel', wheel, { capture: true, passive: true })
    window.ionCompositorScroll = { timings, dispose: () => element.removeEventListener('wheel', wheel, true) }
  })
  try {
    for (let index = 0; index < 12; index += 1) {
      await page.mouse.wheel(0, index % 2 ? -360 : 360)
      await page.waitForFunction((count) => window.ionCompositorScroll.timings.length >= count, index + 1)
    }
    const timings = await page.evaluate(() => window.ionCompositorScroll.timings)
    assert.ok(timings.every(Number.isFinite), 'Each wheel input moved the editor viewport.')
    return timings
  } finally {
    await page.evaluate(() => {
      window.ionCompositorScroll.dispose()
      delete window.ionCompositorScroll
    })
  }
}

await withScratch('editor-compositor', async (scratch) => {
  const fixture = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  await writeFile(fixture.program, Array.from({ length: 650 }, (_, index) =>
    `static const int value_${index} = ${index}; // Retina editor fixture\n`).join(''))
  const runs = {}
  for (const [label, path] of [['baseline', values.baseline], ['candidate', values.candidate]]) {
    assert.ok(!path.endsWith('.app'), 'Use an unpackaged production build for Playwright’s Electron harness.')
    const session = await launch(await artifact(path), join(scratch, label))
    try {
      const { app, page } = session
      await stubDialogs(app, { folder: fixture.directory })
      await openFolder(page, fixture)
      await openFromExplorer(page, fixture.program, 'Retina editor fixture')
      await sleep(1500)
      const editor = await page.evaluate(() => ({
        scale: devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        linesTransform: getComputedStyle(document.querySelector('.monaco-editor .lines-content')).transform,
        marginTransform: getComputedStyle(document.querySelector('.monaco-editor .margin')).transform,
      }))
      const screenshot = await page.screenshot({ path: join(output, `${label}.png`), scale: 'device' })
      const layers = await inspectLayers(page)
      const scrollMs = await scrollSamples(page)
      runs[label] = { path, editor, screenshotSize: [screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)], layers, scrollMs }
    } finally {
      await close(session)
    }
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({
    metric: 'Wheel DOM event to changed Monaco scroll offset plus the following animation callback. This is a paint proxy.',
    runs,
  }, null, 2) + '\n')
  console.log(output)
})
