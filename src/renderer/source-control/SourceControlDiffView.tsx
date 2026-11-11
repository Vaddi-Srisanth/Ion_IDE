import { useEffect, useRef, useState } from 'react'
import { editor } from 'monaco-editor/editor/editor.api.js'
import { fileLanguage } from '../../shared/languages'
import type { SourceControlDiff } from '../../shared/source-control'
import type { ThemeData } from '../../shared/themes'
import { errorMessage } from '../documents'
import { Icon } from '../icons'
import { loadEditor } from '../load-editor'
import { applyEditorTheme } from '../themes/editor-theme'
import './source-control.css'

interface Props {
  diff: SourceControlDiff
  dirty: boolean
  onClose(): void
  theme: ThemeData | null
  accentColor?: string
}

export default function SourceControlDiffView({ diff, dirty, onClose, theme, accentColor }: Props) {
  const [sideBySide, setSideBySide] = useState(true)
  const [changes, setChanges] = useState<number | null>(null)
  const [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const instance = useRef<editor.IStandaloneDiffEditor | undefined>(undefined)
  const appearance = useRef({ theme, accentColor })
  appearance.current = { theme, accentColor }

  useEffect(() => { closeButton.current?.focus() }, [])

  useEffect(() => {
    setError('')
    setChanges(null)
    if (diff.kind !== 'text' || !host.current) return
    const node = host.current
    let mounted = true
    let release: (() => void) | undefined
    void loadEditor().then(() => {
      if (!mounted) return
      const language = fileLanguage(diff.path).syntax ?? 'plaintext'
      const current = appearance.current
      if (current.theme) applyEditorTheme(current.theme, current.accentColor)
      const view = editor.createDiffEditor(node, {
        renderSideBySide: sideBySide, useInlineViewWhenSpaceIsLimited: false,
        readOnly: true, originalEditable: false, automaticLayout: true,
        minimap: { enabled: false }, lineDecorationsWidth: 10, glyphMargin: false,
        scrollBeyondLastLine: false, maxComputationTime: 1000, maxFileSize: 1, wordWrap: 'off',
        fontSize: 12,
      })
      instance.current = view
      let original: editor.ITextModel | undefined
      let modified: editor.ITextModel | undefined
      let event: { dispose(): void } | undefined
      release = () => {
        event?.dispose()
        view.setModel(null)
        view.dispose()
        original?.dispose()
        modified?.dispose()
        instance.current = undefined
      }
      original = editor.createModel(diff.original, language)
      modified = editor.createModel(diff.modified, language)
      event = view.onDidUpdateDiff(() => { setChanges(view.getLineChanges()?.length ?? 0) })
      view.setModel({ original, modified })
      void view.revealFirstDiff()
    }).catch((reason: unknown) => {
      release?.()
      release = undefined
      if (mounted) setError(errorMessage(reason))
    })
    return () => {
      mounted = false
      release?.()
    }
  // Layout and palette changes update the mounted diff editor below.
  }, [diff])

  useEffect(() => { instance.current?.updateOptions({ renderSideBySide: sideBySide }) }, [sideBySide])
  useEffect(() => { if (instance.current && theme) applyEditorTheme(theme, accentColor) }, [theme, accentColor])

  const label = diff.side === 'staged' ? 'Staged changes' : 'Working tree changes'
  const path = diff.previousPath ? diff.previousPath + ' → ' + diff.path : diff.path
  return <section className="source-control-diff" aria-label={label} data-testid="git-diff" data-git-path={diff.path}
    data-diff-side={diff.side} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }}>
    <div className="source-control-diff-toolbar">
      <div className="source-control-diff-label">
        <strong title={path}>{path}</strong>
        <span>{label}</span>
      </div>
      {diff.kind === 'text' && !error && <div className="source-control-diff-actions">
        <button type="button" className="button" onClick={() => setSideBySide((current) => !current)}
          aria-pressed={!sideBySide} data-testid="git-diff-layout">
          <Icon name="columns" size={13}/>{sideBySide ? 'Inline' : 'Side by side'}
        </button>
        <button type="button" className="icon-button" onClick={() => instance.current?.goToDiff('previous')}
          disabled={!changes} title="Previous Change" aria-label="Previous Change"><span aria-hidden="true">↑</span></button>
        <button type="button" className="icon-button" onClick={() => instance.current?.goToDiff('next')}
          disabled={!changes} title="Next Change" aria-label="Next Change"><span aria-hidden="true">↓</span></button>
      </div>}
      <button type="button" className="icon-button" ref={closeButton} onClick={onClose}
        title="Close Diff" aria-label="Close Diff" data-testid="git-diff-close"><Icon name="x" size={15}/></button>
    </div>
    {dirty && <p className="source-control-diff-warning" data-testid="git-diff-unsaved">
      <Icon name="warning" size={14}/>You have unsaved edits. This diff shows saved content.
    </p>}
    {diff.kind === 'text' && <div className="source-control-diff-sides" data-layout={sideBySide ? 'split' : 'inline'}>
      <span>{diff.side === 'staged' ? 'HEAD' : 'Index'}</span>
      <span>{diff.side === 'staged' ? 'Index' : 'Saved file'}</span>
    </div>}
    {diff.kind === 'unavailable' ? <p className="source-control-diff-message" role="status">{diff.message}</p> : <>
      {error && <p className="source-control-diff-message" role="alert">{error}</p>}
      {changes === 0 && !error && <p className="source-control-diff-message" role="status">
        {diff.original === diff.modified ? 'No text changes. Git may report a mode or name change.'
          : 'No changed lines. Git may report differences in line endings.'}
      </p>}
      <div ref={host} className="source-control-diff-editor" data-testid="git-diff-editor"/>
    </>}
  </section>
}
