import { basename } from 'node:path'

export const roles = ['main', 'renderer', 'gpu-process', 'utility', 'crashpad', 'native-child']
export const nativePsLocale = 'en_US.UTF-8'
export const nativePsEnvironment = (environment = process.env) => ({ ...environment, LC_ALL: nativePsLocale, LANG: nativePsLocale, TZ: 'UTC' })
const rowPattern = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
const identityPattern = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/

export function parseProcessRows(text) {
  return text.split('\n').flatMap(line => {
    const match = rowPattern.exec(line)
    if (!match) return []
    const [, pid, parent, rss, started, command] = match
    return [{ pid: Number(pid), parent: Number(parent), rssMiB: Number(rss) / 1024,
      started: started.replace(/\s+/g, ' '), command }]
  })
}

export function parseIdentities(text) {
  return new Map(text.split('\n').flatMap(line => {
    const match = identityPattern.exec(line)
    return match ? [[Number(match[1]), match[2].replace(/\s+/g, ' ')]] : []
  }))
}

export function bundleFromCommand(command) {
  const match = /^(.*?\.app)\/Contents\/MacOS\/Ion IDE(?=\s|$)/.exec(command)
  return match?.[1]
}

// ps does not quote argv reliably. Accept only an exact known helper option
// followed by another flag/end; never use a loose profile-path substring.
export function exactHelperOption(command, option, value) {
  // Scoped to the known macOS bundle/profile. Native APIs can use decomposed
  // Unicode spellings for the same macOS filesystem object.
  const normalized = command.normalize('NFC')
  const token = ` ${option}=${value}`.normalize('NFC')
  const index = normalized.indexOf(token)
  if (index < 0) return false
  const tail = normalized.slice(index + token.length)
  return tail === '' || tail.startsWith(' --')
}

const sameFrameworkRoot = (command, bundle) => command.normalize('NFC').startsWith((bundle + '/Contents/Frameworks/').normalize('NFC'))

export class ProcessFamily {
  constructor(root, profile) {
    this.root = { pid: root.pid, started: root.started }
    this.bundle = bundleFromCommand(root.command)
    if (!this.bundle || /(?:^|\s)--type=/.test(root.command)) throw new Error('The selected PID must be a packaged Ion IDE main process.')
    this.profile = profile
    this.known = new Map([[root.pid, root.started]])
  }

  select(rows) {
    const byPid = new Map(rows.map(row => [row.pid, row]))
    const live = new Set([...this.known].flatMap(([pid, started]) => byPid.get(pid)?.started === started ? [pid] : []))
    const rootAlive = byPid.get(this.root.pid)?.started === this.root.started
    if (rootAlive && this.profile) {
      for (const row of rows) {
        if (!sameFrameworkRoot(row.command, this.bundle)) continue
        if (exactHelperOption(row.command, '--user-data-dir', this.profile)
          || exactHelperOption(row.command, '--database', this.profile + '/Crashpad')) live.add(row.pid)
      }
    }
    let count
    do {
      count = live.size
      for (const row of rows) if (live.has(row.parent)) live.add(row.pid)
    } while (live.size > count)
    const members = rows.filter(row => live.has(row.pid))
    if (members.length > 128 || this.known.size + members.filter(row => !this.known.has(row.pid)).length > 4096) {
      throw new Error('Process-family ownership limit reached. Capture a smaller controlled workload.')
    }
    for (const row of members) this.known.set(row.pid, row.started)
    return { rootAlive, members }
  }

  kind(row) {
    if (row.pid === this.root.pid && row.started === this.root.started) return 'main'
    if (!sameFrameworkRoot(row.command, this.bundle)) return 'native-child'
    if (/crashpad_handler/.test(row.command)) return 'crashpad'
    const type = /(?:^|\s)--type=([^\s]+)/.exec(row.command)?.[1]
    return ['renderer', 'gpu-process', 'utility'].includes(type) ? type : 'utility'
  }
}

export function parseProbe(text) {
  return new Map(text.trim().split('\n').flatMap(line => {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 5 || fields.some(field => !/^\d+$/.test(field))) return []
    return [[Number(fields[0]), { footprintMiB: Number(fields[1]) / 1024 ** 2,
      cpuNs: fields[2], reapedChildCpuNs: fields[3], packageIdleWakeups: Number(fields[4]) }]]
  }))
}

