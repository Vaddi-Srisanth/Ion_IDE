import { useId, useState } from 'react'
import './breadth-first-search.css'

const graph = {
  A: ['B', 'C'],
  B: ['D', 'E'],
  C: ['F'],
  D: [],
  E: ['F'],
  F: [],
} as const
type Node = keyof typeof graph
const starts = ['A', 'C', 'F'] as const satisfies readonly Node[]
type Step = { current: Node; queue: Node[]; discovered: Node[]; processed: Node[]; edges: string[] }

function trace(start: Node): Step[] {
  const queue: Node[] = [start]
  const discovered: Node[] = [start]
  const processed: Node[] = []
  const edges: string[] = []
  const steps: Step[] = []
  while (queue.length) {
    const current = queue.shift()!
    processed.push(current)
    for (const next of graph[current]) {
      if (discovered.includes(next)) continue
      discovered.push(next)
      queue.push(next)
      edges.push(current + '→' + next)
    }
    steps.push({ current, queue: [...queue], discovered: [...discovered], processed: [...processed], edges: [...edges] })
  }
  return steps
}

function explanation(step: Step, start: Node) {
  if (!step.queue.length) return 'The queue is empty. Every node reachable from ' + start + ' has been processed.'
  const neighbors = graph[step.current].filter(node => step.edges.includes(step.current + '→' + node))
  if (!neighbors.length) return 'Remove ' + step.current + ' from the front of the queue. It has no newly discovered neighbors.'
  return 'Remove ' + step.current + ' from the front of the queue. Enqueue its unvisited neighbors '
    + neighbors.join(', ') + ' in listed order.'
}

export default function BreadthFirstSearchWalkthrough() {
  const title = useId()
  const [start, setStart] = useState<Node>('A')
  const [index, setIndex] = useState(0)
  const steps = trace(start)
  const step = steps[index]
  const finished = index === steps.length - 1

  return <section className="practice-breadth-first" aria-labelledby={title}>
    <div className="practice-bfs-heading">
      <h3 id={title}>Breadth-first search</h3>
      <label className="practice-label">Start node
        <select value={start} onChange={event => {
          const selected = starts.find(value => value === event.currentTarget.value)
          if (!selected) return
          setStart(selected)
          setIndex(0)
        }}>{starts.map(node => <option key={node} value={node}>{node}</option>)}</select>
      </label>
    </div>
    <p className="practice-muted">BFS explores a directed graph in layers. It uses a first-in, first-out queue and marks nodes when they are enqueued.</p>
    <ul className="practice-bfs-graph" aria-label="Directed graph adjacency list">
      {(Object.keys(graph) as Node[]).map(node => <li key={node}><strong>{node}</strong><span>→ {graph[node].join(', ') || '—'}</span></li>)}
    </ul>
    <ol className="practice-bfs-nodes" role="list" aria-label="Node states">
      {(Object.keys(graph) as Node[]).map(node => {
        const state = node === step.current ? 'current' : step.processed.includes(node) ? 'processed'
          : step.queue.includes(node) ? 'queued' : 'unseen'
        const label = state === 'current' ? 'current' : state === 'processed' ? 'processed'
          : state === 'queued' ? 'queued' : 'not discovered'
        return <li key={node} data-node-state={state} aria-label={node + ', ' + label}>
          <strong>{node}</strong><span>{label}</span>
        </li>
      })}
    </ol>
    <section aria-label="Traversal state">
      <dl className="practice-bfs-state">
        <div><dt>Current</dt><dd>{step.current}</dd></div>
        <div><dt>Queue · front first</dt><dd>{step.queue.join(', ') || 'Empty'}</dd></div>
        <div><dt>Discovered</dt><dd>{step.discovered.join(', ')}</dd></div>
        <div><dt>Processed</dt><dd>{step.processed.join(', ')}</dd></div>
        <div><dt>Tree edges</dt><dd>{step.edges.join(', ') || 'None yet'}</dd></div>
      </dl>
    </section>
    <div className="practice-bfs-explanation" role="status" aria-atomic="true">
      <h4>{finished ? 'Traversal complete' : 'Step ' + (index + 1)}</h4>
      <p>{explanation(step, start)}</p>
      {step.current === 'E' && start === 'A' && <p>F was already marked when C enqueued it, so E does not add F again.</p>}
    </div>
    <section className="practice-bfs-complexity" aria-label="Complexity analysis">
      <h4>Complexity for <var>V</var> nodes and <var>E</var> edges</h4>
      <dl><div><dt>Time</dt><dd>O(V + E): each reachable node and outgoing edge is examined at most once.</dd></div>
        <div><dt>Auxiliary space</dt><dd>O(V) for the queue and discovered set.</dd></div></dl>
      <p>Assumes adjacency-list input. These are analytical bounds, not measured timings.</p>
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
