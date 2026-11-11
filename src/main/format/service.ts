import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join } from 'node:path'
import type { Settings } from '../../shared/contracts'
import type { FormatRequest, FormatResult } from '../../shared/format-code'
import { formatterFamily } from '../../shared/languages'
import { maxEditableTextBytes } from '../../shared/large-text'
import { execute } from '../runner'
import { fileText } from '../files'
import { commandPaths, envFor, executable, onPath } from '../run-console/plans'
import { findConfig, prettierConfig } from './config'

const prettierParsers: Record<string, string> = {
  '.js': 'babel', '.jsx': 'babel', '.mjs': 'babel', '.cjs': 'babel',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.json': 'json',
  '.md': 'markdown', '.markdown': 'markdown',
}
const error = (message: string): FormatResult => ({ kind: 'error', message })
const cancelled: FormatResult = { kind: 'cancelled', message: 'Formatting cancelled.' }
let appleClangFormat: string | undefined

async function clangFormat(root: string, paths: string[], scratch: string, signal: AbortSignal) {
  const fromPath = await onPath('clang-format', root, paths)
  if (fromPath || process.platform !== 'darwin') return fromPath
  if (appleClangFormat && await executable(appleClangFormat, root)) return appleClangFormat
  const options = () => ({
    cwd: scratch, input: '', signal, timeoutMs: 2000, budget: { remaining: 8192 }, environment: envFor(paths, scratch),
  })
  // Query the selection first so machines without developer tools do not get
  // the operating system's tool installation prompt from a stub.
  const selected = await execute('/usr/bin/xcode-select', ['-p'], options())
  if (selected.exitCode !== 0 || !isAbsolute(selected.output.trim())) return null
  const result = await execute('/usr/bin/xcrun', ['--find', 'clang-format'], options())
  const path = result.output.trim()
  if (result.exitCode !== 0 || !isAbsolute(path) || !await executable(path, root)) return null
  appleClangFormat = path
  return path
}

interface Plan { bin: string; args: string[]; tool: string }

async function prettierPlan(root: string, paths: string[], source: string, scratch: string, parser: string, request: FormatRequest): Promise<Plan | null> {
  let bin = await onPath('prettier', root, paths)
  const prefix: string[] = []
  if (!bin && process.platform === 'win32') {
    // npm exposes .cmd shims on Windows. Run the installed JavaScript entry
    // with the installed Node executable, without invoking a command shell.
    for (const directory of paths) {
      const entry = join(directory, 'node_modules', 'prettier', 'bin', 'prettier.cjs')
      if (!await executable(entry, root)) continue
      bin = await onPath('node', root, paths)
      if (bin) prefix.push(await realpath(entry))
      break
    }
  }
  if (!bin) return null
  const config = request.path ? await prettierConfig(source, root) : undefined
  const configPath = join(scratch, 'prettier.json')
  await writeFile(configPath, JSON.stringify(config ?? {}), { mode: 0o600, flag: 'wx' })
  return { bin, tool: 'Prettier', args: [...prefix, '--config', configPath, '--config-precedence', 'file-override',
    '--stdin-filepath', source, '--parser', parser, '--tab-width', String(request.tabSize),
    '--use-tabs=' + String(!request.insertSpaces), '--end-of-line', request.eol === '\r\n' ? 'crlf' : 'lf'] }
}

async function pythonPlan(root: string, paths: string[], source: string, scratch: string, choice: Settings['pythonFormatter']): Promise<Plan | null> {
  const ruff = choice === 'black' ? null : await onPath('ruff', root, paths)
  if (ruff) {
    const config = await findConfig(source, root, ['.ruff.toml', 'ruff.toml', 'pyproject.toml'],
      (name, text) => name !== 'pyproject.toml' || /^\s*\[tool\.ruff(?:\]|\.)/m.test(text))
    return { bin: ruff, tool: 'Ruff', args: ['format', '--quiet', '--no-cache',
      ...(config ? ['--config', config.path] : ['--isolated']), '--stdin-filename', source, '-'] }
  }
  const black = choice === 'ruff' ? null : await onPath('black', root, paths)
  if (!black) return null
  const config = await findConfig(source, root, ['pyproject.toml'], (_, text) => /^\s*\[tool\.black\]/m.test(text))
  const configPath = config?.path ?? join(scratch, 'black.toml')
  if (!config) await writeFile(configPath, '[tool.black]\n', { mode: 0o600, flag: 'wx' })
  return { bin: black, tool: 'Black', args: ['--quiet', '--config', configPath, '--stdin-filename', source, '-'] }
}

