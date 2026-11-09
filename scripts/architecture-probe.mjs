import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import electron from 'electron'

const { values } = parseArgs({ options: {
  renderer: { type: 'string', default: 'dist/renderer' },
  trials: { type: 'string', default: '3' },
  'idle-ms': { type: 'string', default: '2500' },
} })
const trialCount = Number(values.trials)
const idleMs = Number(values['idle-ms'])
if (process.platform !== 'darwin' || !Number.isInteger(trialCount) || trialCount < 1 || trialCount > 10
  || !Number.isInteger(idleMs) || idleMs < 1000 || idleMs > 120000) {
  throw new Error('Run on macOS with 1–10 trials and 1,000–120,000 idle milliseconds.')
}

const renderer = await realpath(values.renderer)
const originalHtml = await readFile(join(renderer, 'index.html'), 'utf8')
const html = originalHtml.replace('</head>', '<script src="./probe.js"></script></head>')
if (html === originalHtml) throw new Error('Renderer index has no closing head tag.')
const fixture = '#include <stdio.h>\nint ion_probe_buffer = 42;\nint main(void) { printf("%d\\n", ion_probe_buffer); }\n'
  + Array.from({ length: 647 }, (_, row) => '/* Offline architecture probe row ' + row + ' */').join('\n')

const preferences = {
  theme: 'dark', accent: 'cyan', fontSize: 14, tabSize: 4, wordWrap: false, lineNumbers: true,
  autoSave: true, autoSaveDelay: 1000, explorerWidth: 240, auxiliaryWidth: 340, outputHeight: 210,
  showExplorer: true, showOutput: false, resourceProfile: 'minimal',
}
const browserScript = `(() => {
  const fixture = ${JSON.stringify(fixture)};
  const unsubscribe = () => () => {};
  window.ion = Object.freeze({
    platform: 'darwin',
    getPreferences: async () => ({ settings: ${JSON.stringify(preferences)}, recents: [] }),
    openFile: async () => ({ path: '/probe/synthetic.c', name: 'synthetic.c', kind: 'file' }),
    readFile: async () => ({ text: fixture, revision: 'probe' }),
    onOpenEntry: unsubscribe, onCommand: unsubscribe, onCloseRequest: unsubscribe,
    setOptionalPanel: async () => {},
  });
  const emit = (step, info) => fetch('./event/' + step, { method: 'POST', body: JSON.stringify(info ?? {}) });
  const painted = () => new Promise((ready) => requestAnimationFrame(() => requestAnimationFrame(ready)));
  const waitFor = (predicate) => new Promise((done, reject) => {
    if (predicate()) return done();
    const observer = new MutationObserver(() => {
      if (!predicate()) return;
      observer.disconnect();
      clearTimeout(timer);
      done();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Expected editor UI did not appear')); }, 10000);
  });
  const welcome = async () => {
    await waitFor(() => document.querySelector('[data-testid="welcome"]'));
    await painted();
    await emit('welcome');
  };
  window.architectureProbeOpen = async () => {
    const start = performance.now();
    try {
      document.querySelector('[data-testid="open-file"]').click();
      await waitFor(() => document.querySelector('.monaco-editor .view-lines')?.textContent.includes('ion_probe_buffer'));
      await painted();
      await emit('editor', { openMs: performance.now() - start });
    } catch (error) {
      await emit('error', { message: String(error) });
    }
  };
  addEventListener('error', (event) => { void emit('error', { message: String(event.message) }); });
  addEventListener('unhandledrejection', (event) => { void emit('error', { message: String(event.reason) }); });
  void welcome().catch((error) => emit('error', { message: String(error) }));
})();`

