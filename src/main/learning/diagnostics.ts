import { fileURLToPath } from 'node:url'
import type { RunResult } from '../../shared/contracts'
import type {
  CompilerFamily, ConceptId, DiagnosticCategory, DiagnosticSeverity, LearningDiagnostic,
} from '../../shared/learning'
import type { RunLanguage } from '../../shared/run-console'

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

export const relatedConcepts: Partial<Record<DiagnosticCategory, ConceptId[]>> = {
  'missing-semicolon': ['statements'],
  'undeclared-identifier': ['names', 'scope'],
  'scope-conflict': ['scope', 'names'],
  'incompatible-types': ['types'],
  'argument-count': ['functions'],
  'argument-types': ['functions', 'types'],
  'format-argument-type': ['functions', 'types'],
  'invalid-dereference': ['pointers', 'types'],
  'runtime-memory-fault': ['memory', 'pointers'],
  'unclassified-compiler': [],
  'unclassified-runtime': [],
}

export const packDiagnostics: Partial<Record<DiagnosticCategory, { packTopic: string; guidance: string }>> = {
  'format-argument-type': {
    packTopic: 'program', guidance: 'A conversion in the format string requires a specific argument type. Compare the expected and actual types in the compiler message, then check whether the conversion or the supplied argument should change.',
  },
  'java-statement-boundary': {
    packTopic: 'entry', guidance: 'The parser expected a semicolon to finish a statement. Check the reported line and the statement immediately before it.',
  },
  'java-unresolved-variable': {
    packTopic: 'flow', guidance: 'The compiler could not find that variable at this position. Check the spelling and whether its declaration is inside a block that has already ended.',
  },
  'java-incompatible-types': {
    packTopic: 'entry', guidance: 'The expression cannot be converted to the type required here. Compare the expression type with the destination type named in the diagnostic.',
  },
  'java-null-reference': {
    packTopic: 'exceptions', guidance: 'This operation needs an object or array. Trace how the reference got its value before the reported line.',
  },
  'java-array-index': {
    packTopic: 'flow', guidance: 'Array indices start at zero. Check that the index is at least zero and smaller than the array length.',
  },
  'python-undefined-name': {
    packTopic: 'values', guidance: 'Python could not resolve the name. Check the spelling and follow the path through the program to see whether the assignment or import ran first.',
  },
  'python-statement-colon': {
    packTopic: 'flow', guidance: 'The parser expected a colon at the end of the block header. Check the header near the reported line.',
  },
  'python-indentation': {
    packTopic: 'flow', guidance: 'The header needs an indented body. Check the first statement under the header and align the statements that belong to its block.',
  },
  'python-index-range': {
    packTopic: 'collections', guidance: 'The list or tuple has no item at that index. Inspect its length at the point of access. Valid negative indices count back from the end.',
  },
  'python-operand-types': {
    packTopic: 'values', guidance: 'The two types named in the exception do not support this operator together. Inspect both values and decide which type each operand should have.',
  },
  'cpp-statement-boundary': {
    packTopic: 'program', guidance: 'The parser expected a semicolon. Check the statement before the location as well as the reported line.',
  },
  'cpp-unresolved-name': {
    packTopic: 'flow', guidance: 'The compiler could not find a declaration for this name here. Check spelling, scope, namespace qualification, and any needed header.',
  },
  'cpp-incompatible-types': {
    packTopic: 'program', guidance: 'The types named by the compiler are incompatible in this context. Compare the expression type with the type required at this location.',
  },
  'cpp-reference-binding': {
    packTopic: 'references', guidance: 'An ordinary non-const lvalue reference needs a suitable object that already exists. The expression here provides a temporary value.',
  },
  'cpp-memory-access': {
    packTopic: 'ownership', guidance: 'The operating system reported a memory access fault. Inspect object lifetimes, pointer validity, and indices near the last operation the program reached.',
  },
  'javascript-undefined-name': {
    packTopic: 'values', guidance: 'JavaScript could not resolve this name in the current scope. Check the spelling and where the binding is declared or imported.',
  },
  'javascript-null-property': {
    packTopic: 'json', guidance: 'The base value is null or undefined. Inspect the expression before the property access and decide whether the missing value is expected.',
  },
  'javascript-not-callable': {
    packTopic: 'flow', guidance: 'The value being called is not a function. Inspect what the name refers to at this point, including any later reassignment.',
  },
  'javascript-redeclared-binding': {
    packTopic: 'values', guidance: 'The parser found two declarations that conflict in the same scope. Find both declarations and check whether they are meant to share one binding.',
  },
}

