import type { ProjectSpec } from '../../src/shared/projects'

export interface PlanningCase {
  id: string
  goal: string
  reviewed: ProjectSpec
  technology: RegExp
  feasibility: RegExp
  expectedTests: 'some' | 'none'
  maxMilestones: number
}

export const planningCases: PlanningCase[] = [
  {
    id: 'c-adder',
    goal: 'Write a beginner C program that reads two signed whole numbers from stdin and prints their sum.',
    technology: /^C(?:17|11)?$/i, feasibility: /stdin|standard input/i, expectedTests: 'some', maxMilestones: 3,
    reviewed: {
      version: 1, title: 'C integer adder',
      description: 'Read two signed integers and print their sum.',
      goal: 'Add two integers supplied through standard input.',
      technologies: ['C17'], files: [{ path: 'main.c', purpose: 'Read input and print the computed result.', required: true }],
      environment: ['Use a local C17 compiler. Input arrives through stdin.'],
      milestones: [
        { id: 'input', title: 'Read two integers', description: 'Define a bounded input range.', dependsOn: [],
          acceptance: ['The program accepts two signed integers separated by a space.'], status: 'not-started' },
        { id: 'sum', title: 'Print the sum', description: '', dependsOn: ['input'],
          acceptance: ['The program prints the sum followed by a newline and exits with code zero.'], status: 'not-started' },
      ],
      tests: [
        { id: 'positive', milestoneId: 'sum', title: 'Adds two positive integers', source: 'main.c', stdin: '2 3\n',
          expectedOutput: '5\n', exitCode: 0, match: 'exact' },
        { id: 'signed', milestoneId: 'sum', title: 'Adds a negative integer', source: 'main.c', stdin: '-2 2\n',
          expectedOutput: '0\n', exitCode: 0, match: 'exact' },
      ],
    },
  },
  {
    id: 'browser-file',
    goal: 'Build a simple HTML form that takes a note and saves it into a file named hi.txt without running a server.',
    technology: /^(HTML|JavaScript)$/i, feasibility: /download|file picker|user.granted/i, expectedTests: 'none', maxMilestones: 3,
    reviewed: {
      version: 1, title: 'Browser note download', description: 'Save a note from an HTML form as hi.txt.',
      goal: 'A user-triggered download saves the submitted note as hi.txt.',
      technologies: ['HTML', 'JavaScript'], files: [{ path: 'index.html', purpose: 'Form and download behavior.', required: true }],
      environment: ['Use a local browser. A static page cannot silently write arbitrary disk paths. The user controls the download location.'],
      milestones: [
        { id: 'form', title: 'Create the note form', description: '', dependsOn: [],
          acceptance: ['A user can enter and submit multiline text.'], status: 'not-started' },
        { id: 'download', title: 'Download the text', description: 'Use a user-initiated browser download.',
          dependsOn: ['form'], acceptance: ['Submitting a note offers hi.txt with contents equal to the entered text.'], status: 'not-started' },
      ], tests: [],
    },
  },
  {
    id: 'local-checklist',
    goal: 'Make a tiny offline webpage for lab tasks. Checked tasks should still be checked after I reload.',
    technology: /^(HTML|JavaScript)$/i, feasibility: /localStorage|IndexedDB|browser storage/i, expectedTests: 'none', maxMilestones: 3,
    reviewed: {
      version: 1, title: 'Offline lab checklist', description: 'Persist lab-task checkbox choices across page reloads.',
      goal: 'Check a lab task and restore the checked state on the next visit.',
      technologies: ['HTML', 'JavaScript'], files: [{ path: 'index.html', purpose: 'Task list and local persistence.', required: true }],
      environment: ['Use browser storage on a consistent origin. Opening files directly may have browser-specific storage behavior.'],
      milestones: [
        { id: 'list', title: 'Display checklist', description: '', dependsOn: [],
          acceptance: ['Every listed task can be checked and unchecked with the keyboard.'], status: 'not-started' },
        { id: 'persist', title: 'Restore local state', description: 'Use localStorage for task IDs and checked states.',
          dependsOn: ['list'], acceptance: ['After checking a task, reloading restores only that task as checked.'], status: 'not-started' },
      ], tests: [],
    },
  },
  {
    id: 'c-temperature',
    goal: 'Make a simple C console program that accepts Celsius as an integer and outputs Fahrenheit rounded to one decimal.',
    technology: /^C(?:17|11)?$/i, feasibility: /stdin|standard input/i, expectedTests: 'some', maxMilestones: 3,
    reviewed: {
      version: 1, title: 'Temperature converter', description: 'Convert Celsius to Fahrenheit.',
      goal: 'Convert integer Celsius input to Fahrenheit with one decimal place.',
      technologies: ['C17'], files: [{ path: 'main.c', purpose: 'Parse Celsius and print Fahrenheit.', required: true }],
      environment: ['Use a local C compiler with stdin and stdout.'],
      milestones: [{ id: 'convert', title: 'Convert and format temperature', description: '', dependsOn: [],
        acceptance: ['Read one integer from stdin and output one number rounded to one decimal place.'], status: 'not-started' }],
      tests: [{ id: 'freezing', title: 'Converts the freezing point', milestoneId: 'convert', source: 'main.c', stdin: '0\n',
        expectedOutput: '32.0\n', exitCode: 0, match: 'exact' },
      { id: 'negative', title: 'Converts a negative Celsius value', milestoneId: 'convert', source: 'main.c', stdin: '-40\n',
        expectedOutput: '-40.0\n', exitCode: 0, match: 'exact' }],
    },
  },
]

export function scorePlan(item: PlanningCase, spec: ProjectSpec) {
  const prose = [spec.goal, ...spec.environment, ...spec.milestones.flatMap(m => [m.description, ...m.acceptance])].join(' ')
  return {
    feasible: spec.technologies.some(language => item.technology.test(language)) && item.feasibility.test(prose),
    explicitPrerequisites: spec.milestones.length < 2 || spec.milestones.some(milestone => milestone.dependsOn.length > 0),
    verifiable: (item.expectedTests === 'some' ? spec.tests.length > 0 : spec.tests.length === 0)
      && spec.milestones.every(milestone => milestone.acceptance.every(criterion => criterion.length >= 20)),
    simple: spec.milestones.length <= item.maxMilestones && spec.technologies.length <= 3 && spec.files.length <= 3,
  }
}
