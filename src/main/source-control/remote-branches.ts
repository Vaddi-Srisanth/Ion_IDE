import { lstat, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { SourceControlBrowse } from '../../shared/source-control'
import { gitObjectId } from './commit'

const prefix = 'refs/remotes/'
const refLimit = 100
type Output = { text: string; complete: boolean }
type Read = (args: string[]) => Promise<Output>

function safeName(name: string): boolean {
  const components = name.split('/')
  return name.length <= 1024 && components.length >= 2 && components.length <= 64
    && !/[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufffd~^:?*\[\\<>"|]/u.test(name)
    && !name.includes('..') && !name.includes('@{')
    && components.every(component => component && !component.startsWith('.') && !component.endsWith('.')
      && !/\.lock$/i.test(component) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component))
}

function args(ref: string, count: number) {
  return ['for-each-ref', '--color=never', '--sort=refname', `--count=${count}`,
    '--format=%(objectname)%00%(objecttype)%00%(refname)%00%(symref)', ref]
}

function parse(output: Output, limit: number) {
  const rows: SourceControlBrowse['cachedRemoteBranches'] = []
  const lines = output.text.split(/\r?\n/)
  const tail = lines.pop()
  if (output.complete && tail) throw new Error('Git returned incomplete cached remote branches.')
  let truncated = !output.complete || lines.length > limit
  for (const line of lines.slice(0, limit)) {
    const fields = line.split('\0')
    if (fields.length !== 4) throw new Error('Git returned invalid cached remote branch metadata.')
    const [oid, type, ref, symbolicTarget] = fields
    if (!ref.startsWith(prefix)) throw new Error('Git returned an unexpected reference namespace.')
    if (symbolicTarget || type !== 'commit') continue
    const name = ref.slice(prefix.length)
    if (!gitObjectId.test(oid) || !safeName(name)) { truncated = true; continue }
    rows.push({ oid, name })
  }
  return { rows, truncated }
}

/** Git can interpret filesystem symlinks as ordinary loose refs. The selected metadata must stay local. */
async function localRefPath(common: string, name?: string): Promise<boolean> {
  const components = ['refs', 'remotes', ...(name?.split('/') ?? [])]
  let path = common
  for (const [i, component] of components.entries()) {
    path = join(path, component)
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    // Packed refs and reftable have no corresponding loose file.
    if (!info) return true
    const leaf = name !== undefined && i === components.length - 1
    if (leaf ? !info.isFile() : !info.isDirectory()) return false
  }
  const canonical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  return canonical !== undefined && !relative(path, canonical)
}

export async function browseCachedRemoteBranches(run: Read, common: string) {
  if (!await localRefPath(common)) return { rows: [], truncated: true }
  const result = parse(await run(args(prefix, refLimit + 1)), refLimit)
  const local = await Promise.all(result.rows.map(row => localRefPath(common, row.name)))
  const rows = result.rows.filter((_, i) => local[i])
  return { rows, truncated: result.truncated || rows.length !== result.rows.length }
}

export async function verifyCachedRemoteBranch(run: Read, common: string, name: string, oid: string): Promise<boolean> {
  if (!safeName(name) || !await localRefPath(common, name)) return false
  const { rows, truncated } = parse(await run(args(prefix + name, 2)), 1)
  // for-each-ref also matches descendants, so only an exact direct ref can pass review.
  return !truncated && rows.length === 1 && rows[0].name === name && rows[0].oid === oid
    && await localRefPath(common, name)
}
