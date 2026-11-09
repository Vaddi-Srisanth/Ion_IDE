const { app, BrowserWindow, session } = require('electron')

const url = new URL(process.env.ION_PROBE_URL)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('The probe requires a loopback URL')
app.setName('Ion Architecture Probe')
app.setPath('userData', process.env.ION_PROBE_PROFILE)
let window

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest(({ url: request }, reply) => {
    reply({ cancel: new URL(request).origin !== url.origin })
  })
  window = new BrowserWindow({
    width: 1260, height: 790, useContentSize: true, title: 'Ion architecture probe · Electron',
    backgroundColor: '#101117',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  await window.loadURL(url.href)
}).catch((error) => {
  console.error(error)
  app.exit(1)
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (command) => {
  if (command.includes('q')) app.quit()
  else if (command.includes('o')) window?.webContents.executeJavaScript('window.architectureProbeOpen()').catch(console.error)
})
process.stdin.on('end', () => app.quit())
app.on('window-all-closed', () => app.quit())
