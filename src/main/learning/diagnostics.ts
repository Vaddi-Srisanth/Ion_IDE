import { basename } from 'node:path'
import type { RunResult } from '../../shared/contracts'
import type {
  CompilerFamily, ConceptId, DiagnosticCategory, DiagnosticSeverity, LearningDiagnostic,
} from '../../shared/learning'

interface ParsedDiagnostic {
  message: string
  raw: string
  severity: DiagnosticSeverity
  location?: LearningDiagnostic['location']
}

interface Classification {
  category: DiagnosticCategory
  context?: string
}

export interface ClassifiedDiagnostic extends LearningDiagnostic {
  context?: string
}

const maxDiagnostics = 24
const maxRawLength = 2200
const severity = '(fatal error|error|warning|note)'
const clangLocation = new RegExp(`^(.*?):(\\d+):(\\d+): ${severity}: (.+)$`)
const gccLocation = new RegExp(`^(.*?):(\\d+)(?::(\\d+))?: ${severity}: (.+)$`)
const compilerHeader = new RegExp(`^(?:(?:clang(?:-\\d+)?|gcc(?:-\\d+)?|cc1|ld): )?${severity}: (.+)$`)

export const relatedConcepts: Record<DiagnosticCategory, ConceptId[]> = {
  'missing-semicolon': ['statements'],
  'undeclared-identifier': ['names', 'scope'],
  'scope-conflict': ['scope', 'names'],
  'incompatible-types': ['types'],
  'argument-count': ['functions'],
  'argument-types': ['functions', 'types'],
  'invalid-dereference': ['pointers', 'types'],
  'runtime-memory-fault': ['memory', 'pointers'],
  'unclassified-compiler': [],
  'unclassified-runtime': [],
}

function compilerFamily(executable: string | null): CompilerFamily {
  if (!executable) return 'unknown'
  const name = basename(executable).toLowerCase()
  if (/^(?:[\w]+-)*clang(?:-\d+)?(?:\.exe)?$/.test(name)) return 'clang'
  if (/^(?:[\w]+-)*gcc(?:-\d+)?(?:\.exe)?$/.test(name)) return 'gcc'
  return 'unknown'
}

function parseOutput(output: string, family: CompilerFamily): ParsedDiagnostic[] {
  const records: ParsedDiagnostic[] = []
  let current: ParsedDiagnostic | undefined
  for (const line of output.split(/\r?\n/)) {
    const location = (family === 'clang' ? clangLocation : gccLocation).exec(line)
    const header = location ? null : compilerHeader.exec(line)
    if (location || header) {
      if (records.length === maxDiagnostics) break
      if (location) {
        const [, file, row, column, level, message] = location
        current = {
          message, raw: line.slice(0, maxRawLength), severity: level as DiagnosticSeverity,
          location: { file, line: Number(row), ...(column ? { column: Number(column) } : {}) },
        }
      } else if (header) {
        const [, level, message] = header
        current = { message, raw: line.slice(0, maxRawLength), severity: level as DiagnosticSeverity }
      }
      if (current) records.push(current)
      continue
    }
    if (current && line && current.raw.length < maxRawLength
      && !/^\d+ (?:error|warning)s? generated\.$/.test(line)) {
      current.raw = (current.raw + '\n' + line).slice(0, maxRawLength)
    }
  }
  return records
}

function classifyClang(message: string): Classification | undefined {
  if (/^expected ';' (?:after (?:expression|return statement|break statement|continue statement)|at end of declaration)$/.test(message)) {
    return { category: 'missing-semicolon' }
  }
  const name = /^use of undeclared identifier '([a-z_]\w*)'(?:; did you mean '[^']+'\?)?$/i.exec(message)
  if (name) return { category: 'undeclared-identifier', context: name[1] }
  const redefinition = /^redefinition of '([a-z_]\w*)'(?: with a different type: .+)?$/i.exec(message)
  if (redefinition) return { category: 'scope-conflict', context: redefinition[1] }
  if (/^too (?:few|many) arguments to function call, (?:expected |single argument ).+$/.test(message)) {
    return { category: 'argument-count' }
  }
  if (/^incompatible (?:(?:integer to pointer|pointer to integer) conversion|pointer types) passing .+ to parameter of type .+$/.test(message)
    || /^passing .+ to parameter of incompatible type .+$/.test(message)) {
    return { category: 'argument-types' }
  }
  if (/^incompatible (?:(?:integer to pointer|pointer to integer) conversion|pointer types) (?:initializing|assigning to|returning) .+$/.test(message)
    || /^(?:initializing|assigning to) .+ (?:with an expression of|from) incompatible type .+$/.test(message)
    || /^returning .+ from a function with incompatible result type .+$/.test(message)) {
    return { category: 'incompatible-types' }
  }
  if (/^indirection requires pointer operand \('.+' invalid\)$/.test(message)) {
    return { category: 'invalid-dereference' }
  }
}