export async function formatSource(request: FormatRequest, root: string | null, settings: Settings, signal: AbortSignal): Promise<FormatResult> {
  if (signal.aborted) return cancelled
  const extension = extname(request.name).toLowerCase()
  const family = formatterFamily(request.name)
  const java = family === 'java'
  const python = family === 'python'
  const clang = family === 'clang'
  const parser = Object.hasOwn(prettierParsers, extension) ? prettierParsers[extension] : undefined
  if (!java && !python && !clang && !parser) return error('No formatter configured for this language.')
  if (!request.text.trim()) return { kind: 'unchanged', tool: '' }

  const scratch = await mkdtemp(join(tmpdir(), 'ion-format-'))
  try {
    const boundary = root ?? (request.path ? dirname(request.path) : scratch)
    const source = request.path ?? join(scratch, 'untitled' + extension)
    const paths = await commandPaths(root ?? (request.path ? dirname(request.path) : scratch))
    if (signal.aborted) return cancelled
    let plan: Plan | null = null
    let setup = ''
    if (parser) {
      plan = await prettierPlan(boundary, paths, source, scratch, parser, request)
      setup = 'Install Prettier and Node.js on PATH, then reopen Ion.'
    } else if (python) {
      const choice = settings.pythonFormatter ?? 'auto'
      plan = await pythonPlan(boundary, paths, source, scratch, choice)
      setup = choice === 'auto' ? 'Install Ruff or Black on PATH, then reopen Ion.' : 'Install ' + choice + ' on PATH or change the Python formatter in Preferences.'
    } else {
      const choice = java ? settings.javaFormatter ?? 'auto' : 'clang-format'
      const google = choice === 'google-java-format' ? await onPath('google-java-format', boundary, paths) : null
      const clang = choice !== 'google-java-format' ? await clangFormat(boundary, paths, scratch, signal) : null
      if (clang) {
        const config = request.path && await findConfig(source, boundary, ['.clang-format', '_clang-format'])
        const fallback = '{BasedOnStyle: ' + (java ? 'Google' : 'LLVM') + ', IndentWidth: ' + request.tabSize
          + ', TabWidth: ' + request.tabSize + ', UseTab: ' + (request.insertSpaces ? 'Never' : 'ForIndentation') + '}'
        plan = { bin: clang, tool: 'clang-format', args: ['--assume-filename=' + source,
          '--style=' + (config ? 'file:' + config.path : fallback), '--sort-includes=false', '--fail-on-incomplete-format', '--Werror'] }
      } else {
        const bin = google ?? (choice === 'auto' ? await onPath('google-java-format', boundary, paths) : null)
        if (bin) plan = { bin, tool: 'Google Java Format',
          args: ['--skip-sorting-imports', '--skip-removing-unused-import', '--skip-reflowing-long-strings', '-'] }
      }
      setup = choice === 'google-java-format' ? 'Install google-java-format on PATH or change the Java formatter in Preferences.'
        : process.platform === 'darwin' ? 'Install Xcode Command Line Tools or put clang-format on PATH.'
        : 'Install LLVM clang-format on PATH, then reopen Ion.'
    }
    if (signal.aborted) return cancelled
    if (!plan) return error('No formatter available. ' + setup)
    const result = await execute(plan.bin, plan.args, {
      cwd: scratch, input: request.text, signal, timeoutMs: 10_000,
      budget: { remaining: maxEditableTextBytes + 64 * 1024 }, splitOutput: true, collectOutput: false,
      environment: { ...envFor(paths, scratch), BLACK_CACHE_DIR: scratch, XDG_CACHE_HOME: scratch, HOME: homedir() },
    })
    if (signal.aborted || result.state === 'cancelled') return cancelled
    if (result.state === 'timeout') return error(plan.tool + ' timed out.')
    if (result.state === 'output-limit' || Buffer.byteLength(result.stdout ?? '') > maxEditableTextBytes) {
      return error('Formatted output exceeds Ion’s 2 MiB editable file limit.')
    }
    if (result.exitCode !== 0 || result.state !== 'exited' || !result.outputComplete) {
      const detail = result.stderr?.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).find((line) => line.trim())
      return error(plan.tool + ' could not format this file.' + (detail ? ' ' + detail.trim().slice(0, 240) : ''))
    }
    const raw = result.stdout ?? ''
    if (!raw.trim()) return error(plan.tool + ' returned empty output.')
    const text = request.eol === '\n' && !raw.includes('\r') ? raw : raw.replace(/\r\n|\r|\n/g, request.eol)
    if (Buffer.byteLength(text) > maxEditableTextBytes) return error('Formatted output exceeds Ion’s 2 MiB editable file limit.')
    try { fileText(text, maxEditableTextBytes) }
    catch { return error(plan.tool + ' returned unsupported text.') }
    return text === request.text ? { kind: 'unchanged', tool: plan.tool } : { kind: 'formatted', tool: plan.tool, text }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
