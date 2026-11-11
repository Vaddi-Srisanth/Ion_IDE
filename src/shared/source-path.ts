/** Convert Monaco's decoded file URI without lowercasing a Windows drive.
 * Workspace authorization deliberately preserves the native picker spelling. */
export function sourcePathFromUri(uri: { scheme: string; authority: string; path: string }, platform: string): string | undefined {
  if (uri.scheme !== 'file' || !uri.path.startsWith('/') || uri.path.includes('\0')) return
  if (platform === 'win32') {
    if (uri.authority) return '\\\\' + uri.authority + uri.path.replaceAll('/', '\\')
    if (/^\/[a-z]:\//i.test(uri.path)) return uri.path.slice(1).replaceAll('/', '\\')
    return
  }
  return (uri.authority ? '//' + uri.authority : '') + uri.path
}

/** Windows drive letters are aliases. Directory spelling can still identify
 * distinct case-sensitive NTFS folders and must never be folded here. */
export function sourceDriveSpelling(path: string, source: string, platform: string): string {
  if (platform === 'win32' && /^[a-z]:[\\/]/i.test(path) && /^[a-z]:[\\/]/i.test(source)
    && path[0].toLowerCase() === source[0].toLowerCase()) return source[0] + path.slice(1)
  return path
}