function filename(path: string): string {
  return path.split(/[/\\]/).at(-1) ?? ''
}

function compilerFamily(executable: string | null, language: RunLanguage): CompilerFamily {
  if (!executable) return 'unknown'
  const name = filename(executable).toLowerCase()
  if (language === 'c') {
    if (/^(?:[\w]+-)*clang(?:-\d+)?(?:\.exe)?$/.test(name)) return 'clang'
    if (/^(?:[\w]+-)*gcc(?:-\d+)?(?:\.exe)?$/.test(name)) return 'gcc'
  } else if (language === 'cpp') {
    if (/^(?:[\w]+-)*clang\+\+(?:-\d+)?(?:\.exe)?$/.test(name)) return 'clang'
    if (/^(?:[\w]+-)*g\+\+(?:-\d+)?(?:\.exe)?$/.test(name)) return 'gcc'
  } else if (language === 'java' && /^javac(?:\.exe)?$/.test(name)) return 'javac'
  else if (language === 'python' && /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(name)) return 'python'
  else if (language === 'javascript' && /^node(?:\.exe)?$/.test(name)) return 'node'
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

function sameSource(file: string, source: string | undefined): boolean {
  if (!source) return false
  const windows = /^[a-z]:[/\\]/i.test(source)
  if (file.startsWith('file:')) {
    try { file = fileURLToPath(file, { windows }) } catch { return false }
  }
  if (windows) return file.replaceAll('\\', '/').toLowerCase() === source.replaceAll('\\', '/').toLowerCase()
  return file === source
}

function classifyJavaCompiler(message: string, raw: string): Classification | undefined {
  if (message === "';' expected") return { category: 'java-statement-boundary' }
  if (/^incompatible types: .+ cannot be converted to .+$/.test(message)) return { category: 'java-incompatible-types' }
  const variable = message === 'cannot find symbol' && /^\s+symbol:[ \t]+variable[ \t]+([\w$]+)$/m.exec(raw)
  if (variable) return { category: 'java-unresolved-variable', context: variable[1] }
}

function classifyCppCompiler(message: string, family: CompilerFamily): Classification | undefined {
  const statement = family === 'clang' ? classifyClang(message) : family === 'gcc' ? classifyGcc(message) : undefined
  if (statement?.category === 'missing-semicolon') return { category: 'cpp-statement-boundary' }
  if (family === 'clang') {
    if (statement?.category === 'undeclared-identifier') {
      return { category: 'cpp-unresolved-name', context: statement.context }
    }
    if (/^cannot initialize a variable of type '.+' with an (?:lvalue|rvalue) of type '.+'$/.test(message)) {
      return { category: 'cpp-incompatible-types' }
    }
    if (/^non-const lvalue reference to type '.+' cannot bind to a temporary of type '.+'$/.test(message)) {
      return { category: 'cpp-reference-binding' }
    }
  } else if (family === 'gcc') {
    const name = /^'([a-z_]\w*)' was not declared in this scope(?:; did you mean '[^']+'\?)?$/i.exec(message)
    if (name) return { category: 'cpp-unresolved-name', context: name[1] }
    if (/^invalid conversion from '.+' to '.+' \[-fpermissive\]$/.test(message)) return { category: 'cpp-incompatible-types' }
    if (/^cannot bind non-const lvalue reference of type '.+' to an rvalue of type '.+'$/.test(message)) {
      return { category: 'cpp-reference-binding' }
    }
  }
}

function classifyFormatArgument(message: string, option: string | undefined, family: CompilerFamily): Classification | undefined {
  let types: RegExpExecArray | null = null
  if (family === 'clang' && (option === '-Wformat' || option === '-Werror,-Wformat')) {
    types = /^format specifies type '([^']+)' but the argument has type '([^']+)'$/.exec(message)
  } else if (family === 'gcc' && (option === '-Wformat=' || option === '-Werror=format=')) {
    types = /^format '%[^']+' expects argument of type '([^']+)', but argument \d+ has type '([^']+)'$/.exec(message)
  }
  if (types) return { category: 'format-argument-type', context: types[1] + '|' + types[2] }
}

