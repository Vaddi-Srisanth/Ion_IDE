export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function extendedResourceMetrics({ warmup, rounds }, stableCpuPercent) {
  const last = rounds.at(-1).settled
  const reapedCpu = (sample) => sample.members.find(({ kind }) => kind === 'main')?.reapedChildCpuNs
  const childCpuNs = reapedCpu(last) - reapedCpu(warmup)
  const durationMs = last.timeMs - warmup.timeMs
  const extendedReapedChildCpuPercent = Number.isFinite(childCpuNs) && childCpuNs >= 0 && durationMs > 0
    ? childCpuNs / 1e6 / durationMs * 100 : null
  const medianRss = (samples) => median(samples.map(({ settled }) => settled.rssMiB))
  return {
    // Five rounds reopen the large fixture. Compare after those rounds.
    extendedPostWarmRssGrowthMiB: rounds.length >= 11
      ? medianRss(rounds.slice(-3)) - medianRss(rounds.slice(5, 8)) : null,
    extendedReapedChildCpuPercent,
    extendedTreeCpuPercent: extendedReapedChildCpuPercent === null || !Number.isFinite(stableCpuPercent)
      ? null : stableCpuPercent + extendedReapedChildCpuPercent,
  }
}
