export type CompilerFamily = 'clang' | 'gcc' | 'unknown'
export type DiagnosticSeverity = 'error' | 'fatal error' | 'warning' | 'note'

export type DiagnosticCategory =
  | 'missing-semicolon'
  | 'undeclared-identifier'
  | 'scope-conflict'
  | 'incompatible-types'
  | 'argument-count'
  | 'argument-types'
  | 'invalid-dereference'
  | 'runtime-memory-fault'
  | 'unclassified-compiler'
  | 'unclassified-runtime'

export type ConceptId =
  | 'statements' | 'names' | 'scope' | 'types' | 'functions' | 'pointers' | 'memory'
  | 'operators' | 'conditions' | 'loops' | 'arrays' | 'diagnostics'

export interface LearningTopic {
  id: ConceptId
  title: string
}

export interface LearningConcept extends LearningTopic {
  explanation: string
  example: string
  exampleExplanation: string
  misconceptions: string[]
  related: ConceptId[]
  reference: { title: string; text: string }
}

export interface LearningDiagnostic {
  language: 'c'
  compiler: CompilerFamily
  severity: DiagnosticSeverity
  category: DiagnosticCategory
  phase: 'compile' | 'runtime'
  location?: { file: string; line: number; column?: number }
  raw: string
  concepts: ConceptId[]
  confidence: 'high' | 'uncertain'
  occurrence?: 'new' | 'unchanged' | 'repeated' | 'related'
}

export interface LearningFeedback {
  diagnostics: LearningDiagnostic[]
  resolved: DiagnosticCategory[]
  historyUnavailable?: boolean
}

export interface LearningHistory {
  categories: Array<{
    category: DiagnosticCategory
    encountered: number
    repeated: number
    resolved: number
  }>
  topics: Array<{ id: ConceptId; viewed: number; selected: number }>
}

export interface LearningBridge {
  getTopics(): Promise<LearningTopic[]>
  getConcept(id: ConceptId): Promise<LearningConcept>
  getHistory(): Promise<LearningHistory>
  clearHistory(): Promise<void>
  recordTopic(id: ConceptId, action: 'viewed' | 'selected'): Promise<void>
}

export const diagnosticTitles: Readonly<Record<DiagnosticCategory, string>> = {
  'missing-semicolon': 'Statement boundary',
  'undeclared-identifier': 'Name not declared here',
  'scope-conflict': 'Conflicting declarations',
  'incompatible-types': 'Incompatible types',
  'argument-count': 'Argument count',
  'argument-types': 'Argument types',
  'invalid-dereference': 'Invalid pointer dereference',
  'runtime-memory-fault': 'Memory access fault',
  'unclassified-compiler': 'Compiler diagnostic',
  'unclassified-runtime': 'Runtime failure',
}