function classifyCompiler(record: ParsedDiagnostic, family: CompilerFamily, language: RunLanguage, source: string | undefined): ClassifiedDiagnostic {
  const { raw, severity: level, location } = record
  const option = /\s+\[(-W[^\]\r\n]+)\]$/.exec(record.message)
  const message = (option ? record.message.slice(0, option.index) : record.message).replace(/[‘’]/g, "'")
  // A preprocessor #error can contain arbitrary text, including a genuine diagnostic phrase.
  const sourceDirective = /^[ \t]*(?:\d+[ \t]*\|[ \t]*)?#[ \t]*(?:error\b|pragma[ \t]+(?:GCC|clang)[ \t]+error\b)/m.test(raw)
  let known: Classification | undefined
  if (location && level !== 'note' && !sourceDirective) {
    if (language === 'c') {
      known = classifyFormatArgument(message, option?.[1], family)
      if (!known && family === 'clang') known = classifyClang(message)
      else if (!known && family === 'gcc') known = classifyGcc(message)
    } else if (sameSource(location.file, source)) {
      if (language === 'java' && family === 'javac') known = classifyJavaCompiler(message, raw)
      else if (language === 'cpp' && /^[ \t]*\d+[ \t]*\|/m.test(raw)) known = classifyCppCompiler(message, family)
    }
  }
  const category = known?.category ?? 'unclassified-compiler'
  return {
    language, compiler: family, phase: 'compile', severity: level, location,
    category, raw, concepts: relatedConcepts[category] ?? [], confidence: known ? 'high' : 'uncertain',
    ...packDiagnostics[category],
    ...(known?.context ? { context: known.context } : {}),
  }
}

interface RuntimeClassification extends Classification {
  location?: LearningDiagnostic['location']
}

function classifyJavaRuntime(lines: string[], source: string): RuntimeClassification | undefined {
  const header = lines.findLastIndex((line) => /^Exception in thread "[^"]+" /.test(line))
  if (header === -1) return
  const frame = /^\s+at [^(]+\(([^():]+\.java):(\d+)\)$/.exec(lines[header + 1] ?? '')
  if (!frame || filename(source) !== frame[1]) return
  const location = { file: frame[1], line: Number(frame[2]) }
  if (/^Exception in thread "[^"]+" java\.lang\.NullPointerException: Cannot .+ because .+ is null$/.test(lines[header])) {
    return { category: 'java-null-reference', location }
  }
  if (/^Exception in thread "[^"]+" java\.lang\.ArrayIndexOutOfBoundsException: Index -?\d+ out of bounds for length \d+$/.test(lines[header])) {
    return { category: 'java-array-index', location }
  }
}

function classifyPython(lines: string[], source: string): RuntimeClassification | undefined {
  const message = lines.at(-1) ?? ''
  const framePattern = /^  File "([^"]+)", line (\d+)(, in .+)?$/
  const traceback = lines.lastIndexOf('Traceback (most recent call last):')
  const stack = lines.slice(traceback + 1, -1)
  const frame = stack.map((line) => framePattern.exec(line)).findLast((item) => item !== null)
  if (!frame || !sameSource(frame[1], source)) return
  const location = { file: frame[1], line: Number(frame[2]) }
  if (traceback === -1) {
    if (frame[3] || !stack.some((line) => /^\s+\^+\s*$/.test(line))) return
    if (message === "SyntaxError: expected ':'") return { category: 'python-statement-colon', location }
    if (/^IndentationError: expected an indented block after .+ on line \d+$/.test(message)) {
      return { category: 'python-indentation', location }
    }
    return
  }
  if (!frame[3]) return
  const name = /^NameError: name '([a-z_]\w*)' is not defined$/i.exec(message)
  if (name) return { category: 'python-undefined-name', location, context: name[1] }
  if (/^IndexError: (?:list|tuple) index out of range$/.test(message)) return { category: 'python-index-range', location }
  if (/^TypeError: unsupported operand type\(s\) for [^:\s]+: '[^']+' and '[^']+'$/.test(message)) {
    return { category: 'python-operand-types', location }
  }
}

