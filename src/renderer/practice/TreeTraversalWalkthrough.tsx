import { useId, useState } from 'react'
import './tree-traversal.css'

type NodeName = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
type Order = 'preorder' | 'inorder' | 'postorder' | 'levelorder'
type TreeNode = { left?: NodeName; right?: NodeName }
type Step = { current: NodeName; visited: NodeName[]; stack: NodeName[]; queue: NodeName[]; explanation: string }

const tree: Record<NodeName, TreeNode> = {
  A: { left: 'B', right: 'C' }, B: { left: 'D', right: 'E' }, C: { right: 'F' }, D: {}, E: {}, F: {},
}
const orders: { value: Order; label: string; rule: string }[] = [
  { value: 'preorder', label: 'Preorder', rule: 'Node, left subtree, right subtree' },
  { value: 'inorder', label: 'Inorder', rule: 'Left subtree, node, right subtree' },
  { value: 'postorder', label: 'Postorder', rule: 'Left subtree, right subtree, node' },
  { value: 'levelorder', label: 'Level order', rule: 'Visit each level from left to right' },
]

function trace(order: Order): Step[] {
  const steps: Step[] = []
  const visited: NodeName[] = []
  if (order === 'levelorder') {
    const queue: NodeName[] = ['A']
    while (queue.length) {
      const current = queue.shift()!
      visited.push(current)
      const node = tree[current]
      if (node.left) queue.push(node.left)
      if (node.right) queue.push(node.right)
      steps.push({ current, visited: [...visited], stack: [], queue: [...queue],
        explanation: 'Remove ' + current + ' from the front of the queue, visit it, then enqueue its existing left and right children.' })
    }
    return steps
  }

  function walk(current: NodeName, ancestors: NodeName[]): void {
    const stack = [...ancestors, current]
    const node = tree[current]
    const visit = (explanation: string) => {
      visited.push(current)
      steps.push({ current, visited: [...visited], stack, queue: [], explanation })
    }
    if (order === 'preorder') visit('Visit ' + current + ' when its recursive call begins, before either child.')
    if (node.left) walk(node.left, stack)
    if (order === 'inorder') visit('Visit ' + current + ' after its left subtree returns and before its right subtree.')
    if (node.right) walk(node.right, stack)
    if (order === 'postorder') visit('Visit ' + current + ' after both child calls return.')
  }
  walk('A', [])
  return steps
}

export default function TreeTraversalWalkthrough() {
  const title = useId()
  const [order, setOrder] = useState<Order>('preorder')
  const [index, setIndex] = useState(0)
  const steps = trace(order)
  const step = steps[index]
  const finished = index === steps.length - 1
  const selected = orders.find(item => item.value === order)!

  return <section className="practice-tree" aria-labelledby={title}>
    <div className="practice-tree-heading">
      <h3 id={title}>Binary tree traversals</h3>
      <label className="practice-label">Traversal order
        <select aria-label="Traversal order" value={order} onChange={event => {
          const next = orders.find(item => item.value === event.currentTarget.value)?.value
          if (next) { setOrder(next); setIndex(0) }
        }}>{orders.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
      </label>
    </div>
    <p className="practice-muted">The same six-node binary tree produces a different visit order depending on when each node is processed.</p>
    <section className="practice-tree-figure" aria-label="Binary tree structure">
      <ul className="practice-tree-level"><li data-node-state={step.current === 'A' ? 'current' : step.visited.includes('A') ? 'visited' : 'unvisited'}>A</li></ul>
      <ul className="practice-tree-level">
        {(['B', 'C'] as const).map(node => <li key={node} data-node-state={step.current === node ? 'current' : step.visited.includes(node) ? 'visited' : 'unvisited'}>{node}</li>)}
      </ul>
      <ul className="practice-tree-level">
        {(['D', 'E', '—', 'F'] as const).map((node, index) => <li key={index} data-node-state={node !== '—' && step.current === node ? 'current' : node !== '—' && step.visited.includes(node) ? 'visited' : 'unvisited'}>{node}</li>)}
      </ul>
      <p>A → (B, C), B → (D, E), C → (—, F)</p>
    </section>
    <section className="practice-tree-state" aria-label="Traversal state">
      <dl>
        <div><dt>Rule</dt><dd>{selected.rule}</dd></div>
        <div><dt>Current node</dt><dd>{step.current}</dd></div>
        {order === 'levelorder' ? <div><dt>Queue · front first</dt><dd>{step.queue.join(', ') || 'Empty'}</dd></div>
          : <div><dt>Recursive call path</dt><dd>{step.stack.join(' → ')}</dd></div>}
        <div><dt>Visit order so far</dt><dd>{step.visited.join(', ')}</dd></div>
      </dl>
    </section>
    <div className="practice-tree-explanation" role="status" aria-atomic="true">
      <h4>{finished ? 'Traversal complete' : 'Step ' + (index + 1) + ' of ' + steps.length}</h4>
      <p>{step.explanation}</p>
    </div>
    <section className="practice-tree-complexity" aria-label="Complexity analysis">
      <h4>Complexity for <var>n</var> nodes</h4>
      <dl><div><dt>Time</dt><dd>O(n): each node is visited once.</dd></div>
        <div><dt>Auxiliary space</dt><dd>O(h) call stack for depth-first orders; O(w) queue for level order, where h is tree height and w is maximum level width.</dd></div></dl>
      <p>These are analytical bounds, not measured timings. The lesson retains one display snapshot per step for replay.</p>
    </section>
    <div className="practice-run-actions" role="group" aria-label="Traversal step controls">
      <button className="button" type="button" disabled={index === 0} onClick={() => setIndex(value => Math.max(0, value - 1))}>Previous step</button>
      <button className="button primary" type="button" disabled={finished} onClick={() => setIndex(value => Math.min(steps.length - 1, value + 1))}>Next step</button>
      <button className="button" type="button" disabled={index === 0} onClick={() => setIndex(0)}>Reset traversal</button>
    </div>
  </section>
}
