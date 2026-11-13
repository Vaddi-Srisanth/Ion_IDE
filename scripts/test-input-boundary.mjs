import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const { values } = parseArgs({ options: { source: { type: 'string', default: '.' }, out: { type: 'string' } } })
const source = resolve(values.source)
const scratch = await mkdtemp(join(tmpdir(), 'ion-input-boundary-'))
const report = { complete: false, source, cases: [] }
try {
  const path = join(scratch, 'input.cjs')
  await build({ entryPoints: [join(source, 'src/renderer/run-console/xterm.ts')], outfile: path, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' })
  const { sendTerminalInput } = createRequire(import.meta.url)(path)
  for (const text of ['a'.repeat(15999), 'x'.repeat(20000), '\x1b[200~' + 'x'.repeat(20000) + '\x1b[201~']) {
    const chunks = []; const accepted = sendTerminalInput(text, chunk => chunks.push(chunk))
    const sent = chunks.join('')
    report.cases.push({ inputCodeUnits: text.length, sentCodeUnits: sent.length, decision: accepted ?? 'unspecified',
      unchangedDelivery: sent === text, fullyRejected: sent.length === 0 })
  }
  assert.equal(report.cases[0].unchangedDelivery, true)
  assert.ok(report.cases.slice(1).every(item => item.decision === false && item.fullyRejected), 'Oversized input must reject in full; never submit a clipped prefix.')
  report.complete = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  await rm(scratch, { recursive: true, force: true })
  if (values.out) { const path = resolve(values.out); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n') }
}
console.log(JSON.stringify(report))
