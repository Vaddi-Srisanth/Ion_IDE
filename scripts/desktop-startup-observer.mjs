// Opt-in test diagnostics only. No startup wrapper, tracing service or polling.
// Controller and renderer clocks are intentionally separate; never subtract them.
const byPage = new WeakMap()
const limit = 64
const deadline = Symbol('diagnostic-deadline')

export function rendererStartupSnapshot({ key, install = false, remove = false }) {
  const scope = globalThis
  if (remove) {
    const previous = scope[key]
    if (previous?.listener) document.removeEventListener('click', previous.listener, true)
    delete scope[key]
    return null
  }
  if (install && !scope[key]) {
    const state = { clicks: [], overflow: false }
    state.listener = event => {
      if (!event.target?.closest?.('[data-testid="explorer-entry"]')) return
      if (state.clicks.length === 32) { state.overflow = true; return }
      state.clicks.push({ sequence: state.clicks.length + 1, ms: performance.now() })
    }
    document.addEventListener('click', state.listener, true)
    scope[key] = state
  }
  const numeric = (entry, names) => Object.fromEntries(names.flatMap(name =>
    Number.isFinite(entry[name]) ? [[name, entry[name]]] : []))
  const navigation = performance.getEntriesByType('navigation').slice(0, 1).map(entry => numeric(entry,
    ['startTime', 'fetchStart', 'responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventStart',
      'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd']))
  const resources = performance.getEntriesByType('resource')
  const safeResources = resources.slice(0, 64).map(entry => {
    let route = 'other'
    try {
      const url = new URL(entry.name)
      // Never retain document paths, query strings, source text or remote URLs.
      if (url.protocol === 'app:' && url.host === 'workbench') {
        const name = url.pathname.split('/').at(-1)
        route = url.pathname.startsWith('/assets/') && /^[A-Za-z0-9_.-]{1,120}\.(?:js|css|woff2?)$/.test(name)
          ? name : 'local-resource'
      }
    } catch {}
    return { route, initiatorType: ['script', 'link', 'css', 'fetch', 'other'].includes(entry.initiatorType)
      ? entry.initiatorType : 'other', ...numeric(entry, ['startTime', 'duration', 'fetchStart', 'responseStart',
      'responseEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize']) }
  })
  const state = scope[key]
  return { clock: 'renderer performance.now milliseconds from renderer time origin; not controller time',
    navigation, paints: performance.getEntriesByType('paint').slice(0, 2).map(entry => ({
      name: ['first-paint', 'first-contentful-paint'].includes(entry.name) ? entry.name : 'paint',
      ...numeric(entry, ['startTime', 'duration']) })),
    resources: safeResources, resourcesTruncated: resources.length > 64,
    fontStatus: document.fonts?.status ?? 'unavailable',
    clicks: state?.clicks.map(row => ({ ...row })) ?? [], clicksTruncated: state?.overflow ?? false }
}

export function createDesktopStartupObserver({ now = () => performance.now(), diagnosticTimeoutMs = 250 } = {}) {
  if (!Number.isInteger(diagnosticTimeoutMs) || diagnosticTimeoutMs < 1 || diagnosticTimeoutMs > 1000) {
    throw new Error('Invalid startup diagnostic deadline.')
  }
  const key = '__ionStartupPhases_' + Math.random().toString(36).slice(2)
  const report = { protocol: 'ion-controller-startup-phases-v1',
    controllerClock: 'controller performance.now relative to launch-requested; excludes profile preparation',
    interpretation: 'Controller observations include Playwright transport/actionability. Renderer click and resource times use an independent origin. Neither measures physical display presentation.',
    phases: [], fileOpens: [], renderer: null, errors: [], truncated: false, disposed: false }
  let origin, page, disposed = false
  function mark(name, at = now()) {
    if (disposed) return
    if (origin === undefined) origin = at
    if (report.phases.length === limit) { report.truncated = true; return }
    report.phases.push({ name, ms: at - origin })
  }
  function failure(stage, error) {
    // Deliberately omit exception text, paths, provider content and credentials.
    if (report.errors.length < 8) report.errors.push({ stage, status: error === deadline ? 'timeout' : 'unavailable' })
    else report.truncated = true
  }
  async function evaluate(input) {
    let timer
    try {
      return await Promise.race([page.evaluate(rendererStartupSnapshot, input), new Promise((_, reject) => {
        timer = setTimeout(() => reject(deadline), diagnosticTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  async function readRenderer() {
    if (disposed || !page) return
    try { report.renderer = await evaluate({ key }) }
    catch (error) { failure('renderer-snapshot', error) }
  }
  return {
    report, mark,
    async attach(value) {
      if (disposed) return
      if (page) throw new Error('Startup observer is already attached.')
      page = value
      byPage.set(page, this)
      try { report.renderer = await evaluate({ key, install: true }) }
      catch (error) { failure('renderer-attach', error) }
    },
    beginFile(at = now()) {
      if (disposed) return null
      if (origin === undefined) origin = at
      if (report.fileOpens.length === 32) { report.truncated = true; return null }
      const row = { sequence: report.fileOpens.length + 1, startedMs: at - origin, phases: [], status: 'pending' }
      report.fileOpens.push(row)
      const record = (name, time = now()) => { if (!disposed && row.phases.length < 8) row.phases.push({ name, ms: time - at }) }
      record('click-requested', at)
      return { mark: record, finish(status, durationMs) { row.status = status; row.durationMs = durationMs } }
    },
    readRenderer,
    async dispose() {
      if (disposed) return
      disposed = true; report.disposed = true
      if (!page) return
      byPage.delete(page)
      try { await evaluate({ key, remove: true }) }
      catch (error) { failure('renderer-dispose', error) }
      page = undefined
    },
  }
}

export function desktopStartupObserverFor(page) { return byPage.get(page) }