function classifyNode(lines: string[], source: string): RuntimeClassification | undefined {
  if (!/^Node\.js v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(lines.at(-1) ?? '')) return
  const error = lines.findLastIndex((line) => /^(?:[a-z]*Error)(?: \[ERR_[A-Z_]+\])?: /i.test(line))
  if (error === -1) return
  const message = lines[error]
  const declaration = /^SyntaxError: Identifier '([$a-z_][$\w]*)' has already been declared$/i.exec(message)
  if (declaration) {
    const header = lines.slice(Math.max(0, error - 5), error)
    const sourceLine = header.map((line) => /^(.+):(\d+)$/.exec(line)).find((item) => item && sameSource(item[1], source))
    if (sourceLine && header.some((line) => /^\s*\^+\s*$/.test(line))) {
      return { category: 'javascript-redeclared-binding', context: declaration[1], location: { file: source, line: Number(sourceLine[2]) } }
    }
    return
  }
  const frame = /^\s+at (?:[^()]+ \()?(.+):(\d+):(\d+)\)?$/.exec(lines[error + 1] ?? '')
  if (!frame || !sameSource(frame[1], source)) return
  const location = { file: source, line: Number(frame[2]), column: Number(frame[3]) }
  const name = /^ReferenceError: ([$a-z_][$\w]*) is not defined$/i.exec(message)
  if (name) return { category: 'javascript-undefined-name', location, context: name[1] }
  const property = /^TypeError: Cannot (?:read properties of (?:undefined|null) \(reading|set properties of (?:undefined|null) \(setting) '([^']+)'\)$/.exec(message)
  if (property) return { category: 'javascript-null-property', location, context: property[1] }
  const call = /^TypeError: ([$a-z_][$\w]*) is not a function$/i.exec(message)
  if (call) return { category: 'javascript-not-callable', location, context: call[1] }
}

function runtimeDiagnostic(result: RunResult, language: RunLanguage, compiler: CompilerFamily, source: string | undefined): ClassifiedDiagnostic {
  const output = (result.programStderr?.trim() || result.programOutput).replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
  let known: RuntimeClassification | undefined
  if (result.programSignal === 'SIGSEGV' || result.programSignal === 'SIGBUS') {
    if (language === 'c') known = { category: 'runtime-memory-fault' }
    else if (language === 'cpp') known = { category: 'cpp-memory-access' }
  } else if (source && result.exitCode === 1 && result.outputComplete !== false && output) {
    const lines = output.split(/\r?\n/)
    if (compiler === 'javac') known = classifyJavaRuntime(lines, source)
    else if (compiler === 'python') known = classifyPython(lines, source)
    else if (compiler === 'node') known = classifyNode(lines, source)
  }
  const category = known?.category ?? 'unclassified-runtime'
  const raw = [result.message, output.slice(-(maxRawLength - Math.min(result.message.length, 400) - 1))]
    .filter(Boolean).join('\n').slice(0, maxRawLength)
  return {
    language, compiler, phase: 'runtime', severity: 'error', category, raw,
    concepts: relatedConcepts[category] ?? [], confidence: known ? 'high' : 'uncertain',
    ...(known?.location ? { location: known.location } : {}),
    ...(known?.context ? { context: known.context } : {}),
    ...packDiagnostics[category],
  }
}

export function diagnose(result: RunResult, language: RunLanguage = 'c', source?: string): ClassifiedDiagnostic[] {
  const compiler = compilerFamily(result.compiler, language)
  const completeSource = result.outputComplete === false ? undefined : source
  const records = parseOutput(result.compileOutput, compiler).map((record) => classifyCompiler(record, compiler, language, completeSource))
  if (result.status === 'compile-error' && !records.some(({ severity: level }) => level === 'error' || level === 'fatal error')) {
    records.unshift({
      language, compiler, phase: 'compile', severity: 'error', category: 'unclassified-compiler',
      raw: (result.compileOutput.trim() || result.message).slice(0, maxRawLength), concepts: [], confidence: 'uncertain',
    })
  }
  if (result.status === 'runtime-error') {
    records.unshift(runtimeDiagnostic(result, language, compiler, source))
  }
  return records.slice(0, maxDiagnostics)
}
