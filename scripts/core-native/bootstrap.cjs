// CI-only test entry: imports the unmodified production main, never bundled by build.mjs.
const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');
const { app, dialog, ipcMain, BrowserWindow, screen } = require('electron');
const root = process.env.ION_CORE_ACCEPTANCE_ROOT;
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || !root || !profile || !process.env.ION_CORE_ACCEPTANCE_TOKEN ||
    fs.realpathSync(root) !== path.resolve(root) || !path.resolve(profile).startsWith(root + path.sep) ||
    fs.readFileSync(path.join(root, 'owner'), 'utf8') !== process.env.ION_CORE_ACCEPTANCE_TOKEN) throw Error('Refusing unowned native acceptance profile');
const controlPath = path.join(profile, 'acceptance-control.json');
const control = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const controlledWorkspace = control().workspace;
const receiptPath = path.join(profile, 'acceptance-events');
fs.mkdirSync(receiptPath, { recursive: true, mode: 0o700 });
let count = 0;
const trace = [];
function traceEvent(category, name, started = performance.now(), extra = {}) {
  if (trace.length >= 1000) throw Error('Acceptance performance trace limit exceeded');
  trace.push({ category, name, startMs: started, durationMs: performance.now() - started, ...extra });
}
function receipt(kind, extra = {}) {
  if (++count > 80) throw Error('Acceptance receipt limit exceeded');
  const destination = path.join(receiptPath, `${Date.now()}-${process.pid}-${String(count).padStart(3, '0')}.json`);
  fs.writeFileSync(destination + '.tmp', JSON.stringify({ kind, pid: process.pid, monotonicMs: performance.now(), ...extra }), { flag: 'wx', mode: 0o600 });
  fs.renameSync(destination + '.tmp', destination); // Readers never observe a partial receipt.
}
if (!inspector.url()) inspector.open(0, '127.0.0.1');
receipt('start', { inspector: inspector.url(), creationTime: process.getCreationTime() });
let calls = 0, storage = 0;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, listener) => handle(name, async (...args) => {
  if (name.startsWith('ion:backup-')) calls++;
  const started = performance.now();
  try { return await listener(...args); }
  finally { traceEvent('ipc', name.replace(/^ion:/, ''), started); }
});
const promises = require('node:fs/promises');
for (const name of ['access', 'open', 'opendir', 'readFile', 'writeFile', 'lstat', 'stat', 'realpath', 'rename', 'unlink']) {
  const original = promises[name];
  promises[name] = async (...args) => {
    const started = performance.now();
    const firstPath = args.find(arg => typeof arg === 'string');
    const scope = firstPath === path.join(profile, 'ion-pending-restore.json') ? 'pending-restore'
      : typeof firstPath === 'string' && path.resolve(firstPath).startsWith(profile + path.sep) ? 'profile'
      : typeof firstPath === 'string' && path.resolve(firstPath).startsWith(controlledWorkspace + path.sep) ? 'workspace' : 'other';
    if (args.some(arg => typeof arg === 'string' && /\.ion-backup|\.ion-restore|ion-pending-restore/.test(arg))) storage++;
    let result;
    try { result = await original(...args); }
    finally { traceEvent('filesystem', name, started, { scope }); }
    if (name === 'rename' && fs.existsSync(path.join(profile, 'ion-pending-restore.json'))) {
      const fault = control().fault;
      const destination = String(args[1]);
      const boundary = destination === path.join(profile, 'preferences.json') ? 'published' :
        destination.includes(path.sep + 'previous' + path.sep) && destination.endsWith('preferences.json') ? 'previous-moved' : null;
      if (boundary && fault?.boundary === boundary) {
        fs.writeFileSync(controlPath, JSON.stringify({ ...control(), fault: null }));
        receipt('fault', { boundary, action: fault.action, processes: app.getAppMetrics().map(({ pid, creationTime }) => ({ pid, creationTime })) });
        if (fault.action === 'kill') process.kill(process.pid, 'SIGKILL');
        if (fault.action === 'throw') throw Object.assign(Error('Injected acceptance publication failure'), { code: 'EPERM' });
      }
    }
    return result;
  };
}
dialog.showOpenDialog = async (_window, options) => {
  const started = performance.now();
  const c = control();
  try {
    if (options.title === 'Restore From Backup') return { canceled: false, filePaths: [c.archive] };
    if (options.properties?.includes('openDirectory')) return { canceled: false, filePaths: [c.workspace] };
    if (options.properties?.includes('openFile')) return { canceled: false, filePaths: [path.join(c.workspace, 'main.c')] };
    throw Error('Unexpected acceptance open dialog: ' + options.title);
  } finally { traceEvent('dialog', options.properties?.includes('openFile') ? 'open-file' : 'other', started); }
};
dialog.showSaveDialog = async (_window, options) => {
  if (options.title !== 'Back Up My Ion Data') throw Error('Unexpected acceptance save dialog: ' + options.title);
  return { canceled: false, filePath: control().archive };
};
dialog.showMessageBox = async (_window, options) => {
  receipt('native-message', { message: String(options.message).slice(0, 500), buttons: options.buttons });
  return { response: options.cancelId ?? 0, checkboxChecked: false }; // Never approve execution.
};
globalThis.__ionAcceptance = {
  snapshot: () => ({ pid: process.pid, profile: app.getPath('userData'), calls, storage,
    window: BrowserWindow.getAllWindows().map(w => ({ bounds: w.getBounds(), visible: w.isVisible(), fullscreen: w.isFullScreen() })),
    display: { bounds: screen.getPrimaryDisplay().bounds, scaleFactor: screen.getPrimaryDisplay().scaleFactor },
    backupLoaded: Object.keys(require.cache).some(name => /[/\\]backup[/\\](service|transaction)\.cjs$/.test(name)),
    processes: app.getAppMetrics().map(({ pid, creationTime }) => ({ pid, creationTime })),
    handles: process._getActiveHandles().map(h => h.constructor.name), trace: trace.slice() }),
  resetTrace: () => { trace.length = 0; traceEvent('control', 'reset'); },
  quit: () => setImmediate(() => app.quit()),
};
const metrics = () => app.getAppMetrics().map(({ pid, creationTime }) => ({ pid, creationTime }));
app.on('ready', () => { traceEvent('startup', 'electron-ready', 0); receipt('ready', { processes: metrics() }); });
app.on('browser-window-created', (_event, window) => {
  traceEvent('startup', 'window-created', 0);
  receipt('window', { processes: metrics() });
  window.webContents.once('dom-ready', () => traceEvent('startup', 'dom-ready', 0));
  window.webContents.once('did-finish-load', () => { traceEvent('startup', 'did-finish-load', 0); receipt('loaded', { processes: metrics() }); });
});
app.on('will-quit', () => receipt('quit'));
require(process.env.ION_CORE_PRODUCTION_ENTRY);
