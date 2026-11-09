import type { ManualProgress, ProjectSpec, ProjectTest } from '../../shared/projects'

const identifier = /^[a-z][a-z0-9-]{0,39}$/
const progress = new Set<ManualProgress>(['not-started', 'in-progress', 'manually-completed'])

export function exactObject(input: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
    throw new Error(label + ' has missing or unknown fields.')
  }
  return input as Record<string, unknown>
}

export function boundedText(input: unknown, max: number, label: string, empty = false): string {
  if (typeof input !== 'string' || input.length > max || input.includes('\0') || (!empty && !input.trim())) {
    throw new Error(label + ' must be text of up to ' + max + ' characters' + (empty ? '.' : ' and cannot be empty.'))
  }
  return input
}

export function boundedList<T>(input: unknown, max: number, label: string, item: (value: unknown) => T): T[] {
  if (!Array.isArray(input) || input.length > max) throw new Error(label + ' allows up to ' + max + ' entries.')
  return input.map(item)
}

export function relativePath(input: unknown, label: string): string {
  const path = boundedText(input, 240, label)
  if (/[\\:\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(label + ' must be a relative path inside the project folder.')
  }
  return path
}

function id(input: unknown): string {
  if (typeof input !== 'string' || !identifier.test(input)) throw new Error('IDs must use lowercase letters, digits and hyphens.')
  return input
}

function unique(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(label + ' must be unique.')
}

function readTest(input: unknown): ProjectTest {
  const v = exactObject(input, ['id', 'milestoneId', 'title', 'source', 'stdin', 'expectedOutput', 'match', 'exitCode'], 'Test')
  const source = relativePath(v.source, 'Test source')
  if (!source.toLowerCase().endsWith('.c')) throw new Error('Local behavior tests require a C source file.')
  const match = v.match
  if (match !== 'exact' && match !== 'contains') throw new Error('Test output match must be exact or contains.')
  if (typeof v.exitCode !== 'number' || !Number.isInteger(v.exitCode) || v.exitCode < 0 || v.exitCode > 255) {
    throw new Error('Test exit code must be an integer from 0 to 255.')
  }
  return {
    id: id(v.id), milestoneId: id(v.milestoneId), title: boundedText(v.title, 120, 'Test title'),
    source, stdin: boundedText(v.stdin, 4096, 'Standard input', true),
    expectedOutput: boundedText(v.expectedOutput, 4096, 'Expected output', match === 'exact'),
    match, exitCode: v.exitCode,
  }
}

export function validateProject(input: unknown): ProjectSpec {
  const v = exactObject(input, ['version', 'title', 'description', 'goal', 'technologies', 'files', 'milestones', 'environment', 'tests'], 'Project specification')
  if (v.version !== 1) throw new Error('This project specification version is unsupported.')
  const files = boundedList(v.files, 24, 'Suggested files', value => {
    const file = exactObject(value, ['path', 'purpose', 'required'], 'Suggested file')
    if (typeof file.required !== 'boolean') throw new Error('A suggested file must be marked required or optional.')
    return { path: relativePath(file.path, 'Suggested file'), purpose: boundedText(file.purpose, 300, 'File purpose'), required: file.required }
  })
  unique(files.map(file => file.path.toLowerCase()), 'Suggested paths')

  const milestones = boundedList(v.milestones, 16, 'Milestones', value => {
    const milestone = exactObject(value, ['id', 'title', 'description', 'dependsOn', 'acceptance', 'status'], 'Milestone')
    const status = milestone.status as ManualProgress
    if (!progress.has(status)) throw new Error('The milestone has an unsupported manual status.')
    const dependsOn = boundedList(milestone.dependsOn, 15, 'Milestone dependencies', id)
    unique(dependsOn, 'Milestone dependencies')
    const acceptance = boundedList(milestone.acceptance, 8, 'Acceptance criteria', value => boundedText(value, 400, 'Acceptance criterion'))
    if (!acceptance.length) throw new Error('Each milestone needs an acceptance criterion.')
    return {
      id: id(milestone.id), title: boundedText(milestone.title, 120, 'Milestone title'),
      description: boundedText(milestone.description, 800, 'Milestone description', true), dependsOn, acceptance, status,
    }
  })
  if (!milestones.length) throw new Error('Add at least one milestone.')
  unique(milestones.map(milestone => milestone.id), 'Milestone IDs')
  const pending = new Map(milestones.map(milestone => [milestone.id, milestone.dependsOn]))
  while (pending.size) {
    const next = [...pending].find(([, dependencies]) => dependencies.length === 0)
    if (!next) throw new Error('Milestone dependencies contain a cycle or refer to an unknown milestone.')
    pending.delete(next[0])
    for (const [key, dependencies] of pending) pending.set(key, dependencies.filter(item => item !== next[0]))
  }

  const tests = boundedList(v.tests, 16, 'Behavior tests', readTest)
  unique(tests.map(test => test.id), 'Test IDs')
  for (const test of tests) {
    if (!milestones.some(milestone => milestone.id === test.milestoneId)) throw new Error('A test refers to an unknown milestone.')
  }

  const spec: ProjectSpec = {
    version: 1,
    title: boundedText(v.title, 120, 'Project title'),
    description: boundedText(v.description, 4000, 'Project description'),
    goal: boundedText(v.goal, 1000, 'Project goal'),
    technologies: boundedList(v.technologies, 12, 'Technologies', value => boundedText(value, 100, 'Technology')),
    files, milestones,
    environment: boundedList(v.environment, 12, 'Environment requirements', value => boundedText(value, 320, 'Environment requirement')),
    tests,
  }
  if (Buffer.byteLength(JSON.stringify(spec)) > 96 * 1024) throw new Error('Project specifications are limited to 96 KiB.')
  return spec
}

export function newProject(title: string, description: string): ProjectSpec {
  return validateProject({
    version: 1, title, description, goal: description.slice(0, 1000), technologies: [], files: [], environment: [], tests: [],
    milestones: [{ id: 'implement', title: 'Implement the goal', description: '', dependsOn: [],
      acceptance: ['Demonstrate the requested behavior using representative input.'], status: 'not-started' }],
  })
}