const receivers = new Map()
const assetTypes = new Map([
  ['.js', 'text/javascript'], ['.css', 'text/css'], ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'],
])
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:"
const server = createServer(async (request, response) => {
  const route = request.url?.match(/^\/([a-f0-9-]{36})\/(.*)$/)
  const receiver = route && receivers.get(route[1])
  if (!receiver) return response.writeHead(404).end()
  const path = route[2]
  if (request.method === 'POST' && /^event\/(welcome|editor|error)$/.test(path)) {
    let body = ''
    for await (const chunk of request) {
      body += chunk.toString()
      if (body.length > 4096) return response.writeHead(413).end()
    }
    try {
      receiver(path.slice(6), JSON.parse(body), performance.now())
      return response.writeHead(204).end()
    } catch {
      return response.writeHead(400).end()
    }
  }
  if (request.method !== 'GET') return response.writeHead(405).end()
  if (path === 'index.html') return response.writeHead(200, {
    'Content-Type': 'text/html', 'Content-Security-Policy': csp, 'Cache-Control': 'no-store',
  }).end(html)
  if (path === 'probe.js') return response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(browserScript)
  if (!/^assets\/[\w.\-]+$/.test(path)) return response.writeHead(404).end()
  const type = assetTypes.get(extname(path))
  if (!type) return response.writeHead(404).end()
  try {
    const file = await realpath(join(renderer, path))
    if (!file.startsWith(renderer + sep)) return response.writeHead(404).end()
    const asset = await readFile(file)
    response.writeHead(200, { 'Content-Type': type }).end(asset)
  } catch {
    response.writeHead(404).end()
  }
})

function processRows() {
  return execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 6000000 })
    .trim().split('\n').flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rssMiB: Number(match[3]) / 1024, command: match[4] }] : []
    })
}

const webKitRole = (command) => command.match(/com\.apple\.WebKit\.(WebContent|Networking|GPU)(?:[^\w]|$)/)?.[1]
function collect(pid, kind, preexisting, profile, sampler) {
  const rows = processRows()
  const owned = new Set([pid])
  for (const row of rows) {
    if ((kind === 'wkwebview' && !preexisting.has(row.pid) && webKitRole(row.command))
      || (kind === 'electron' && row.command.includes('--user-data-dir=' + profile))) owned.add(row.pid)
  }
  let size
  do {
    size = owned.size
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid)
  } while (size !== owned.size)

  const members = rows.filter((row) => owned.has(row.pid))
  const native = execFileSync(sampler, members.map(({ pid }) => String(pid)), { encoding: 'utf8' })
  const byPid = new Map(native.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, footprint, cpu] = line.trim().split(/\s+/).map(Number)
    return [pid, { footprint, cpu }]
  }))
  return {
    timestamp: performance.now(),
    members: members.map(({ pid: member, rssMiB, command }) => ({
      pid: member, rssMiB,
      role: member === pid ? 'host' : webKitRole(command) ?? command.match(/--type=([^ ]+)/)?.[1] ?? 'child',
      footprintMiB: byPid.has(member) ? byPid.get(member).footprint / 1024 ** 2 : null,
      cpuNanoseconds: byPid.get(member)?.cpu ?? null,
    })),
  }
}

function resources(start, end) {
  const first = new Map(start.members.map((row) => [row.pid, row]))
  const sameFamily = start.members.length === end.members.length && end.members.every(({ pid }) => first.has(pid))
  const measuredCpu = sameFamily && end.members.every(({ pid, cpuNanoseconds }) => cpuNanoseconds !== null && first.get(pid)?.cpuNanoseconds !== null)
  const cpuDelta = measuredCpu ? end.members.reduce((sum, row) => sum + row.cpuNanoseconds - first.get(row.pid).cpuNanoseconds, 0) : null
  return {
    rssMiB: end.members.reduce((sum, row) => sum + row.rssMiB, 0),
    footprintMiB: end.members.every((row) => row.footprintMiB !== null)
      ? end.members.reduce((sum, row) => sum + row.footprintMiB, 0) : null,
    cpuPctOneCore: cpuDelta === null ? null : cpuDelta / ((end.timestamp - start.timestamp) * 10000),
    intervalMs: end.timestamp - start.timestamp, startMembers: start.members, endMembers: end.members,
  }
}

function waitUntil(check, timeout = 14000) {
  return (async () => {
    const start = performance.now()
    while (performance.now() - start < timeout) {
      const value = check()
      if (value) return value
      await sleep(25)
    }
    throw new Error('Timed out waiting for probe readiness')
  })()
}

async function logicalSize(path) {
  const entry = await lstat(path)
  if (entry.isFile()) return entry.size
  if (!entry.isDirectory()) return 0
  const items = await readdir(path)
  return (await Promise.all(items.map((name) => logicalSize(join(path, name))))).reduce((sum, value) => sum + value, 0)
}

const scratch = await mkdtemp(join(tmpdir(), 'ion-architecture-'))
const host = join(scratch, 'host')
const sampler = join(scratch, 'sampler')
const fixturePath = join(scratch, 'synthetic.c')
const evidence = join('performance-results', 'architecture-' + new Date().toISOString().replaceAll(':', '-') + '.json')

