import { win32 } from 'node:path'
import { exactHelperOption } from './live-runtime-metrics.mjs'

// Windows command lines preserve quoting; parse complete arguments rather than
// treating a profile path appearing anywhere in the command as ownership.
export function windowsArguments(command) {
  const args = []
  let index = 0
  while (index < command.length) {
    while (/\s/.test(command[index] ?? '') && index < command.length) index++
    if (index >= command.length) break
    let value = '', quoted = false
    while (index < command.length) {
      let slashes = 0
      while (command[index] === '\\') { slashes++; index++ }
      if (command[index] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2) { value += '"'; index++ }
        else if (quoted && command[index + 1] === '"') { value += '"'; index += 2 }
        else { quoted = !quoted; index++ }
      } else {
        value += '\\'.repeat(slashes)
        if (index >= command.length || (!quoted && /\s/.test(command[index]))) break
        value += command[index++]
      }
    }
    args.push(value)
  }
  return args
}

const windowsPath = value => win32.normalize(value).toLowerCase()
function nativeStarted(milliseconds, platform) {
  if (platform === 'win32') return String(Math.floor(milliseconds))
  const date = new Date(milliseconds), two = n => String(n).padStart(2, '0')
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${date.getUTCDate()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ${date.getUTCFullYear()}`
}
export function hasExactProfileOption(command, option, value, platform) {
  if (platform !== 'win32') return exactHelperOption(command, option, value)
  const prefix = option + '='
  return windowsArguments(command).some(arg => arg.startsWith(prefix)
    && windowsPath(arg.slice(prefix.length)) === windowsPath(value))
}

export function parseMacFamilyRows(output) {
  return output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line)
    if (!match) return []
    const [, pid, parent, rss, cpu, date, command] = match
    const started = date.replace(/\s+/g, ' ')
    const startedMs = Date.parse(started + ' UTC')
    if (!Number.isFinite(startedMs)) return []
    const cpuSeconds = cpu.split(/[:-]/).map(Number).reverse().reduce((sum, value, index) => sum + value * [1, 60, 3600, 86400][index], 0)
    return [{ pid: Number(pid), parent: Number(parent), rssMiB: Number(rss) / 1024, cpuSeconds,
      started, startedMs, identityResolutionMs: 1000, command }]
  })
}

export class TestProcessFamily {
  constructor(session, platform) {
    this.session = session
    this.platform = platform
    this.root = undefined
    this.known = new Map()
  }
  normalize(value) { return this.platform === 'win32' ? windowsPath(value) : value.normalize('NFC') }
  seed(metrics) {
    const main = metrics.find(p => p.pid === this.session.pid && Number.isFinite(p.creationTime) && p.creationTime > 0)
    if (!main || !this.session.executablePath) return
    const executable = this.session.executablePath
    this.bind({ pid: main.pid, started: nativeStarted(main.creationTime, this.platform), startedMs: main.creationTime,
      identityResolutionMs: this.platform === 'win32' ? 1 : 1000, command: executable, executablePath: executable })
    if (!this.root) return
    for (const p of metrics) if (Number.isFinite(p.creationTime) && p.creationTime > 0) this.known.set(p.pid, nativeStarted(p.creationTime, this.platform))
  }
  bind(row) {
    if (!row?.started || !Number.isFinite(row.startedMs)) return false
    const expected = this.session.mainCreationTime
    const precision = row.identityResolutionMs ?? 1
    if (Number.isFinite(expected) && expected > 0 && Math.floor(expected / precision) !== Math.floor(row.startedMs / precision)) return false
    const expectedExecutable = this.session.executablePath
    let executable = row.executablePath ?? (this.platform === 'win32' ? windowsArguments(row.command)[0]
      : /^(.*?\.app\/Contents\/MacOS\/[^]*?)(?=\s--|$)/.exec(row.command)?.[1])
    if (expectedExecutable && this.platform !== 'win32') {
      const cmd = this.normalize(row.command), wanted = this.normalize(expectedExecutable)
      if (cmd !== wanted && !cmd.startsWith(wanted + ' ')) return false
      executable = expectedExecutable
    }
    if (expectedExecutable && (!executable || this.normalize(expectedExecutable) !== this.normalize(executable))) return false
    this.root = { pid: row.pid, started: row.started, executable }
    const bundle = /^(.*?\.app)\/Contents\/MacOS\//.exec(row.command)?.[1]
    this.framework = bundle ? bundle + '/Contents/Frameworks/' : undefined
    this.windowsDirectory = executable && this.platform === 'win32' ? win32.dirname(executable) : undefined
    this.known.set(row.pid, row.started)
    return true
  }
  helper(row) {
    if (this.platform === 'win32') {
      const executable = row.executablePath ?? windowsArguments(row.command)[0]
      if (!executable || !this.windowsDirectory) return false
      const filename = win32.basename(executable).toLowerCase()
      return this.normalize(executable) === this.normalize(this.root.executable)
        || (filename === 'crashpad_handler.exe' && this.normalize(win32.dirname(executable)) === this.normalize(this.windowsDirectory))
    }
    return Boolean(this.framework && this.normalize(row.command).startsWith(this.normalize(this.framework)))
  }
  select(rows) {
    const byPid = new Map(rows.map(row => [row.pid, row]))
    if (!this.root) this.bind(byPid.get(this.session.pid))
    const rootAlive = Boolean(this.root && byPid.get(this.root.pid)?.started === this.root.started)
    const live = new Set([...this.known].flatMap(([pid, started]) => byPid.get(pid)?.started === started ? [pid] : []))
    if (rootAlive && this.session.profile) for (const row of rows) {
      if (!this.helper(row)) continue
      if (hasExactProfileOption(row.command, '--user-data-dir', this.session.profile, this.platform)
        || hasExactProfileOption(row.command, '--database', this.session.profile + (this.platform === 'win32' ? '\\Crashpad' : '/Crashpad'), this.platform)) live.add(row.pid)
    }
    let count
    do {
      count = live.size
      for (const row of rows) if (live.has(row.parent)) {
        const parent = byPid.get(row.parent)
        // A process cannot be the child of a later process that recycled a PID.
        if (parent && row.startedMs >= parent.startedMs) live.add(row.pid)
      }
    } while (live.size > count)
    const members = rows.filter(row => live.has(row.pid))
    if (members.length > 128 || this.known.size + members.filter(row => !this.known.has(row.pid)).length > 4096) {
      throw new Error('Bounded test process-family ownership limit reached.')
    }
    for (const row of members) this.known.set(row.pid, row.started)
    return { rootAlive, members }
  }
  kind(row) {
    if (this.root && row.pid === this.root.pid && row.started === this.root.started) return 'main'
    if (!this.helper(row)) return 'child'
    if (/crashpad_handler/i.test(row.command)) return 'crashpad'
    const type = this.platform === 'win32'
      ? windowsArguments(row.command).find(arg => arg.startsWith('--type='))?.slice(7)
      : /(?:^|\s)--type=([^\s]+)/.exec(row.command)?.[1]
    return type ?? 'utility'
  }
}

const families = new WeakMap()
export function familyFor(session, platform = process.platform) {
  let family = families.get(session)
  if (!family) { family = new TestProcessFamily(session, platform); families.set(session, family) }
  return family
}
export function rememberLaunchMetrics(session, metrics, platform = process.platform) { familyFor(session, platform).seed(metrics) }

export function identityCpuPercent(first, last) {
  if (first.rootAlive === false || last.rootAlive === false || !(last.timeMs > first.timeMs)) return null
  const before = first.cpuSecondsByIdentity ?? first.cpuSecondsByPid
  const after = last.cpuSecondsByIdentity ?? last.cpuSecondsByPid
  const keys = Object.keys(after)
  if (!keys.length || keys.length !== Object.keys(before).length || keys.some(key => !Object.hasOwn(before, key))) return null
  const delta = Object.entries(after).reduce((sum, [identity, seconds]) =>
    sum + Math.max(0, seconds - (before[identity] ?? seconds)), 0)
  return delta * 100_000 / (last.timeMs - first.timeMs)
}