function classifyGcc(message: string): Classification | undefined {
  if (/^expected (?:',' or )?';' before '(?:return|break|continue|\})'(?: token)?$/.test(message)) {
    return { category: 'missing-semicolon' }
  }
  const name = /^'([a-z_]\w*)' undeclared(?: \(first use in this function\))?$/i.exec(message)
  if (name) return { category: 'undeclared-identifier', context: name[1] }
  const redeclaration = /^(?:redeclaration of '([a-z_]\w*)' with no linkage|redefinition of '([a-z_]\w*)')$/i.exec(message)
  if (redeclaration) return { category: 'scope-conflict', context: redeclaration[1] ?? redeclaration[2] }
  const call = /^too (?:few|many) arguments to function '([a-z_]\w*)'(?:; expected \d+, have \d+)?$/i.exec(message)
  if (call) return { category: 'argument-count', context: call[1] }
  const argument = /^passing argument (\d+) of '([a-z_]\w*)' (?:makes (?:integer from pointer|pointer from integer) without a cast|from incompatible pointer type|from incompatible type)$/i.exec(message)
  if (argument) return { category: 'argument-types', context: `${argument[2]}:${argument[1]}` }
  if (/^(?:initialization|assignment) of '.+' from (?:'.+' makes (?:integer from pointer|pointer from integer) without a cast|incompatible pointer type '.+')$/.test(message)
    || /^(?:incompatible types when (?:initializing|assigning) type '.+' (?:using|to) type '.+'|returning '.+' from a function with incompatible return type '.+')$/.test(message)) {
    return { category: 'incompatible-types' }
  }
  if (/^invalid type argument of unary '\*' \(have '.+'\)$/.test(message)) {
    return { category: 'invalid-dereference' }
  }
}

function classifyCompiler(record: ParsedDiagnostic, family: CompilerFamily): ClassifiedDiagnostic {
  const { raw, severity: level, location } = record
  const message = record.message.replace(/\s+\[-W[^\]\r\n]+\]$/, '').replace(/[‘’]/g, "'")
  // A preprocessor #error can contain arbitrary text, including a genuine diagnostic phrase.
  const sourceDirective = /(?:^|\n)\s*\d+\s*\|\s*#\s*error\b/.test(raw)
  const known = location && level !== 'note' && !sourceDirective
    ? family === 'clang' ? classifyClang(message) : family === 'gcc' ? classifyGcc(message) : undefined
    : undefined
  const category = known?.category ?? 'unclassified-compiler'
  return {
    language: 'c', compiler: family, phase: 'compile', severity: level, location,
    category, raw, concepts: relatedConcepts[category], confidence: known ? 'high' : 'uncertain',
    ...(known?.context ? { context: known.context } : {}),
  }
}

export function diagnose(result: RunResult): ClassifiedDiagnostic[] {
  const compiler = compilerFamily(result.compiler)
  const records = parseOutput(result.compileOutput, compiler).map((record) => classifyCompiler(record, compiler))
  if (result.status === 'compile-error' && !records.some(({ severity: level }) => level === 'error' || level === 'fatal error')) {
    records.unshift({
      language: 'c', compiler, phase: 'compile', severity: 'error', category: 'unclassified-compiler',
      raw: (result.compileOutput.trim() || result.message).slice(0, maxRawLength), concepts: [], confidence: 'uncertain',
    })
  }
  if (result.status === 'runtime-error') {
    const fault = result.programSignal === 'SIGSEGV' || result.programSignal === 'SIGBUS'
    const category = fault ? 'runtime-memory-fault' : 'unclassified-runtime'
    records.unshift({
      language: 'c', compiler, phase: 'runtime', severity: 'error', category,
      raw: [result.message, result.programOutput].filter(Boolean).join('\n').slice(0, maxRawLength),
      concepts: relatedConcepts[category], confidence: fault ? 'high' : 'uncertain',
    })
  }
  return records.slice(0, maxDiagnostics)
}
