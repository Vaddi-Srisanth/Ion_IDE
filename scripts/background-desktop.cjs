// This entry point runs only in disposable Electron test processes.
const { app, dialog } = require('electron')

if (process.platform === 'darwin') app.setActivationPolicy('accessory')

app.on('browser-window-created', (_event, window) => {
  // Ion creates its windows hidden. Keep them hidden while Playwright drives
  // the real renderer, including secondary windows and crash replacements.
  window.show = () => {}
  window.showInactive = () => {}
  window.focus = () => {}
  window.webContents.setBackgroundThrottling(false)
})

const unexpected = () => { throw new Error('Stub the native dialog before using it in a background desktop test.') }
for (const name of ['showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showMessageBox', 'showMessageBoxSync']) {
  dialog[name] = unexpected
}
dialog.showErrorBox = (title, content) => console.error(title, content)

require(process.env.ION_TEST_ENTRY)
