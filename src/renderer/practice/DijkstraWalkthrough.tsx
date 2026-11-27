import { useId, useState } from 'react'
import { dijkstraStarts as starts, weightedGraph as graph, weightedNodes as nodes, type WeightedNode as Node } from './weighted-graph'
import './dijkstra.css'

type Step = {
  current: Node
  distances: Record<Node, number>
  predecessors: Partial<Record<Node, Node>>
  settled: Node[]
  frontier: Node[]
  relaxations: string[]
}

function distanceText(value: number) { return Number.isFinite(value) ? String(value) : '∞' }

function trace(start: Node): Step[] {
  const distances = Object.fromEntries(nodes.map(node => [node, node === start ? 0 : Infinity])) as Record<Node, number>
  const predecessors: Partial<Record<Node, Node>> = {}
  const settled = new Set<Node>()
  const steps: Step[] = []

  while (true) {
    const available = nodes.filter(node => !settled.has(node) && Number.isFinite(distances[node]))
    if (!available.length) break
    const current = available.reduce((best, node) => distances[node] < distances[best] ? node : best)
    settled.add(current)
    const relaxations: string[] = []
    for (const edge of graph[current]) {
      const candidate = distances[current] + edge.weight
      if (candidate >= distances[edge.to]) continue
      const previous = distances[edge.to]
      distances[edge.to] = candidate
      predecessors[edge.to] = current
      relaxations.push(`${edge.to}: ${distanceText(previous)} → ${candidate} via ${current}`)
    }
    const frontier = nodes.filter(node => !settled.has(node) && Number.isFinite(distances[node]))
    steps.push({ current, distances: { ...distances }, predecessors: { ...predecessors }, settled: [...settled], frontier, relaxations })
  }
  return steps
}

export default function DijkstraWalkthrough() {
  const title = useId()
  const [start, setStart] = useState<Node>('A')
  const [index, setIndex] = useState(0)
  const steps = trace(start)
  const step = steps[index]
  const finished = index === steps.length - 1

  return <section className="practice-dijkstra" aria-labelledby={title}>
    <div className="practice-dijkstra-heading">
      <h3 id={title}>Dijkstra’s shortest-path algorithm</h3>
      <label className="practice-label">Start node
        <select value={start} onChange={event => {
          const selected = starts.find(value => value === event.currentTarget.value)
          if (!selected) return
          setStart(selected)
          setIndex(0)
        }}>{starts.map(node => <option key={node} value={node}>{node}</option>)}</select>
      </label>
    </div>
    <p className="practice-muted">Choose the unsettled node with the smallest known distance, then relax its outgoing edges. Dijkstra requires non-negative edge weights.</p>
    <ul className="practice-dijkstra-graph" aria-label="Weighted directed graph adjacency list">
      {nodes.map(node => <li key={node}><strong>{node}</strong><span>{graph[node].map(({ to, weight }) => `${to} (${weight})`).join(', ') || '—'}</span></li>)}
    </ul>
    <ol className="practice-dijkstra-nodes" role="list" aria-label="Shortest-path distances">
      {nodes.map(node => {
        const state = node === step.current ? 'current' : step.settled.includes(node) ? 'settled'
          : step.frontier.includes(node) ? 'frontier' : 'unreached'
        const label = state === 'current' ? 'current' : state === 'settled' ? 'settled'
          : state === 'frontier' ? 'unsettled' : 'unreachable so far'
        const predecessor = step.predecessors[node]
        return <li key={node} data-node-state={state} aria-label={`${node}: distance ${distanceText(step.distances[node])}, ${label}`}>
          <strong>{node}</strong><span>{distanceText(step.distances[node])}</span>
          <small>{predecessor ? `via ${predecessor}` : 'no predecessor'}</small>
        </li>
      })}
    </ol>
    <section aria-label="Shortest-path state">
      <dl className="practice-dijkstra-state">
        <div><dt>Current minimum</dt><dd>{step.current} · {step.distances[step.current]}</dd></div>
        <div><dt>Unsettled with finite distance</dt><dd>{step.frontier.map(node => `${node}: ${step.distances[node]}`).join(', ') || 'Empty'}</dd></div>
        <div><dt>Settled</dt><dd>{step.settled.join(', ')}</dd></div>
        <div><dt>Predecessors</dt><dd>{nodes.filter(node => step.predecessors[node]).map(node => `${node}←${step.predecessors[node]}`).join(', ') || 'None yet'}</dd></div>
      </dl>
    </section>
    <div className="practice-dijkstra-explanation" role="status" aria-atomic="true">
      <h4>{finished ? 'Shortest paths complete' : `Step ${index + 1}`}</h4>
      <p>Settle {step.current}, the unsettled node with the smallest finite distance ({step.distances[step.current]}).</p>
      <p>{step.relaxations.length ? `Improved distances: ${step.relaxations.join('; ')}.` : 'No outgoing edge improves a distance.'}</p>
      {finished && <p>Nodes still at ∞ are unreachable from {start}.</p>}
    </div>
    <section className="practice-dijkstra-complexity" aria-label="Complexity analysis">
      <h4>Array-based implementation</h4>
      <dl><div><dt>Time</dt><dd>O(V² + E): each minimum selection scans up to V nodes, and each outgoing edge is relaxed once.</dd></div>
        <div><dt>Auxiliary space</dt><dd>O(V) for distances, predecessors and settled nodes; the graph input is excluded.</dd></div></dl>
      <p>Assumes non-negative weights and adjacency-list input. These are analytical bounds, not measured timings; the lesson retains replay snapshots.</p>
    </section>
    <div className="practice-run-actions" role="group" aria-label="Shortest-path step controls">
      <button className="button" type="button" disabled={index === 0}
        onClick={() => setIndex(current => Math.max(0, current - 1))}>Previous step</button>
      <button className="button primary" type="button" disabled={finished}
        onClick={() => setIndex(current => Math.min(steps.length - 1, current + 1))}>Next step</button>
      <button className="button" type="button" disabled={index === 0} onClick={() => setIndex(0)}>Reset traversal</button>
    </div>
  </section>
}