export function completeSnapshot(family, selection, probe, identities, time) {
  const members = selection.members.map(row => {
    const stable = identities.get(row.pid) === row.started
    const usage = stable ? probe.get(row.pid) : undefined
    return { pid: row.pid, parent: row.parent, started: row.started, kind: family.kind(row),
      rssMiB: row.rssMiB, ...(usage ?? {}), stableThroughProbe: stable, measured: Boolean(usage) }
  })
  const byRole = {}
  for (const kind of roles) {
    const selected = members.filter(member => member.kind === kind)
    if (!selected.length) continue
    const measured = selected.filter(member => member.measured)
    byRole[kind] = { count: selected.length, measuredCount: measured.length,
      rssMiB: selected.reduce((sum, member) => sum + member.rssMiB, 0),
      footprintMiB: measured.length === selected.length ? measured.reduce((sum, member) => sum + member.footprintMiB, 0) : null }
  }
  const missingProbeProcesses = members.filter(member => !member.measured).length
  const rootAlive = selection.rootAlive && identities.get(family.root.pid) === family.root.started
  return { ...time, rootAlive, eligibleForResourceSummary: rootAlive && members.length > 0,
    rssMiB: members.length ? members.reduce((sum, member) => sum + member.rssMiB, 0) : null,
    footprintMiB: !members.length || missingProbeProcesses ? null : members.reduce((sum, member) => sum + member.footprintMiB, 0),
    missingProbeProcesses, roles: byRole, members, cpuPercentOneCore: null,
    reapedChildCpuPercentOneCore: null }
}

// Process exit is an observation, not an idle-memory reading of zero MiB. Raw
// terminal events remain available for lifecycle analysis but are never used
// for running-application resource statistics or plotted as a memory drop.
export function usableResourceSample(sample) {
  return sample.rootAlive === true && Array.isArray(sample.members) && sample.members.length > 0
}

export function applyCpuDelta(previous, current) {
  if (!previous) return current
  const elapsedMs = current.monotonicMs - previous.monotonicMs
  if (!(elapsedMs > 0)) return current
  const before = new Map(previous.members.filter(member => member.measured)
    .map(member => [member.pid + ':' + member.started, member]))
  let ns = 0n
  let comparisons = 0
  const byRole = {}
  for (const member of current.members) {
    const prior = before.get(member.pid + ':' + member.started)
    if (!member.measured || !prior) continue
    const delta = BigInt(member.cpuNs) - BigInt(prior.cpuNs)
    if (delta < 0n) continue
    comparisons++
    ns += delta
    byRole[member.kind] = (byRole[member.kind] ?? 0n) + delta
    if (member.kind === 'main') {
      const reaped = BigInt(member.reapedChildCpuNs) - BigInt(prior.reapedChildCpuNs)
      current.reapedChildCpuPercentOneCore = reaped >= 0n ? Number(reaped) / elapsedMs / 1e4 : null
    }
  }
  current.cpuIntervalMs = elapsedMs
  current.cpuComparedProcesses = comparisons
  current.cpuPercentOneCore = comparisons ? Number(ns) / elapsedMs / 1e4 : null
  for (const [role, usage] of Object.entries(current.roles)) usage.cpuPercentOneCore = Object.hasOwn(byRole, role)
    ? Number(byRole[role]) / elapsedMs / 1e4 : null
  return current
}

export function statistics(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return { count: 0, min: null, median: null, mean: null, p95: null, max: null }
  const middle = Math.floor(sorted.length / 2)
  return { count: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95: sorted.length >= 20 ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null, max: sorted.at(-1) }
}

