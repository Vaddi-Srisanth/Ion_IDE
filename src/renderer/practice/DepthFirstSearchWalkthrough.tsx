import { useId, useState } from 'react'
import { traversalGraph as graph, traversalStarts as starts, type TraversalNode as Node } from './graph-traversal'
import './depth-first-search.css'

type Step = { current: Node; stack: Node[]; discovered: Node[]; processed: Node[]; edges: string[] }

function trace(start: Node): Step[] {
  const stack: Node[] = [start]
  const discovered = new Set<Node>([start])
  const discoveredOrder: Node[] = [start]
  const processed: Node[] = []
  const edges: string[] = []
  const steps: Step[] = []
  while (stack.length) {
    const current = stack.pop()!
    processed.push(current)
    const next = graph[current].filter(node => !discovered.has(node))
    for (const node of [...next].reverse()) {
      discovered.add(node)
      discoveredOrder.push(node)
      stack.push(node)
      edges.push(current + '→' + node)
    }
    steps.push({ current, stack: [...stack].reverse(), discovered: [...discoveredOrder], processed: [...processed], edges: [...edges] })
  }
  return steps
}

function explanation(step: Step, start: Node) {
  if (!step.stack.length) return 'The stack is empty. Every node reachable from ' + start + ' has been processed.'
  const neighbors = graph[step.current].filter(node => step.edges.includes(step.current + '→' + node))
  if (!neighbors.length) return 'Pop ' + step.current + ' from the top of the stack. It has no newly discovered neighbors.'
  return 'Pop ' + step.current + '. Push its unvisited neighbors ' + neighbors.join(', ')
    + ' in reverse listed order so ' + neighbors[0] + ' is visited first.'
}

export default function DepthFirstSearchWalkthrough() {
  const title = useId()
  const [start, setStart] = useState<Node>('A')
  const [index, setIndex] = useState(0)
  const steps = trace(start)
  const step = steps[index]
  const finished = index === steps.length - 1

  return <section className="practice-depth-first" aria-labelledby={title}>
    <div className="practice-dfs-heading">
      <h3 id={title}>Depth-first search</h3>
      <label className="practice-label">Start node
        <select value={start} onChange={event => {
          const selected = starts.find(value => value === event.currentTarget.value)
          if (!selected) return
          setStart(selected)
          setIndex(0)
        }}>{starts.map(node => <option key={node} value={node}>{node}</option>)}</select>
      </label>
    </div>
    <p className="practice-muted">DFS follows one path deeply before backtracking. This version uses a last-in, first-out stack and marks nodes when pushed.</p>
    <ul className="practice-dfs-graph" aria-label="Directed graph adjacency list">
      {(Object.keys(graph) as Node[]).map(node => <li key={node}><strong>{node}</strong><span>→ {graph[node].join(', ') || '—'}</span></li>)}
    </ul>
    <ol className="practice-dfs-nodes" role="list" aria-label="Node states">
      {(Object.keys(graph) as Node[]).map(node => {
        const state = node === step.current ? 'current' : step.processed.includes(node) ? 'processed'
          : step.stack.includes(node) ? 'stacked' : 'unseen'
        const label = state === 'current' ? 'current' : state === 'processed' ? 'processed'
          : state === 'stacked' ? 'on stack' : 'not discovered'
        return <li key={node} data-node-state={state} aria-label={node + ', ' + label}>
          <strong>{node}</strong><span>{label}</span>
        </li>
      })}
    </ol>
    <section aria-label="Traversal state">
      <dl className="practice-dfs-state">
        <div><dt>Current</dt><dd>{step.current}</dd></div>
        <div><dt>Stack · top first</dt><dd>{step.stack.join(', ') || 'Empty'}</dd></div>
        <div><dt>Discovered</dt><dd>{step.discovered.join(', ')}</dd></div>
        <div><dt>Processed</dt><dd>{step.processed.join(', ')}</dd></div>
        <div><dt>Tree edges</dt><dd>{step.edges.join(', ') || 'None yet'}</dd></div>
      </dl>
    </section>
    <div className="practice-dfs-explanation" role="status" aria-atomic="true">
      <h4>{finished ? 'Traversal complete' : 'Step ' + (index + 1)}</h4>
      <p>{explanation(step, start)}</p>
      {step.current === 'C' && start === 'A' && <p>F was already marked when E pushed it, so C does not add F again.</p>}
    </div>
    <section className="practice-dfs-complexity" aria-label="Complexity analysis">
      <h4>Complexity for <var>V</var> nodes and <var>E</var> edges</h4>
      <dl><div><dt>Time</dt><dd>O(V + E): each reachable node and outgoing edge is examined at most once.</dd></div>
        <div><dt>Auxiliary space</dt><dd>O(V) for the explicit stack and discovered set.</dd></div></dl>
      <p>Assumes adjacency-list input. These are analytical bounds, not measured timings; the bounds describe traversal state, while this lesson retains step snapshots so you can replay it.</p>
    </section>
    <div className="practice-run-actions" role="group" aria-label="Traversal step controls">
      <button className="button" type="button" disabled={index === 0}
        onClick={() => setIndex(current => Math.max(0, current - 1))}>Previous step</button>
      <button className="button primary" type="button" disabled={finished}
        onClick={() => setIndex(current => Math.min(steps.length - 1, current + 1))}>Next step</button>
      <button className="button" type="button" disabled={index === 0} onClick={() => setIndex(0)}>Reset traversal</button>
    </div>
  </section>
}
