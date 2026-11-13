// Serialized by Playwright into the page. This is harness-only observation;
// production startup and execution budgets are unchanged.
export function installBenchmarkRun(budgets) {
  window.ionBenchmarkRunCleanup?.()
  let started = false, completed = false, phase = 'preparing', done = false, timer, resolve, runId, unsubscribe
  const expected = budgets.expectedMarker ?? ''
  let outputTail = '', receivedMarker = !expected
  const began = performance.now()
  const promise = new Promise((accept) => { resolve = accept })
  const finish = (result) => {
    if (done) return
    done = true
    clearTimeout(timer)
    observer.disconnect()
    unsubscribe?.()
    resolve({ ...result, elapsedMs: performance.now() - began })
  }
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => finish({ failure: 'Run watchdog expired', phase }), budgets[phase])
  }
  const check = () => {
    const output = document.querySelector('[data-testid="output"]')
    const next = output?.getAttribute('data-phase')
    if (['preparing', 'compiling', 'running'].includes(next) && !runId) {
      if (!started || next !== phase) {
        started = true
        phase = next
        arm()
      }
    } else if (started && completed && next === 'finished') {
      const status = output.getAttribute('data-status')
      if (status !== 'success') { finish({ status, phase: next }); return }
      if (!receivedMarker) {
        finish({ failure: 'Program completed without the expected terminal output', status, phase: next })
        return
      }
      // Run status arrives before xterm's asynchronous paint. Inspect terminal
      // rows rather than output.textContent (which includes injected CSS), and
      // let the existing observer deliver the subsequent paint without polling.
      let text = '', renderedMarker = !expected
      for (const row of output.querySelectorAll('.xterm-rows > div')) {
        const line = row.textContent?.replaceAll('\u00a0', ' ') ?? ''
        text = (text + line).slice(-4096)
        if (text.includes(expected)) renderedMarker = true
      }
      if (renderedMarker) finish({ status, text, phase: next })
    }
  }
  const observer = new MutationObserver(check)
  observer.observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['data-phase', 'data-status', 'disabled'] })
  unsubscribe = window.ion.runConsole.onUpdate(({ id, update }) => {
    if (!runId && update.kind === 'phase' && update.phase === 'preparing') runId = id
    if (!runId && update.kind === 'complete') runId = id
    if (id !== runId) return
    started = true
    if (update.kind === 'data' && update.stream === 'terminal' && !receivedMarker) {
      const chunk = outputTail + update.text
      receivedMarker = chunk.includes(expected)
      outputTail = receivedMarker || expected.length < 2 ? '' : chunk.slice(-(expected.length - 1))
    }
    if (update.kind === 'complete') completed = true
    if (update.kind === 'phase' && update.phase !== phase) {
      phase = update.phase
      arm()
    }
    // Completion is followed by the renderer receiving the IPC result. The
    // observer checks that rendered result instead of treating complete as
    // proof of success. A coalesced preparing/running DOM update is not needed.
  })
  arm()
  window.ionBenchmarkRunCompletion = promise
  window.ionBenchmarkRunCleanup = () => {
    finish({ failure: 'Run observation cancelled', phase })
    delete window.ionBenchmarkRunCompletion
    delete window.ionBenchmarkRunCleanup
  }
}