export function summarize(samples) {
  const usable = samples.filter(usableResourceSample)
  const summary = { sampleCount: usable.length, recordedSampleCount: samples.length, excludedSampleCount: samples.length - usable.length,
    incompleteProbeSamples: usable.filter(sample => sample.missingProbeProcesses).length,
    rssMiB: statistics(usable.map(sample => sample.rssMiB)),
    footprintMiB: statistics(usable.map(sample => sample.footprintMiB)),
    cpuPercentOneCore: statistics(usable.map(sample => sample.cpuPercentOneCore)),
    observerDurationMs: statistics(usable.map(sample => sample.observerDurationMs)), roles: {} }
  const cpuSamples = usable.filter(sample => Number.isFinite(sample.cpuPercentOneCore) && sample.cpuIntervalMs > 0)
  summary.cpuPercentOneCore.weightedMean = cpuSamples.length ? cpuSamples.reduce((sum, sample) =>
    sum + sample.cpuPercentOneCore * sample.cpuIntervalMs, 0) / cpuSamples.reduce((sum, sample) => sum + sample.cpuIntervalMs, 0) : null
  for (const role of roles) {
    const rows = usable.flatMap(sample => sample.roles[role] ? [sample.roles[role]] : [])
    if (!rows.length) continue
    summary.roles[role] = { maxProcesses: Math.max(...rows.map(row => row.count)),
      rssMiB: statistics(rows.map(row => row.rssMiB)), footprintMiB: statistics(rows.map(row => row.footprintMiB)),
      cpuPercentOneCore: statistics(rows.map(row => row.cpuPercentOneCore)) }
  }
  return summary
}

export const csvCell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"'
export const csvHeader = 'timestamp,elapsed_ms,scenario,root_alive,eligible_resource_sample,footprint_mib,summed_rss_mib,cpu_percent_one_core,processes,missing_probe_processes,observer_duration_ms\n'
export function csvRow(sample) {
  return [sample.timestamp, sample.elapsedMs, sample.scenario, sample.rootAlive, usableResourceSample(sample), sample.footprintMiB, sample.rssMiB,
    sample.cpuPercentOneCore, sample.members.length, sample.missingProbeProcesses, sample.observerDurationMs].map(csvCell).join(',') + '\n'
}
export const printable = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : 'not measured'
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export function markdownReport(report) {
  const { summary } = report
  const rows = [['Attributed footprint', summary.footprintMiB, 'MiB'], ['Summed RSS', summary.rssMiB, 'MiB'],
    ['Observed process CPU', summary.cpuPercentOneCore, '% of one logical core'], ['Observer sample duration', summary.observerDurationMs, 'ms']]
  const status = report.complete ? 'Completed the requested capture duration.' : `Capture ended early: ${report.stopReason}.`
  return `# Ion IDE runtime capture — ${report.label}\n\n${status}\n\n` +
    `Recorded **${report.samples.length} real samples/events** over **${printable(report.elapsedSeconds, 1)} seconds**. **${summary.sampleCount}** contain a live main process and nonempty owned family; **${summary.excludedSampleCount}** exited/empty events are excluded from all resource statistics and charts. Requested ${report.requestedSeconds} seconds, interval ${report.intervalMs} ms.\n\n` +
    `Started: ${report.startedAt}\n\nEnded: ${report.endedAt}\n\nVersion: ${report.application.version ?? 'not measured'} · Architecture: ${report.host.arch} · Root PID: ${report.root.pid}\n\n` +
    `Host: ${report.host.processor ?? 'not measured'} · ${printable(report.host.ramBytes == null ? null : report.host.ramBytes / 1024 ** 3, 1)} GiB RAM · ${report.host.os?.replaceAll('\n', ', ') ?? 'not measured'}\n\n` +
    '| Metric | Samples | Min | Median | Mean | p95 | Peak | Unit |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n' +
    rows.map(([name, value, unit]) => `| ${name} | ${value.count} | ${printable(value.min)} | ${printable(value.median)} | ${printable(value.mean)} | ${printable(value.p95)} | ${printable(value.max)} | ${unit} |`).join('\n') +
    `\n\nTime-weighted observed CPU: **${printable(summary.cpuPercentOneCore.weightedMean)}% of one logical core**. Incomplete native probe samples: ${summary.incompleteProbeSamples}. p95 is omitted with fewer than twenty usable samples and otherwise uses nearest rank.\n\n` +
    '## Process ownership\n\n| Role | Maximum processes | Median footprint | Peak footprint | Median summed RSS | Peak summed RSS | Median observed CPU |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n' +
    Object.entries(summary.roles).map(([role, value]) => `| ${role} | ${value.maxProcesses} | ${printable(value.footprintMiB.median)} MiB | ${printable(value.footprintMiB.max)} MiB | ${printable(value.rssMiB.median)} MiB | ${printable(value.rssMiB.max)} MiB | ${printable(value.cpuPercentOneCore.median)}% |`).join('\n') +
    '\n\n## Method and limits\n\n' + report.method.map(item => '- ' + item).join('\n') +
    '\n\n## Scenarios\n\n' + report.markers.map(marker => `- ${printable(marker.elapsedMs / 1000, 1)} s: ${marker.label}`).join('\n') +
    '\n\n## Files\n\n`capture.json` contains finalized samples and metadata. `samples.ndjson` and `samples.csv` contain the recorded time series. `latest.json` was updated during capture and now describes the final state. `report.html` is a standalone offline chart. No monitor remains running after this command ends.\n'
}

