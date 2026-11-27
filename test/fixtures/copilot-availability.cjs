// Accept only the probe's signed-out, source-free protocol. All status and version strings are synthetic.
const assert = require('node:assert/strict')
const { isAbsolute, relative } = require('node:path')
const { createMessageConnection } = require('vscode-jsonrpc/node')
const rpc = createMessageConnection(process.stdin, process.stdout)
let phase = 'start'
function step(expected, next) { assert.equal(phase, expected); phase = next }
assert.deepEqual(process.argv.slice(2), ['--stdio'])
for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS']) assert.equal(process.env[name], undefined)
for (const name of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
  const inside = relative(process.env.HOME, process.env[name])
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside))
}
assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:1')
rpc.onRequest('initialize', params => {
  step('start', 'initialize')
  assert.equal(params.rootUri, null)
  assert.equal(params.workspaceFolders, null)
  assert.equal(params.initializationOptions.editorInfo.name, 'Ion IDE')
  assert.equal(params.initializationOptions.editorPluginInfo.name, 'Ion Copilot availability probe')
  return { serverInfo: { name: 'fixture', version: '0.0.0' }, capabilities: {
    textDocumentSync: { openClose: true, change: 2 }, inlineCompletionProvider: {}, executeCommandProvider: { commands: [] },
  } }
})
rpc.onNotification('initialized', () => step('initialize', 'initialized'))
rpc.onNotification('workspace/didChangeConfiguration', ({ settings }) => {
  step('initialized', 'configuration')
  assert.equal(settings.telemetry.telemetryLevel, 'off')
  assert.equal(settings.http.proxy, process.env.HTTPS_PROXY)
})
rpc.onRequest('checkStatus', async params => {
  step('configuration', 'status')
  assert.deepEqual(params, { options: { localChecksOnly: true } })
  await rpc.sendNotification('didChangeStatus', { busy: false, kind: 'Error', message: 'private fixture detail' })
  return { status: 'NotSignedIn' }
})
rpc.onRequest('shutdown', () => { step('status', 'shutdown'); return null })
rpc.onNotification('exit', () => { step('shutdown', 'exit'); process.exit(0) })
rpc.listen()
