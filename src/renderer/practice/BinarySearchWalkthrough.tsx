import { useId, useState } from 'react'
import './binary-search.css'

const values = [3, 8, 14, 19, 27, 35, 44] as const
const targets = [27, 20] as const
type Target = typeof targets[number]

type Step = { low: number; high: number } & (
  { mid: number; kind: 'keep-left' | 'keep-right' | 'found' } | { mid: null; kind: 'absent' }
)

function traceSearch(target: Target): Step[] {
  const steps: Step[] = []
  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2)
    const value = values[mid]
    if (value === target) return [...steps, { low, mid, high, kind: 'found' }]
    if (value < target) {
      steps.push({ low, mid, high, kind: 'keep-right' })
      low = mid + 1
    } else {
      steps.push({ low, mid, high, kind: 'keep-left' })
      high = mid - 1
    }
  }
  return [...steps, { low, mid: null, high, kind: 'absent' }]
}

function explanation(step: Step, target: Target): string {
  if (step.kind === 'absent') return 'Low passed high, so the search range is empty. The list does not contain ' + target + '.'
  const value = values[step.mid]
  if (step.kind === 'found') return value + ' matches the target. It is at index ' + step.mid + '.'
  if (step.kind === 'keep-right') {
    return value + ' is smaller than ' + target + '. All values at or left of mid are too small. Move low to index ' + (step.mid + 1) + '.'
  }
  return value + ' is larger than ' + target + '. All values at or right of mid are too large. Move high to index ' + (step.mid - 1) + '.'
}

export default function BinarySearchWalkthrough() {
  const title = useId()
  const [target, setTarget] = useState<Target>(targets[0])
  const [index, setIndex] = useState(0)
  const steps = traceSearch(target)
  const step = steps[index]
  const finished = step.kind === 'found' || step.kind === 'absent'

  return <section className="practice-binary-search" aria-labelledby={title}>
    <div className="practice-binary-heading">
      <h3 id={title}>Binary search</h3>
      <label className="practice-label">Target
        <select value={target} onChange={event => {
          const selected = targets.find(value => String(value) === event.currentTarget.value)
          if (selected === undefined) return
          setTarget(selected)
          setIndex(0)
        }}>
          {targets.map(value => <option key={value}>{value}</option>)}
        </select>
      </label>
    </div>
    <p className="practice-muted">Compare the target with the middle of the remaining range. The values are sorted and indices start at zero.</p>
    <ol className="practice-binary-values" role="list" aria-label="Sorted values">
      {values.map((value, position) => {
        const markers = [
          position === step.low ? 'Low' : '',
          position === step.mid ? 'Mid' : '',
          position === step.high ? 'High' : '',
        ].filter(Boolean)
        const inRange = step.low <= position && position <= step.high
        const markerLabel = markers.length ? ', ' + markers.join(', ') : ''
        return <li key={value} aria-label={'Index ' + position + ', value ' + value + markerLabel + (inRange ? '' : ', eliminated')}
          data-search-state={position === step.mid ? (step.kind === 'found' ? 'found' : 'mid') : inRange ? 'remaining' : 'eliminated'}>
          <span className="practice-binary-value">{value}</span>
          <span className="practice-binary-index">{position}</span>
        </li>
      })}
    </ol>
    <dl className="practice-binary-range" aria-label="Search range">
      <div><dt>Low</dt><dd>{step.low}</dd></div>
      <div><dt>Mid</dt><dd>{step.mid ?? 'None'}</dd></div>
      <div><dt>High</dt><dd>{step.high}</dd></div>
    </dl>
    <div className="practice-binary-explanation" role="status" aria-atomic="true">
      <h4>{step.kind === 'found' ? 'Target found' : step.kind === 'absent' ? 'Target absent' : 'Step ' + (index + 1)}</h4>
      <p>{explanation(step, target)}</p>
    </div>
    <section className="practice-binary-complexity" aria-label="Complexity analysis">
      <h4>Complexity for <var>n</var> sorted values</h4>
      <dl><div><dt>Time</dt><dd>O(log <var>n</var>) comparisons: each step halves the remaining range.</dd></div>
        <div><dt>Auxiliary space</dt><dd>O(1) for this iterative version; this excludes the input list.</dd></div></dl>
      <p>Assumes the values are already sorted. These are analytical bounds, not measured timings.</p>
    </section>
    <div className="practice-run-actions" role="group" aria-label="Search step controls">
      <button className="button" type="button" disabled={index === 0}
        onClick={() => setIndex(current => Math.max(0, current - 1))}>Previous step</button>
      <button className="button primary" type="button" disabled={finished}
        onClick={() => setIndex(current => Math.min(steps.length - 1, current + 1))}>Next step</button>
      <button className="button" type="button" disabled={index === 0} onClick={() => setIndex(0)}>Reset search</button>
    </div>
  </section>
}
