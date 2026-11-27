import type { SourceControlBrowse } from '../../shared/source-control'
import { gitObjectId } from './commit'

const commitLimit = 50
const refLimit = 100
type Output = { text: string; complete: boolean }

function display(value: string, limit: number): string {
  return value.slice(0, limit).replace(/[\ud800-\udbff]$/, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
}

/** Parse only fully terminated records. Git can be stopped in the middle of a UTF-8 field at the byte limit. */
function commits(output: Output) {
  const rows: SourceControlBrowse['commits'] = []
  let truncated = !output.complete
  const fields = output.text.split('\0')
  const tail = fields.pop()
  if (output.complete && (tail || fields.length % 4)) throw new Error('Git returned incomplete commit history.')
  for (let offset = 0; offset + 3 < fields.length; offset += 4) {
    if (rows.length === commitLimit) { truncated = true; break }
    const [oid, timestamp, author, subject] = fields.slice(offset, offset + 4)
    const time = Number(timestamp)
    if (!gitObjectId.test(oid) || !/^-?\d+$/.test(timestamp) || !Number.isSafeInteger(time)) {
      throw new Error('Git returned invalid commit metadata.')
    }
    if (author.length > 256 || subject.length > 512) truncated = true
    rows.push({ oid, time, author: display(author, 256), subject: display(subject, 512) })
  }
  return { rows, truncated }
}

function refs(output: Output) {
  const rows: SourceControlBrowse['branches'] = []
  let truncated = !output.complete
  const lines = output.text.split(/\r?\n/)
  const tail = lines.pop()
  if (output.complete && tail) throw new Error('Git returned incomplete references.')
  for (const line of lines) {
    if (rows.length === refLimit) { truncated = true; break }
    const space = line.indexOf(' ')
    const oid = line.slice(0, space), name = line.slice(space + 1)
    if (space < 0 || !gitObjectId.test(oid) || !name) throw new Error('Git returned an invalid reference.')
    if (name.length > 1024 || /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)) { truncated = true; continue }
    rows.push({ oid, name })
  }
  return { rows, truncated }
}

/** All revisions, namespaces and format strings are fixed by the application. */
export async function browseLocalRefs(run: (args: string[]) => Promise<Output>,
  remoteInfo: Pick<SourceControlBrowse, 'remotes' | 'truncated'>): Promise<SourceControlBrowse> {
  const history = commits(await run(['log', '--ignore-missing', '--no-follow', '--no-patch', '--no-ext-diff', '--no-textconv',
    '--no-show-signature', '--no-notes', '--no-decorate', '--no-use-mailmap', '--no-color', '--encoding=UTF-8', '-z',
    '--format=tformat:%H%x00%at%x00%an%x00%s', `--max-count=${commitLimit + 1}`, 'HEAD', '--']))
  const list = async (namespace: 'refs/heads/' | 'refs/tags/') => refs(await run(['for-each-ref', '--color=never', '--sort=refname',
    `--count=${refLimit + 1}`, '--format=%(objectname) %(refname:lstrip=2)', namespace]))
  const branches = await list('refs/heads/')
  const tags = await list('refs/tags/')
  return { commits: history.rows, branches: branches.rows, tags: tags.rows, remotes: remoteInfo.remotes,
    truncated: history.truncated || branches.truncated || tags.truncated || remoteInfo.truncated }
}
