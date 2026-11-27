import type { ExplanationRequest } from '../../shared/explanations'
import type { Documents } from '../documents'

function clipped(text: string, bytes: number): string {
  if (text.length && /[\ud800-\udbff]/.test(text.at(-1)!)) text = text.slice(0, -1)
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= bytes) return text
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = bytes; end >= bytes - 3; end--) {
    try { return decoder.decode(encoded.subarray(0, end)) } catch { /* Drop a partial trailing code point. */ }
  }
  return ''
}

/** Called only after opening optional explanations or explicitly reviewing selected code. */
export function captureEditorContext(documents: Documents): ExplanationRequest['code'] {
  const { activeId, tabs } = documents.getSnapshot()
  const tab = tabs.find(item => item.id === activeId)
  if (!tab || tab.viewer || tab.notebookMode || tab.error || tab.conflict) return
  const version = documents.textVersion(tab.id)
  const text = documents.activeTextPrefix(tab.id, 8192)
  if (version === undefined || text === undefined) return
  return { ...(tab.path ? { path: tab.path } : {}), label: clipped(tab.name, 256),
    text: clipped(text, 8192), version }
}

/** Escape terminal framing as visible data; preserve the original Run Console separately. */
export function diagnosticContext(raw: string): string {
  return clipped(raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
    character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')), 2048)
}
