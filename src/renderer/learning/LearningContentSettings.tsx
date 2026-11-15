import { useEffect, useRef, useState } from 'react'
import type { LearningPacksBridge, PackImportPreview, PackLibrary, PackSummary } from '../../shared/learning-packs'
import { errorMessage } from '../documents'
import './content-settings.css'

interface Props {
  packs: LearningPacksBridge
  onLibraryChange(library: PackLibrary): void
}

interface Session {
  busy: boolean
  previewToken: string | null
}

export function LearningContentSettings({ packs, onLibraryChange }: Props) {
  const [library, setLibrary] = useState<PackLibrary | null>(null)
  const [pending, setPending] = useState<string | null>('loading')
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const [preview, setPreview] = useState<PackImportPreview | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const session = useRef<Session | null>(null)
  const listeners = useRef(onLibraryChange)
  listeners.current = onLibraryChange

  useEffect(() => {
    const current: Session = { busy: true, previewToken: null }
    session.current = current
    setLibrary(null)
    setPreview(null)
    setRemoving(null)
    setNotice(null)
    setPending('loading')
    void packs.getLibrary(true).then(
      (next) => { if (session.current === current) setLibrary(next) },
      (reason: unknown) => {
        if (session.current === current) setNotice({ text: errorMessage(reason), error: true })
      },
    ).finally(() => {
      current.busy = false
      if (session.current === current) setPending(null)
    })
    return () => {
      if (session.current === current) session.current = null
      if (current.previewToken) {
        void packs.discardImport(current.previewToken).catch(() => {})
        current.previewToken = null
      }
    }
  }, [packs])

  async function act(action: string, execute: (current: Session) => Promise<void>) {
    const current = session.current
    if (!current || current.busy) return
    current.busy = true
    setPending(action)
    setNotice(null)
    try { await execute(current) }
    catch (reason) {
      if (session.current === current) setNotice({ text: errorMessage(reason), error: true })
    } finally {
      current.busy = false
      if (session.current === current) setPending(null)
    }
  }

  function publish(current: Session, next: PackLibrary, text: string) {
    if (session.current !== current) return
    setLibrary(next)
    setRemoving(null)
    setNotice({ text })
    listeners.current(next)
  }

  function importContent() {
    void act('import', async (current) => {
      const next = await packs.previewImport()
      if (!next) return
      if (session.current !== current) {
        await packs.discardImport(next.token)
        return
      }
      current.previewToken = next.token
      setRemoving(null)
      setPreview(next)
    })
  }

  function confirmImport() {
    if (!preview) return
    const reviewed = preview
    void act('confirm-import', async (current) => {
      try {
        const next = await packs.confirmImport(reviewed.token)
        publish(current, next, reviewed.details.pack.name + ' imported.')
      } finally {
        current.previewToken = null
        if (session.current === current) setPreview(null)
      }
    })
  }

  function discardImport() {
    if (!preview) return
    const reviewed = preview
    void act('discard-import', async (current) => {
      await packs.discardImport(reviewed.token)
      current.previewToken = null
      if (session.current === current) setPreview(null)
    })
  }

  function exportContent(pack: PackSummary) {
    void act('export:' + pack.id, async (current) => {
      const exported = await packs.exportPack(pack.id)
      if (exported && session.current === current) setNotice({ text: pack.name + ' exported.' })
    })
  }

  const blocked = pending !== null || preview !== null
  const catalog = new Map(library?.catalog.map((pack) => [pack.id, pack]))

  return <section className="settings-group learning-content-settings" aria-labelledby="learning-content-heading"
    data-testid="learning-content-settings">
    <div className="learning-content-heading">
      <div>
        <h3 id="learning-content-heading">Learning content</h3>
        <p>Built-in languages are available directly in Learn. Manage saved copies and imported JSON lessons here.</p>
      </div>
      <button type="button" className="button" data-testid="content-import" disabled={blocked || !library}
        onClick={importContent}>{pending === 'import' ? 'Opening…' : 'Import JSON'}</button>
    </div>

    {pending === 'loading' && <p role="status">Opening content…</p>}
    {notice && <p className={notice.error ? 'learning-content-error' : 'learning-content-notice'}
      role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {!library && pending === null && <button type="button" className="button" onClick={() => {
      void act('loading', async (current) => {
        const next = await packs.getLibrary(true)
        if (session.current === current) setLibrary(next)
      })
    }}>Retry</button>}

    {preview && <div className="learning-content-confirm" role="region" aria-label="Review learning content import"
      data-testid="content-import-preview">
      <h4>{preview.update ? 'Review content update' : 'Review import'}: {preview.details.pack.name}</h4>
      <p>{preview.details.pack.summary}</p>
      <p>Version {preview.details.pack.version} · {preview.details.pack.topicCount} {preview.details.pack.topicCount === 1 ? 'lesson' : 'lessons'}
        {preview.details.pack.author ? ' · ' + preview.details.pack.author : ''}</p>
      <p>Only validated lesson data is imported. Existing lesson IDs are preserved when updating content.</p>
      <details data-testid="content-import-review">
        <summary>Review lesson titles and attribution</summary>
        <p>Collection ID: {preview.details.pack.id}</p>
        <p>Author: {preview.details.pack.author ?? 'Not provided'} · License: {preview.details.pack.license ?? 'Not provided'}</p>
        <ul>{preview.details.topics.map(topic => <li key={topic.id}>{topic.title}</li>)}</ul>
      </details>
      <div className="learning-content-actions">
        <button type="button" className="button" disabled={pending !== null} data-testid="content-import-discard"
          onClick={discardImport}>Discard</button>
        <button type="button" className="button primary" disabled={pending !== null} data-testid="content-import-confirm"
          onClick={confirmImport}>{pending === 'confirm-import' ? 'Importing…' : preview.update ? 'Confirm update' : 'Confirm import'}</button>
      </div>
    </div>}

    {library && (library.installed.length ? <ul className="learning-content-list" aria-label="Saved learning content">
      {library.installed.map((pack) => {
        const bundled = catalog.get(pack.id)
        const update = pack.source === 'catalog' && bundled && bundled.version > pack.version
        return <li key={pack.id} data-content-id={pack.id}>
          <div className="learning-content-row">
            <div className="learning-content-description">
              <strong>{pack.name}</strong>
              <span>Version {pack.version} · {pack.source === 'catalog' ? 'Built-in copy' : 'Imported'} · {pack.topicCount} {pack.topicCount === 1 ? 'lesson' : 'lessons'}</span>
            </div>
            <div className="learning-content-actions">
              {update && <button type="button" className="button" disabled={blocked} data-testid="content-update"
                aria-label={'Update ' + pack.name} onClick={() => {
                  void act('update:' + pack.id, async (current) => {
                    publish(current, await packs.install(pack.id), pack.name + ' updated.')
                  })
                }}>{pending === 'update:' + pack.id ? 'Updating…' : 'Update to v' + bundled.version}</button>}
              <button type="button" className="button" disabled={blocked} data-testid="content-export"
                aria-label={'Export ' + pack.name} onClick={() => exportContent(pack)}>
                {pending === 'export:' + pack.id ? 'Exporting…' : 'Export'}</button>
              <button type="button" className="button" disabled={blocked} data-testid="content-remove"
                aria-label={'Remove ' + pack.name} onClick={() => setRemoving(pack.id)}>Remove</button>
            </div>
          </div>
          {removing === pack.id && <div className="learning-content-confirm" role="region"
            aria-label={'Confirm removing ' + pack.name} data-testid="content-remove-confirmation">
            <p>Remove the saved copy of {pack.name}? Attempts, notes, and diagnostic history remain.
              {pack.source === 'catalog' ? ' Built-in lessons remain available in Learn.' : ' Export imported content first if you may need it later.'}</p>
            <div className="learning-content-actions">
              <button type="button" className="button" disabled={blocked} onClick={() => setRemoving(null)}>Cancel</button>
              <button type="button" className="button" disabled={blocked} data-testid="content-remove-confirm"
                onClick={() => {
                  void act('remove:' + pack.id, async (current) => {
                    publish(current, await packs.remove(pack.id), pack.name + ' saved copy removed.')
                  })
                }}>{pending === 'remove:' + pack.id ? 'Removing…' : 'Remove saved copy'}</button>
            </div>
          </div>}
        </li>
      })}
    </ul> : <p>No saved copies or imported lessons yet. Choose any built-in language in Learn to begin.</p>)}
  </section>
}
