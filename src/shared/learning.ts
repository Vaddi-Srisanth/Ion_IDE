import type { RunLanguage } from './run-console'

export const learningDiagnosticLanguages: readonly RunLanguage[] = ['c', 'java', 'python', 'cpp', 'javascript']

export type CompilerFamily = 'clang' | 'gcc' | 'javac' | 'python' | 'node' | 'unknown'
export type DiagnosticSeverity = 'error' | 'fatal error' | 'warning' | 'note'

export type DiagnosticCategory =
  | 'missing-semicolon'
  | 'undeclared-identifier'
  | 'scope-conflict'
  | 'incompatible-types'
  | 'argument-count'
  | 'argument-types'
  | 'format-argument-type'
  | 'invalid-dereference'
  | 'runtime-memory-fault'
  | 'java-statement-boundary'
  | 'java-unresolved-variable'
  | 'java-incompatible-types'
  | 'java-null-reference'
  | 'java-array-index'
  | 'python-undefined-name'
  | 'python-statement-colon'
  | 'python-indentation'
  | 'python-index-range'
  | 'python-operand-types'
  | 'cpp-statement-boundary'
  | 'cpp-unresolved-name'
  | 'cpp-incompatible-types'
  | 'cpp-reference-binding'
  | 'cpp-memory-access'
  | 'javascript-undefined-name'
  | 'javascript-null-property'
  | 'javascript-not-callable'
  | 'javascript-redeclared-binding'
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

export interface CompilerProblem {
  severity: DiagnosticSeverity
  location?: { file: string; line: number; column?: number }
  raw: string
}

export interface LearningDiagnostic extends CompilerProblem {
  language: RunLanguage
  compiler: CompilerFamily
  category: DiagnosticCategory
  phase: 'compile' | 'runtime'
  concepts: ConceptId[]
  packTopic?: string
  guidance?: string
  confidence: 'high' | 'uncertain'
  occurrence?: 'new' | 'unchanged' | 'repeated' | 'related'
}

export interface LearningFeedback {
  language: RunLanguage
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

export const diagnosticConcepts: Readonly<Partial<Record<DiagnosticCategory, ConceptId[]>>> = {
  'missing-semicolon': ['statements'],
  'undeclared-identifier': ['names', 'scope'],
  'scope-conflict': ['scope', 'names'],
  'incompatible-types': ['types'],
  'argument-count': ['functions'],
  'argument-types': ['functions', 'types'],
  'format-argument-type': ['functions', 'types'],
  'invalid-dereference': ['pointers', 'types'],
  'runtime-memory-fault': ['memory', 'pointers'],
}

export const diagnosticTitles: Readonly<Record<DiagnosticCategory, string>> = {
  'missing-semicolon': 'Statement boundary',
  'undeclared-identifier': 'Name not declared here',
  'scope-conflict': 'Conflicting declarations',
  'incompatible-types': 'Incompatible types',
  'argument-count': 'Argument count',
  'argument-types': 'Argument types',
  'format-argument-type': 'Format argument type mismatch',
  'invalid-dereference': 'Invalid pointer dereference',
  'runtime-memory-fault': 'Memory access fault',
  'java-statement-boundary': 'Java statement boundary',
  'java-unresolved-variable': 'Java variable not in scope',
  'java-incompatible-types': 'Java type conversion',
  'java-null-reference': 'Java null reference',
  'java-array-index': 'Java array index out of bounds',
  'python-undefined-name': 'Python name not defined',
  'python-statement-colon': 'Python block header colon',
  'python-indentation': 'Python block indentation',
  'python-index-range': 'Python list or tuple index out of range',
  'python-operand-types': 'Python operand types',
  'cpp-statement-boundary': 'C++ statement boundary',
  'cpp-unresolved-name': 'C++ name not in scope',
  'cpp-incompatible-types': 'C++ type conversion',
  'cpp-reference-binding': 'C++ reference binding',
  'cpp-memory-access': 'C++ memory access fault',
  'javascript-undefined-name': 'JavaScript name not defined',
  'javascript-null-property': 'JavaScript property on null or undefined',
  'javascript-not-callable': 'JavaScript value is not callable',
  'javascript-redeclared-binding': 'JavaScript binding already declared',
  'unclassified-compiler': 'Compiler diagnostic',
  'unclassified-runtime': 'Runtime failure',
}
