export async function terminalShortcut(app, keyCode, modifiers) {
  await app.evaluate(({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus()
    window.webContents.sendInputEvent({ type: 'keyDown', ...input })
    window.webContents.sendInputEvent({ type: 'keyUp', ...input })
  }, { keyCode, modifiers })
}
