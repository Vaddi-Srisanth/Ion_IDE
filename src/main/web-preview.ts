import { BrowserWindow, session } from 'electron'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { isWithin } from './files'

const scheme = 'ion-preview'
const origin = scheme + '://site'
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
}
const previewPolicy = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'",
  "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ')

function previewUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === scheme + ':' && url.host === 'site' && !url.username && !url.password) return url
  } catch { /* Invalid preview URL. */ }
}

async function previewEntry(root: string, path: string): Promise<string> {
  if (/\.html?$/i.test(path)) return path
  if (!/\.(?:css|m?js)$/i.test(path)) throw new Error('Open an HTML, CSS, or JavaScript file to preview a web project.')
  let directory = dirname(path)
  while (isWithin(root, directory)) {
    for (const name of ['index.html', 'index.htm']) {
      const candidate = join(directory, name)
      if (await realpath(candidate).catch(() => null) === candidate) return candidate
    }
    if (directory === root) break
    directory = dirname(directory)
  }
  throw new Error('No index.html was found in this folder or the open workspace. Open the HTML entry file to preview it.')
}

async function serve(root: string, request: Request): Promise<Response> {
  const url = previewUrl(request.url)
  if (!url || request.method !== 'GET') return new Response(null, { status: 403 })
  try {
    const pathname = decodeURIComponent(url.pathname)
    if (pathname.includes('\0') || pathname.includes('\\')) return new Response(null, { status: 403 })
    const path = resolve(root, '.' + pathname)
    const type = mime[extname(path).toLowerCase()]
    if (!type || path === root || !isWithin(root, path) || await realpath(path) !== path) {
      return new Response(null, { status: 404 })
    }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stats = await file.stat()
      const limit = (type.startsWith('image/') ? 8 : 2) * 1024 * 1024
      if (!stats.isFile() || stats.size > limit) return new Response(null, { status: 413 })
      const bytes = new Uint8Array(stats.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      return new Response(bytes.subarray(0, offset), {
        headers: { 'Content-Type': type, 'Content-Security-Policy': previewPolicy, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff' },
      })
    } finally {
      await file.close()
    }
  } catch {
    return new Response(null, { status: 404 })
  }
}

export async function openWebPreview(parent: BrowserWindow, root: string, path: string): Promise<BrowserWindow> {
  const entry = await previewEntry(root, path)
  if (parent.isDestroyed()) throw new Error('The workbench has closed.')
  const isolated = session.fromPartition('ion-web-preview', { cache: false })
  await isolated.clearStorageData()
  if (parent.isDestroyed()) throw new Error('The workbench has closed.')
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: !previewUrl(request.url) && !/^(data:|blob:)/.test(request.url) })
  })
  isolated.protocol.handle(scheme, (request) => serve(root, request))
  const target = new BrowserWindow({
    parent, title: 'Web Preview · ' + basename(entry), width: 950, height: 700, show: false,
    backgroundColor: '#ffffff',
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  })
  target.on('page-title-updated', (event) => event.preventDefault())
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  target.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !previewUrl(event.url)) event.preventDefault()
  })
  target.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (process.platform === 'darwin' ? input.meta : input.control) && input.key.toLowerCase() === 'r') {
      event.preventDefault()
      target.webContents.reload()
    }
  })
  target.once('ready-to-show', () => target.show())
  target.once('closed', () => {
    isolated.protocol.unhandle(scheme)
    isolated.webRequest.onBeforeRequest(null)
  })
  try {
    await target.loadURL(origin + '/' + relative(root, entry).split(sep).map(encodeURIComponent).join('/'))
    return target
  } catch (error) {
    if (!target.isDestroyed()) target.destroy()
    throw error
  }
}
