// Measurement tooling only. A failed CDP detail request must not erase an
// independently completed native reading or turn that reading into a full pass.
export async function attachRendererDetails(point, cdp, page, retainFailure) {
  point.nativeComplete = true
  try {
    Object.assign(point, {
      heap: await cdp.send('Runtime.getHeapUsage'),
      dom: await cdp.send('Memory.getDOMCounters'),
      ui: await page.evaluate(() => ({ editors: document.querySelectorAll('.monaco-editor').length,
        tabs: document.querySelectorAll('[data-testid="tab"]').length, viewport: [innerWidth, innerHeight], scale: devicePixelRatio })),
      workers: page.workers().map(worker => new URL(worker.url()).pathname),
      detailsComplete: true,
    })
    return point
  } catch (error) {
    point.detailsComplete = false
    point.detailFailure = String(error.stack ?? error)
    try { await retainFailure(point) }
    catch (retentionError) { console.error('Could not retain the native-only diagnostic:', String(retentionError)) }
    throw error // Preserve the original failure; never reconnect to force a pass.
  }
}
