import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const platforms = { 'mac-arm64': 'mac-arm64.dmg', 'windows-x64': 'windows-x64-setup.exe' }
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const commitPattern = /^[a-f0-9]{40}$/
const counterPattern = /^[1-9]\d*$/

function installerName(version, platform) {
  if (!versionPattern.test(version) || !Object.hasOwn(platforms, platform)) throw new Error('Invalid version or release platform.')
  return `Ion-IDE-${version}-${platforms[platform]}`
}

async function fileIdentity(path) {
  const size = await stat(path)
  if (!size.isFile() || size.size <= 0) throw new Error('A nonempty installer file is required.')
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return { bytes: size.size, sha256: hash.digest('hex') }
}

async function checkout() {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!versionPattern.test(version) || !commitPattern.test(commit) || process.env.GITHUB_SHA !== commit) {
    throw new Error('The checkout must match the GitHub Actions source revision.')
  }
  const ref = process.env.GITHUB_REF
  if (ref?.startsWith('refs/tags/') && ref !== 'refs/tags/v' + version) {
    throw new Error('The Git tag must match package.json version v' + version + '.')
  }
  return { version, commit }
}

export async function verifyReleaseEvidence(tag, commit, paths) {
  const version = tag?.startsWith('v') ? tag.slice(1) : ''
  if (!versionPattern.test(version) || !commitPattern.test(commit) || paths.length !== 2) {
    throw new Error('Expected a version tag, its tested commit SHA, and two evidence files.')
  }
  const verified = []
  for (const path of paths) {
    const record = JSON.parse(await readFile(path, 'utf8'))
    if (record?.schema !== 1 || record.version !== version || record.commit !== commit
      || typeof record.run !== 'string' || !counterPattern.test(record.run)
      || typeof record.attempt !== 'string' || !counterPattern.test(record.attempt)
      || record.file !== installerName(version, record.platform)) throw new Error('Invalid release evidence for ' + basename(path) + '.')
    const identity = await fileIdentity(join(dirname(path), record.file))
    if (identity.sha256 !== record.sha256 || identity.bytes !== record.bytes) {
      throw new Error('The installer does not match its verified evidence: ' + record.file)
    }
    verified.push(record)
  }
  const [first, second] = verified
  if (first.platform === second.platform || first.run !== second.run || first.attempt !== second.attempt) {
    throw new Error('Both platform installers must come from the same verification run and attempt.')
  }
  return verified.map(({ sha256, file }) => sha256 + '  ' + file).sort((a, b) =>
    a.slice(66).localeCompare(b.slice(66))).join('\n') + '\n'
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'checkout' && !args.length) {
    const { version, commit } = await checkout()
    console.log(`Verified source revision ${commit} for Ion ${version}.`)
  } else if (command === 'record' && args.length === 1) {
    const { version, commit } = await checkout()
    const [platform] = args
    const run = process.env.GITHUB_RUN_ID
    const attempt = process.env.GITHUB_RUN_ATTEMPT
    if (!counterPattern.test(run) || !counterPattern.test(attempt)) throw new Error('GitHub verification run metadata is required.')
    const file = installerName(version, platform)
    const identity = await fileIdentity(join('release', file))
    await writeFile(join('release', file + '.json'), JSON.stringify({
      schema: 1, version, commit, run, attempt, platform, file, ...identity,
    }, null, 2) + '\n', { flag: 'wx' })
  } else if (command === 'verify') {
    const [tag, commit, ...paths] = args
    process.stdout.write(await verifyReleaseEvidence(tag, commit, paths))
  } else {
    throw new Error('Use checkout, record <platform>, or verify <tag> <commit> <mac-evidence> <windows-evidence>.')
  }
}
