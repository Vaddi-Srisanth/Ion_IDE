export const traversalGraph = {
  A: ['B', 'C'],
  B: ['D', 'E'],
  C: ['F'],
  D: [],
  E: ['F'],
  F: [],
} as const

export type TraversalNode = keyof typeof traversalGraph
export const traversalStarts = ['A', 'C', 'F'] as const satisfies readonly TraversalNode[]