export function htmlReport(report) {
  const graphData = report.samples.filter(usableResourceSample).map(sample => ({ seconds: sample.elapsedMs / 1000, footprint: sample.footprintMiB,
    rss: sample.rssMiB, cpu: sample.cpuPercentOneCore, scenario: sample.scenario, timestamp: sample.timestamp }))
  const data = JSON.stringify(graphData).replaceAll('<', '\\u003c')
  const roleRows = Object.entries(report.summary.roles).map(([role, value]) => `<tr><th>${escape(role)}</th><td>${value.maxProcesses}</td><td>${printable(value.footprintMiB.median)}</td><td>${printable(value.footprintMiB.max)}</td><td>${printable(value.rssMiB.median)}</td><td>${printable(value.rssMiB.max)}</td><td>${printable(value.cpuPercentOneCore.median)}</td></tr>`).join('')
  const card = (title, value, note) => `<section><small>${escape(title)}</small><strong>${escape(value)}</strong><p>${escape(note)}</p></section>`
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"><title>Ion runtime — ${escape(report.label)}</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#10151c;color:#dce4ef;font:15px/1.5 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:34px 24px}header{border-bottom:1px solid #303a48;padding-bottom:22px}h1{margin:4px 0 8px;font-size:27px}h2{font-size:19px;margin-top:30px}p{color:#aebbcf}small,.muted{color:#aebbcf}.tag{color:#85dfd3;font-size:12px;letter-spacing:.1em;text-transform:uppercase}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}section{padding:17px;border:1px solid #303a48;border-radius:7px;background:#151c25}strong{display:block;font:600 24px/1.4 ui-monospace,monospace;margin-top:6px}section p{font-size:12px;margin:4px 0 0}.controls{display:flex;gap:8px;margin-bottom:12px}button{border:1px solid #44516a;color:#dce4ef;background:#202a38;border-radius:5px;padding:7px 12px;cursor:pointer}button[aria-pressed=true]{border-color:#85dfd3;color:#85dfd3}svg{width:100%;height:300px;display:block;background:#131a23;border:1px solid #303a48;border-radius:6px}#point{min-height:45px;font:12px/1.6 ui-monospace,monospace;color:#b7c5d9;white-space:pre-wrap}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:right;padding:10px 8px;border-bottom:1px solid #303a48}th:first-child{text-align:left}li{margin:7px 0;color:#b7c5d9}.table{overflow:auto}code{color:#9edbd3}@media(max-width:740px){.cards{grid-template-columns:1fr}main{padding:22px 14px}h1{font-size:23px}svg{height:260px}}</style>
<main><header><div class="tag">Ion IDE · actual process capture</div><h1>${escape(report.label)}</h1><p>${escape(report.complete ? 'Completed capture' : 'Ended early: ' + report.stopReason)} · ${report.samples.length} recorded events · ${report.summary.sampleCount} usable samples · ${report.summary.excludedSampleCount} exited/empty events excluded · ${printable(report.elapsedSeconds, 1)} s · ${escape(report.startedAt)} to ${escape(report.endedAt)}</p><small>This is a recorded live time series, not a continuously running monitor. ${escape(report.host.processor ?? '')}, ${printable(report.host.ramBytes == null ? null : report.host.ramBytes / 1024 ** 3, 1)} GiB, ${escape(report.host.arch)}, Ion ${escape(report.application.version ?? 'unknown')}.</small></header>
<div class="cards">${card('Median attributed footprint', printable(report.summary.footprintMiB.median) + ' MiB', 'macOS proc_pid_rusage physical-footprint counter')}${card('Median summed RSS', printable(report.summary.rssMiB.median) + ' MiB', 'Shared resident pages may be counted repeatedly')}${card('Time-weighted observed CPU', printable(report.summary.cpuPercentOneCore.weightedMean) + '%', '100% equals one busy logical CPU core')}</div>
<h2>Measured time series</h2><div class="controls"><button data-mode="memory" aria-pressed="true">Memory</button><button data-mode="cpu" aria-pressed="false">CPU</button></div><svg id="chart" viewBox="0 0 1080 300" role="img" aria-label="Measured resource time series"></svg><div id="point">Move over the chart to inspect a real captured sample.</div><p id="legend">Mint: attributed footprint · Blue: summed RSS · Both in MiB.</p>
<h2>Process breakdown</h2><div class="table"><table><thead><tr><th>Role</th><th>Max count</th><th>Median footprint MiB</th><th>Peak footprint MiB</th><th>Median RSS MiB</th><th>Peak RSS MiB</th><th>Median CPU %</th></tr></thead><tbody>${roleRows}</tbody></table></div>
<h2>Method and limits</h2><ul>${report.method.map(item => `<li>${escape(item)}</li>`).join('')}</ul><h2>Scenario markers</h2><ul>${report.markers.map(marker => `<li>${printable(marker.elapsedMs / 1000, 1)} s · ${escape(marker.label)}</li>`).join('')}</ul><p>Raw evidence: <code>capture.json</code>, <code>samples.ndjson</code> and <code>samples.csv</code> in this capture folder. Commands and user document contents are not included.</p></main>
<script>const samples=${data};const svg=document.getElementById('chart');const details=document.getElementById('point');let mode='memory';const ns='http://www.w3.org/2000/svg';const W=1080,H=300,L=70,R=20,T=20,B=38;function item(name,attrs,text){const el=document.createElementNS(ns,name);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;svg.append(el);return el}function render(){svg.replaceChildren();const keys=mode==='memory'?['footprint','rss']:['cpu'];const max=Math.max(1,...samples.flatMap(s=>keys.map(k=>Number.isFinite(s[k])?s[k]:0)))*1.1;const end=Math.max(1,samples.at(-1)?.seconds??1);for(let i=0;i<=4;i++){const y=T+(H-T-B)*i/4;item('line',{x1:L,x2:W-R,y1:y,y2:y,stroke:'#2b3646'});item('text',{x:L-9,y:y+4,fill:'#aebbcf','text-anchor':'end','font-size':11},(max*(1-i/4)).toFixed(1))}for(let i=0;i<=4;i++)item('text',{x:L+(W-L-R)*i/4,y:H-12,fill:'#aebbcf','text-anchor':'middle','font-size':11},(end*i/4).toFixed(0)+' s');for(const[k,color]of keys.map((k,i)=>[k,i?'#8bbcff':'#85dfd3'])){let d='';let on=false;for(const s of samples){if(!Number.isFinite(s[k])){on=false;continue}d+=(on?'L':'M')+(L+s.seconds/end*(W-L-R)).toFixed(2)+','+(H-B-s[k]/max*(H-T-B)).toFixed(2);on=true}item('path',{d,fill:'none',stroke:color,'stroke-width':2})}svg.onpointermove=e=>{const bounds=svg.getBoundingClientRect();const x=(e.clientX-bounds.left)/bounds.width*W;const seconds=Math.max(0,Math.min(end,(x-L)/(W-L-R)*end));let nearest=samples[0];for(const s of samples)if(Math.abs(s.seconds-seconds)<Math.abs(nearest.seconds-seconds))nearest=s;if(nearest)details.textContent=nearest.timestamp+' · '+nearest.scenario+'\\nFootprint '+(nearest.footprint??'not measured')+' MiB · RSS '+nearest.rss.toFixed(2)+' MiB · CPU '+(nearest.cpu===null?'not measured':nearest.cpu.toFixed(2)+'%')}}document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{mode=button.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));document.getElementById('legend').textContent=mode==='memory'?'Mint: attributed footprint · Blue: summed RSS · Both in MiB.':'Observed process CPU, percent of one logical core. Short-lived work may be missed.';render()}));render();</script></html>`
}

export function safeScenario(value) {
  return String(value).replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, 80) || 'unmarked'
}

export function applicationName(bundle) { return basename(bundle, '.app') }