async function launch(kind, profile, sample) {
  const preexisting = new Set(processRows().map((row) => row.pid))
  const token = randomUUID()
  const events = new Map()
  const receive = (name, data, timestamp) => events.set(name, { data, timestamp })
  receivers.set(token, receive)
  const url = 'http://127.0.0.1:' + server.address().port + '/' + token + '/index.html'
  const env = { ...process.env, ION_PROBE_URL: url, ION_PROBE_PROFILE: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const startedAt = performance.now()
  const child = kind === 'electron'
    ? spawn(electron, [resolve('scripts/architecture-probe-electron.cjs')], { env, stdio: 'pipe' })
    : spawn(host, [kind === 'native' ? 'native' : url, fixturePath], { env, stdio: 'pipe' })
  const exited = once(child, 'exit')
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000) })
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-3000)
    if (stdout.includes('READY native')) receive('welcome', {}, performance.now())
  })
  const stage = (name) => waitUntil(() => {
    if (events.has('error')) throw new Error(kind + ': ' + events.get('error').data.message)
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(kind + ' exited: ' + stderr)
    return events.get(name)
  })

  try {
    const ready = await stage('welcome')
    const result = { readyMs: ready.timestamp - startedAt }
    if (sample) {
      await sleep(1500)
      const first = collect(child.pid, kind, preexisting, profile, sampler)
      await sleep(idleMs)
      result.idle = resources(first, collect(child.pid, kind, preexisting, profile, sampler))
      if (kind !== 'native') {
        child.stdin.write('o')
        const editor = await stage('editor')
        result.editorOpenMs = editor.data.openMs
        await sleep(1200)
        const editorFirst = collect(child.pid, kind, preexisting, profile, sampler)
        await sleep(idleMs)
        result.editing = resources(editorFirst, collect(child.pid, kind, preexisting, profile, sampler))
      }
    }
    return result
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end('q')
      await Promise.race([exited, sleep(2000, undefined, { ref: false })])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
    receivers.delete(token)
  }
}

const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const report = {
  host: {
    os: capture('/usr/bin/sw_vers', []), arch: process.arch,
    cpu: capture('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
    ramBytes: Number(capture('/usr/sbin/sysctl', ['-n', 'hw.memsize'])),
    power: capture('/usr/bin/pmset', ['-g', 'batt']).split('\n')[0],
  },
  configuration: {
    trialCount, idleMs, renderer: values.renderer, electronVersion: JSON.parse(await readFile('node_modules/electron/package.json')).version,
    indexSha256: createHash('sha256').update(originalHtml).digest('hex'),
    contentWidth: 1260, contentHeight: 790,
  },
  logicalBytes: {},
  trials: [],
}

try {
  await writeFile(fixturePath, fixture)
  execFileSync('/usr/bin/swiftc', ['-parse-as-library', '-O', 'scripts/architecture-probe.swift', '-o', host], { stdio: 'inherit' })
  execFileSync('/usr/bin/clang', ['-std=c11', '-O2', 'scripts/benchmark-resources-probe.c', '-o', sampler], { stdio: 'inherit' })
  report.logicalBytes = {
    renderer: await logicalSize(renderer),
    swiftHost: await logicalSize(host),
    electronFrameworkApp: await logicalSize(resolve(electron, '../../..')),
    electronHostScript: await logicalSize('scripts/architecture-probe-electron.cjs'),
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const kinds = ['electron', 'wkwebview', 'native']
  for (let trial = 0; trial < trialCount; trial += 1) {
    for (const kind of [...kinds.slice(trial % kinds.length), ...kinds.slice(0, trial % kinds.length)]) {
      const profile = join(scratch, kind + '-' + trial)
      await mkdir(profile)
      const fresh = await launch(kind, profile, false)
      await sleep(500)
      const warm = await launch(kind, profile, true)
      report.trials.push({ trial: trial + 1, kind, fresh, warm })
      console.log(kind, 'trial', trial + 1, 'fresh/warm', fresh.readyMs.toFixed(1), warm.readyMs.toFixed(1),
        'idle RSS/footprint', warm.idle.rssMiB.toFixed(1), warm.idle.footprintMiB?.toFixed(1) ?? 'unavailable')
      await sleep(600)
    }
  }
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  server.close()
  await rm(scratch, { recursive: true, force: true })
  await mkdir('performance-results', { recursive: true })
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n')
  console.log('Evidence:', evidence)
}
