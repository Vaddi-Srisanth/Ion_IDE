import { useEffect, useRef, useState } from 'react'
import type { LearningPacksBridge, PackLibrary, PackSummary } from '../../shared/learning-packs'
import { errorMessage } from '../documents'
import { Icon } from '../icons'
import './learning.css'

interface Props {
  packs: LearningPacksBridge
  library: PackLibrary | null
  loadError?: string
  onRetry?(): void
  onLibraryChange(library: PackLibrary): void
  onClose(): void
  onLearn(): void
}

export function MarketplacePane({ packs, library, loadError, onRetry, onLibraryChange, onClose, onLearn }: Props) {
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const mounted = useRef(false)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    mounted.current = true
    search.current?.focus()
    return () => { mounted.current = false }
  }, [])

  async function update(action: string, run: () => Promise<PackLibrary | null>, message?: string, openLearn = false) {
    setPending(action)
    setNotice(null)
    try {
      const next = await run()
      if (!next) return
      onLibraryChange(next)
      if (!mounted.current) return
      if (openLearn) onLearn()
      else if (message) setNotice({ text: message })
    } catch (reason) {
      if (mounted.current) setNotice({ text: errorMessage(reason), error: true })
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  const term = query.trim().toLowerCase()
  const matches = ({ id, name, summary }: PackSummary) => !term || [id, name, summary].some((text) => text.toLowerCase().includes(term))
  const installedIds = new Set(library?.installed.map(({ id }) => id))
  const installed = library?.installed.filter(matches) ?? []
  const available = library?.catalog.filter((pack) => !installedIds.has(pack.id) && matches(pack)) ?? []

  function packRow(pack: PackSummary, local: boolean) {
    const { id, name, summary, topicCount } = pack
    return <li className="marketplace-pack" key={id} data-testid="marketplace-pack" data-pack={id}>
      <div className="marketplace-pack-title">
        <h4>{name}</h4>
        {library?.selected === id && <span className="marketplace-current"><Icon name="check" size={11}/> In use</span>}
      </div>
      <p className="marketplace-pack-summary">{summary}</p>
      <p className="marketplace-pack-size">{topicCount} {topicCount === 1 ? 'topic' : 'topics'}</p>
      <div className="marketplace-actions">
        {local ? <>
          <button type="button" className="button marketplace-button" data-testid="marketplace-use" data-pack={id} disabled={pending !== null}
            aria-label={'Use ' + name + ' in Learn'} onClick={() => void update('use:' + id, () => packs.select(id), undefined, true)}>
            {pending === 'use:' + id ? 'Opening…' : 'Use in Learn'}
          </button>
          <button type="button" className="icon-button marketplace-remove" data-testid="marketplace-remove" data-pack={id}
            title={'Remove ' + name} aria-label={'Remove ' + name} disabled={pending !== null}
            onClick={() => void update('remove:' + id, () => packs.remove(id), name + ' removed.')}>
            <Icon name="trash" size={14}/>
          </button>
        </> : <button type="button" className="button marketplace-button" data-testid="marketplace-install" data-pack={id} disabled={pending !== null}
          aria-label={'Install ' + name} onClick={() => void update('install:' + id, () => packs.install(id), name + ' installed. Choose it in Learn when you’re ready.')}>
          <Icon name="plus" size={13}/>{pending === 'install:' + id ? 'Installing…' : 'Install'}
        </button>}
      </div>
    </li>
  }

  return (
    <aside className="learning-pane marketplace-pane" aria-label="Marketplace" data-testid="marketplace-pane">
      <header className="pane-title">
        <h2><Icon name="marketplace" size={14}/> Marketplace</h2>
        <button type="button" className="icon-button" aria-label="Hide Marketplace" onClick={onClose}><Icon name="x" size={15}/></button>
      </header>
      <div className="marketplace-controls">
        <label className="marketplace-search">
          <Icon name="search" size={15}/>
          <input ref={search} type="search" placeholder="Find a language" aria-label="Find a language pack"
            data-testid="marketplace-search" value={query} onChange={(event) => setQuery(event.currentTarget.value)}/>
        </label>
        <button type="button" className="button marketplace-button" data-testid="marketplace-import" disabled={!library || pending !== null}
          title="Import a local JSON learning pack" onClick={() => void update('import', () => packs.importPack(), 'Pack imported. Choose it in Learn when you’re ready.')}>
          <Icon name="open" size={14}/>{pending === 'import' ? 'Importing…' : 'Import pack'}
        </button>
      </div>
      <div className="marketplace-scroll">
        {notice && <p className={notice.error ? 'learning-error' : 'marketplace-notice'}
          role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
        {!library ? (loadError
          ? <><p className="learning-error" role="alert">{loadError}</p>
            {onRetry && <button type="button" className="button" onClick={onRetry}>Retry</button>}</>
          : <p className="learning-copy" role="status">Opening Marketplace…</p>)
          : installed.length === 0 && available.length === 0 && term
            ? <p className="learning-copy">No language packs match your search.</p>
            : <>
              {installed.length > 0 && <section className="marketplace-section">
                <h3>Installed <span>{installed.length}</span></h3>
                <ul>{installed.map((pack) => packRow(pack, true))}</ul>
              </section>}
              {available.length > 0 && <section className="marketplace-section">
                <h3>Available <span>{available.length}</span></h3>
                <ul>{available.map((pack) => packRow(pack, false))}</ul>
              </section>}
              {!term && !installed.length && !available.length && <p className="learning-copy">No packs are available. Import a JSON learning pack to get started.</p>}
            </>}
      </div>
      <p className="marketplace-footer">Learning material · Works offline</p>
    </aside>
  )
}
