export const weightedGraph = {
  A: [{ to: 'B', weight: 4 }, { to: 'C', weight: 1 }],
  B: [{ to: 'D', weight: 1 }, { to: 'E', weight: 7 }],
  C: [{ to: 'B', weight: 2 }, { to: 'D', weight: 5 }],
  D: [{ to: 'E', weight: 3 }],
  E: [],
} as const

export type WeightedNode = keyof typeof weightedGraph
export const weightedNodes = ['A', 'B', 'C', 'D', 'E'] as const satisfies readonly WeightedNode[]
export const dijkstraStarts = ['A', 'C', 'E'] as const satisfies readonly WeightedNode[]
