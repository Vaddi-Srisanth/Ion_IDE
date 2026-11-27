import type { SourceControlComparison, SourceControlComparisonRequest } from '../../shared/source-control'
import { gitObjectId } from './commit'
import { safeGitPath } from './status'

export type ComparisonGit = (args: string[]) => Promise<{ text: string; complete: boolean }>

async function metadata(run: ComparisonGit, args: string[]): Promise<string> {
  const output = await run(args)
  if (!output.complete) throw new Error('Git could not verify the complete comparison metadata.')
  return output.text.replace(/\r?\n$/, '')
}

export async function verifyComparisonRefs(request: SourceControlComparisonRequest, run: ComparisonGit) {
  const target = request.kind === 'stash' ? 'refs/stash' : 'refs/heads/' + request.name
  const values = (await metadata(run, ['show-ref', '--verify', '--hash', '--', 'HEAD', target])).split(/\r?\n/)
  if (values.length !== 2 || values[0] !== request.from || values[1] !== request.to) {
    throw new Error('The selected Git references changed. Refresh the repository browser.')
  }
}

function changedPaths(output: { text: string; complete: boolean }) {
  const changes: SourceControlComparison['changes'] = []
  let truncated = !output.complete
  const fields = output.text.split('\0')
  const tail = fields.pop()
  if (output.complete && (tail || fields.length % 2 !== 0)) throw new Error('Git returned incomplete changed paths.')
  for (let offset = 0; offset + 1 < fields.length; offset += 2) {
    const status = fields[offset], path = fields[offset + 1]
    if (changes.length >= 200) { truncated = true; break }
    if (!safeGitPath(path) || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(path)
      || (status !== 'A' && status !== 'M' && status !== 'D' && status !== 'T')) { truncated = true; continue }
    changes.push({ status, path })
  }
  return { changes, truncated }
}

export async function compareTrees(request: SourceControlComparisonRequest, run: ComparisonGit): Promise<SourceControlComparison> {
  await verifyComparisonRefs(request, run)
  let { from } = request
  const { to } = request
  let relation: SourceControlComparison['relation'] = 'same'
  let includesUntrackedParent = false
  if (request.kind === 'stash') {
    const parents = (await metadata(run, ['rev-list', '--parents', '--max-count=1', '--no-abbrev-commit', to, '--'])).split(' ')
    if (parents[0] !== to || (parents.length !== 3 && parents.length !== 4)
      || parents.some(oid => !gitObjectId.test(oid) || oid.length !== to.length)) throw new Error('The stash base could not be verified.')
    from = parents[1]
    relation = 'stash'
    includesUntrackedParent = parents.length === 4
  } else if (from !== to) {
    const base = await metadata(run, ['merge-base', from, to])
    if (base && (!gitObjectId.test(base) || base.length !== from.length)) throw new Error('Git returned an invalid merge base.')
    relation = base === from ? 'ahead' : base === to ? 'behind' : 'diverged'
    if (relation === 'diverged' && await metadata(run, ['rev-parse', '--is-shallow-repository']) !== 'false') {
      throw new Error('The shallow repository does not contain enough history to verify divergence.')
    }
  }
  const paths = from === to ? { changes: [], truncated: false } : changedPaths(await run(['diff-tree', '--no-commit-id', '-r',
    '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none', '-O/dev/null', from, to, '--']))
  return { from, to, relation, ...paths, includesUntrackedParent }
}
