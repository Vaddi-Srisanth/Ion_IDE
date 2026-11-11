export type RunLanguage = 'c' | 'cpp' | 'java' | 'python' | 'javascript'
export type FormatterFamily = 'clang' | 'java' | 'python' | 'prettier'
export type SemanticOperation = 'diagnostics' | 'complete' | 'signature' | 'definition' | 'references' | 'hover'

export interface LanguageCapability {
  id: string
  label: string
  wave?: 1 | 2 | 3
  extensions: readonly string[]
  syntax?: string
  basicSuggestions?: boolean
  runner?: { id: RunLanguage; extensions: readonly string[]; tools: string }
  formatter?: { family: FormatterFamily; tools: string }
  semantic?: { adapter: string; tools: string; operations: readonly SemanticOperation[] }
  debugAdapter?: string
  pack?: string
  diagnosticLessons?: 'source-linked' | 'reviewed'
  practice?: boolean
  quizzes?: boolean
}

const clang = { family: 'clang', tools: 'clang-format' } as const
const clangd = { adapter: 'clangd', tools: 'clangd · current translation unit',
  operations: ['definition', 'references'] } as const
const prettier = { family: 'prettier', tools: 'Prettier and Node.js' } as const

export const languageCapabilities: readonly LanguageCapability[] = [
  { id: 'c', label: 'C', wave: 1, extensions: ['c', 'h'], syntax: 'c',
    runner: { id: 'c', extensions: ['c'], tools: 'Clang or GCC' }, formatter: clang, semantic: clangd,
    pack: 'c', diagnosticLessons: 'source-linked', practice: true },
  { id: 'cpp', label: 'C++', wave: 1, extensions: ['cc', 'cpp', 'cxx', 'c++', 'C', 'hpp', 'hh', 'hxx'], syntax: 'cpp',
    runner: { id: 'cpp', extensions: ['cc', 'cpp', 'cxx', 'c++', 'C'], tools: 'Clang++ or G++' }, formatter: clang, semantic: clangd,
    pack: 'cpp', diagnosticLessons: 'reviewed', practice: true },
  { id: 'java', label: 'Java', wave: 1, extensions: ['java'], syntax: 'java', basicSuggestions: true,
    runner: { id: 'java', extensions: ['java'], tools: 'JDK with java and javac' },
    formatter: { family: 'java', tools: 'clang-format or Google Java Format' },
    semantic: { adapter: 'java', tools: 'JDK 17+', operations: ['diagnostics', 'complete', 'signature', 'definition', 'references'] },
    pack: 'java', diagnosticLessons: 'reviewed', practice: true },
  { id: 'python', label: 'Python', wave: 1, extensions: ['py', 'python'], syntax: 'python',
    runner: { id: 'python', extensions: ['py', 'python'], tools: 'Python 3' }, formatter: { family: 'python', tools: 'Ruff or Black' },
    pack: 'python', diagnosticLessons: 'reviewed', practice: true },
  { id: 'javascript', label: 'JavaScript', wave: 1, extensions: ['js', 'mjs', 'cjs', 'jsx'], syntax: 'javascript',
    runner: { id: 'javascript', extensions: ['js', 'mjs', 'cjs'], tools: 'Node.js' }, formatter: prettier,
    pack: 'javascript', diagnosticLessons: 'reviewed', practice: true },
  { id: 'typescript', label: 'TypeScript', wave: 1, extensions: ['ts', 'tsx', 'mts', 'cts'], syntax: 'typescript', formatter: prettier, pack: 'typescript' },
  { id: 'html', label: 'HTML', wave: 2, extensions: ['html', 'htm'], syntax: 'html', formatter: prettier, pack: 'html' },
  { id: 'css', label: 'CSS', wave: 2, extensions: ['css'], syntax: 'css', formatter: prettier, pack: 'css' },
  { id: 'sql', label: 'SQL', wave: 2, extensions: ['sql'], syntax: 'sql', pack: 'sql' },
  { id: 'go', label: 'Go', wave: 2, extensions: ['go'], syntax: 'go', pack: 'go' },
  { id: 'rust', label: 'Rust', wave: 2, extensions: ['rs'], syntax: 'rust', pack: 'rust' },
  { id: 'csharp', label: 'C#', wave: 2, extensions: ['cs'], syntax: 'csharp', pack: 'csharp' },
  { id: 'kotlin', label: 'Kotlin', wave: 3, extensions: ['kt', 'kts'], syntax: 'kotlin' },
  { id: 'swift', label: 'Swift', wave: 3, extensions: ['swift'], syntax: 'swift', pack: 'swift' },
  { id: 'php', label: 'PHP', wave: 3, extensions: ['php'], syntax: 'php' },
  { id: 'ruby', label: 'Ruby', wave: 3, extensions: ['rb'], syntax: 'ruby', pack: 'ruby' },
  { id: 'dart', label: 'Dart', wave: 3, extensions: ['dart'], syntax: 'dart' },
  { id: 'bash', label: 'Bash / Shell', wave: 3, extensions: ['sh', 'bash', 'zsh'], syntax: 'shell', pack: 'bash' },
  { id: 'markdown', label: 'Markdown', extensions: ['md', 'markdown'], syntax: 'markdown', formatter: prettier },
  { id: 'json', label: 'JSON', extensions: ['json', 'ipynb'], syntax: 'json', formatter: prettier, pack: 'json' },
  { id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'], syntax: 'yaml', pack: 'yaml' },
  { id: 'perl', label: 'Perl', extensions: ['pl', 'pm'], syntax: 'perl', pack: 'perl' },
  { id: 'xml', label: 'XML', extensions: ['xml'], syntax: 'xml', pack: 'xml' },
]

const byId = new Map(languageCapabilities.map((entry) => [entry.id, entry]))
const byExtension = new Map(languageCapabilities.flatMap((entry) => entry.extensions.map((extension) => [extension, entry] as const)))
const plain: LanguageCapability = { id: 'plaintext', label: 'Plain Text', extensions: [] }

export const languageCapability = (id: string) => byId.get(id)

function sourceExtension(name: string): string {
  const file = name.split(/[/\\]/).at(-1) ?? ''
  const dot = file.lastIndexOf('.')
  return dot < 0 ? '' : file.slice(dot + 1)
}

function registeredExtension(name: string): string {
  const extension = sourceExtension(name)
  return byExtension.has(extension) ? extension : extension.toLowerCase()
}

export const fileExtension = (name: string): string => sourceExtension(name).toLowerCase()

export const fileLanguage = (name: string): LanguageCapability => byExtension.get(registeredExtension(name)) ?? plain

export function runnableLanguage(name: string): RunLanguage | undefined {
  const extension = registeredExtension(name)
  const runner = byExtension.get(extension)?.runner
  return runner?.extensions.includes(extension) ? runner.id : undefined
}

export function formatterFamily(name: string): FormatterFamily | undefined {
  // Notebook tabs use their separate editor and save protocol.
  if (fileExtension(name) !== 'ipynb') return fileLanguage(name).formatter?.family
}
