import { useId, useState } from 'react'
import './merge-sort.css'

type Step = { kind: 'split' | 'base' | 'merge'; values: number[]; stack: string[]; left: number[]; right: number[]; result: number[] }

function trace(values: number[]): Step[] {
  const steps: Step[] = []
  function sort(input: number[], stack: string[]): number[] {
    if (input.length <= 1) {
      steps.push({ kind: 'base', values: input, stack, left: [], right: [], result: input })
      return input
    }
    const middle = Math.floor(input.length / 2)
    const left = input.slice(0, middle), right = input.slice(middle)
    const call = `[${input.join(', ')}]`
    const nested = [...stack, call]
    steps.push({ kind: 'split', values: input, stack: nested, left, right, result: [] })
    const sortedLeft = sort(left, nested)
    const sortedRight = sort(right, nested)
    const merged: number[] = []
    let i = 0, j = 0
    while (i < sortedLeft.length && j < sortedRight.length) {
      if (sortedLeft[i] <= sortedRight[j]) merged.push(sortedLeft[i++])
      else merged.push(sortedRight[j++])
    }
    merged.push(...sortedLeft.slice(i), ...sortedRight.slice(j))
    steps.push({ kind: 'merge', values: input, stack: nested, left: sortedLeft, right: sortedRight, result: merged })
    return merged
  }
  sort(values, [])
  return steps
}

export default function MergeSortWalkthrough() {
  const title = useId()
  const [index, setIndex] = useState(0)
  const steps = trace([8, 3, 5, 1])
  const step = steps[index]
  const finished = index === steps.length - 1
  const label = (values: number[]) => values.length ? `[${values.join(', ')}]` : '—'

  return <section className="practice-merge-sort" aria-labelledby={title}>
    <h3 id={title}>Merge sort</h3>
    <p className="practice-muted">Divide the array until each run has one value, then merge sorted runs. This top-down version recursively sorts the left half before the right half.</p>
    <section aria-label="Merge sort step">
      <div className="practice-merge-operation" role="status" aria-atomic="true">
        <h4>{finished ? 'Array sorted' : `Step ${index + 1}: ${step.kind === 'split' ? 'Divide' : step.kind === 'base' ? 'Base case' : 'Merge'}`}</h4>
        {step.kind === 'split' && <p>Split {label(step.values)} into {label(step.left)} and {label(step.right)}.</p>}
        {step.kind === 'base' && <p>{label(step.result)} is already sorted: a run with zero or one value needs no comparisons.</p>}
        {step.kind === 'merge' && <p>Merge sorted runs {label(step.left)} and {label(step.right)} in order to get {label(step.result)}.</p>}
        {finished && <p>The final merge preserves every value and produces {label(step.result)}.</p>}
      </div>
    </section>
    <section aria-label="Recursive call stack">
      <h4>Active calls · outermost first</h4>
      <ol className="practice-merge-stack" role="list">
        {step.stack.length ? step.stack.map((call, position) => <li key={position}>{`sort ${call}`}</li>) : <li>Initial call is ready</li>}
      </ol>
    </section>
    <dl className="practice-merge-runs" aria-label="Merge state">
      <div><dt>Left run</dt><dd>{step.kind === 'split' ? label(step.left) : label(step.left)}</dd></div>
      <div><dt>Right run</dt><dd>{label(step.right)}</dd></div>
      <div><dt>Result run</dt><dd>{label(step.result)}</dd></div>
    </dl>
    <section className="practice-merge-complexity" aria-label="Complexity analysis">
      <h4>Top-down merge sort</h4>
      <dl><div><dt>Time</dt><dd>O(n log n) in best, average and worst cases: there are log n split levels and each level merges n values.</dd></div>
        <div><dt>Auxiliary space</dt><dd>O(n) for merge buffers, plus O(log n) recursive stack frames.</dd></div></dl>
      <p>Assumes array input and a comparison-based merge. These are analytical bounds, not measured timings; the lesson retains snapshots for replay.</p>
    </section>
    <div className="practice-run-actions" role="group" aria-label="Merge sort step controls">
      <button className="button" type="button" disabled={index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}>Previous step</button>
      <button className="button primary" type="button" disabled={finished} onClick={() => setIndex(value => Math.min(steps.length - 1, value + 1))}>Next step</button>
      <button className="button" type="button" disabled={index === 0} onClick={() => setIndex(0)}>Reset walkthrough</button>
    </div>
  </section>
}
