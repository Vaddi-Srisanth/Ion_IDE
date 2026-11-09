import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { packCategories, packDifficulties } from '../../shared/learning-packs'
import type {
  LearningPacksBridge, PackCategory, PackDetails, PackDifficulty, PackImportPreview, PackKind, PackLibrary, PackSummary,
} from '../../shared/learning-packs'
import { errorMessage } from '../documents'
import { Icon } from '../icons'
import './learning.css'
import './marketplace.css'

interface Props {
  packs: LearningPacksBridge
  library: PackLibrary | null
  loadError?: string
  onRetry?(): void
  onLibraryChange(library: PackLibrary): void
  onClose(): void
  onLearn(): void
}

const categoryNames: Record<PackCategory, string> = {
  core: 'Core languages', web: 'Web development', automation: 'Scripting & automation',
  data: 'Data & analytics', systems: 'Systems & other',
}
const difficultyNames: Record<PackDifficulty, string> = {
  beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced',
}
const kindNames: Record<PackKind, string> = {
  language: 'Programming language', markup: 'Markup', stylesheet: 'Stylesheet',
  query: 'Query language', 'data-format': 'Data format', framework: 'Framework',
}
type View = 'list' | 'cards'
type Sort = 'catalog' | 'name' | 'recent' | 'lessons'

interface CatalogItem {
  pack: PackSummary
  installed: boolean
  canUpdate: boolean
  recent: number | undefined
  searchText: string
}

const packSize = (pack: PackSummary) => pack.byteSize === undefined ? null
  : pack.byteSize < 1024 ? pack.byteSize + ' B' : (pack.byteSize / 1024).toFixed(1) + ' KiB'
const lessonCount = (pack: PackSummary) => pack.topicCount + (pack.topicCount === 1 ? ' lesson' : ' lessons')
const rowGap = 5

function catalogItems(library: PackLibrary): CatalogItem[] {
  const installed = new Map(library.installed.map((pack) => [pack.id, pack]))
  const recent = new Map(library.recent?.map((id, index) => [id, index]))
  const bundled = new Map(library.catalog.map((pack) => [pack.id, pack]))
  const items = new Map([...bundled, ...installed])
  return Array.from(items.values(), (pack) => ({
    pack,
    installed: installed.has(pack.id),
    canUpdate: pack.source === 'catalog' && installed.has(pack.id) && (bundled.get(pack.id)?.version ?? 0) > pack.version,
    recent: recent.get(pack.id),
    searchText: [pack.id, pack.name, pack.summary, ...(pack.keywords ?? []),
      ...(pack.categories?.map((tag) => categoryNames[tag]) ?? []), pack.kind ? kindNames[pack.kind] : '']
      .join(' ').toLowerCase(),
  }))
}

interface PackListProps {
  items: CatalogItem[]
  view: View
  viewport: RefObject<HTMLDivElement | null>
  offset: RefObject<number>
  renderPack(item: CatalogItem, position: number, count: number): ReactNode
}

function PackList({ items, view, viewport, offset, renderPack }: PackListProps) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(() => offset.current)
  const columns = view === 'list' ? 1 : Math.max(1, Math.floor((size.width + rowGap) / 195))
  const rowHeight = view === 'list' ? 77 : 119
  const stride = rowHeight + rowGap
  const rows = Math.ceil(items.length / columns)
  const windowed = items.length > 30
  const first = windowed ? Math.max(0, Math.min(rows - 1, Math.floor(scrollTop / stride) - 3)) : 0
  const last = windowed ? Math.min(rows, first + Math.ceil(size.height / stride) + 8) : rows

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = () => {
      const width = Math.max(0, element.clientWidth - 16)
      const height = element.clientHeight
      setSize((previous) => previous.width === width && previous.height === height ? previous : { width, height })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [viewport])

  useLayoutEffect(() => {
    viewport.current?.scrollTo({ top: offset.current })
  }, [offset, viewport])

  return <div ref={viewport} className="marketplace-scroll marketplace-viewport" data-testid="marketplace-list-scroll"
    onScroll={(event) => {
      offset.current = event.currentTarget.scrollTop
      if (windowed) setScrollTop(Math.floor(offset.current / stride) * stride)
    }}>
    <ul className="marketplace-list" aria-label="Learning packs" data-view={view} data-windowed={windowed}
      style={{
        gridTemplateColumns: 'repeat(' + columns + ', minmax(0, 1fr))', gridAutoRows: rowHeight,
        paddingBlockStart: first * stride, paddingBlockEnd: (rows - last) * stride,
      }}>
      {items.slice(first * columns, last * columns).map((item, index) =>
        renderPack(item, first * columns + index + 1, items.length))}
    </ul>
  </div>
}

function DetailContents({ details, onReference }: { details: PackDetails; onReference(url: string): void }) {
  const { pack, topics, prerequisites, references, miniProject } = details
  return <>
    <p className="marketplace-detail-summary">{pack.summary}</p>
    <dl className="marketplace-detail-meta">
      <div><dt>Pack version</dt><dd>{pack.version}</dd></div>
      {pack.kind && <div><dt>Type</dt><dd>{kindNames[pack.kind]}</dd></div>}
      {pack.languageVersion && <div><dt>Language version</dt><dd>{pack.languageVersion}</dd></div>}
      {pack.minimumIonVersion && <div><dt>Minimum Ion version</dt><dd>{pack.minimumIonVersion}</dd></div>}
      <div><dt>Storage</dt><dd>{packSize(pack) ?? 'Size unavailable'}</dd></div>
      <div><dt>Access</dt><dd>Offline after installation</dd></div>
      <div><dt>Diagnostics</dt><dd>{pack.diagnostics ? 'Offline explanations for supported errors' : 'Lessons and exercises'}</dd></div>
      <div><dt>Author</dt><dd>{pack.author ?? 'Unspecified'}</dd></div>
      <div><dt>License</dt><dd>{pack.license ?? 'Unspecified'}</dd></div>
    </dl>
    {!!pack.categories?.length && <p className="marketplace-tags" aria-label="Pack categories">
      {pack.categories.map((category) => <span key={category}>{categoryNames[category]}</span>)}
    </p>}
    <section>
      <h4>Prerequisites</h4>
      {prerequisites.length
        ? <ul className="marketplace-detail-list">{prerequisites.map((item, index) => <li key={index}>{item}</li>)}</ul>
        : <p>No prerequisites listed.</p>}
    </section>
    <section>
      <h4>Lessons <span>{topics.length}</span></h4>
      <ol className="marketplace-detail-list marketplace-lesson-index">
        {topics.map((topic) => <li key={topic.id}>{topic.title}
          {topic.difficulty && <small>{difficultyNames[topic.difficulty]}</small>}
        </li>)}
      </ol>
    </section>
    {miniProject && <section><h4>Mini-project</h4><p>{miniProject}</p></section>}
    {!!references.length && <section>
      <h4>References</h4>
      <p>Opens in your browser.</p>
      <ul className="marketplace-detail-list marketplace-references">
        {references.map(({ title, url }, index) => <li key={index}>
          <button type="button" className="marketplace-reference" title={url} onClick={() => onReference(url)}>
            {title}<Icon name="diagonal" size={12}/>
          </button>
        </li>)}
      </ul>
    </section>}
  </>
}

export function MarketplacePane({ packs, library, loadError, onRetry, onLibraryChange, onClose, onLearn }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<PackCategory | ''>('')
  const [difficulty, setDifficulty] = useState<PackDifficulty | ''>('')
  const [installedOnly, setInstalledOnly] = useState(false)
  const [sort, setSort] = useState<Sort>('catalog')
  const [view, setView] = useState<View>('list')
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const [details, setDetails] = useState<PackDetails | null>(null)
  const [preview, setPreview] = useState<PackImportPreview | null>(null)
  const mounted = useRef(false)
  const search = useRef<HTMLInputElement>(null)
  const importButton = useRef<HTMLButtonElement>(null)
  const detailBack = useRef<HTMLButtonElement>(null)
  const listViewport = useRef<HTMLDivElement>(null)
  const listOffset = useRef(0)
  const previewToken = useRef<string | null>(null)
  const returnFocus = useRef<{ packId: string } | 'import' | null>(null)

  useEffect(() => {
    mounted.current = true
    search.current?.focus()
    return () => {
      mounted.current = false
      if (previewToken.current) void packs.discardImport(previewToken.current).catch(() => {})
    }
  }, [packs])

  useEffect(() => {
    if (details || preview) detailBack.current?.focus()
  }, [details, preview])

  async function act(action: string, run: () => Promise<void>) {
    setPending(action)
    setNotice(null)
    try {
      await run()
    } catch (reason) {
      if (mounted.current) setNotice({ text: errorMessage(reason), error: true })
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  function update(action: string, run: () => Promise<PackLibrary>, message?: string, openLearn = false) {
    return act(action, async () => {
      const next = await run()
      onLibraryChange(next)
      if (!mounted.current) return
      setDetails(null)
      setPreview(null)
      if (openLearn) onLearn()
      else if (message) setNotice({ text: message })
    })
  }

  function openDetails(id: string) {
    return act('details:' + id, async () => {
      const next = await packs.getDetails(id)
      if (mounted.current) {
        returnFocus.current = { packId: id }
        setDetails(next)
      }
    })
  }

  function importPack() {
    return act('import', async () => {
      const next = await packs.previewImport()
      if (!next) return
      if (!mounted.current) {
        await packs.discardImport(next.token)
        return
      }
      returnFocus.current = 'import'
      previewToken.current = next.token
      setPreview(next)
    })
  }

  function cancelPreview(item: PackImportPreview) {
    setPreview(null)
    previewToken.current = null
    void act('cancel-import', () => packs.discardImport(item.token))
  }

  function exportPack(pack: PackSummary) {
    return act('export:' + pack.id, async () => {
      if (await packs.exportPack(pack.id) && mounted.current) setNotice({ text: pack.name + ' exported.' })
    })
  }

  function openReference(url: string) {
    void act('reference', async () => { await window.ion.markdown.openLink(null, url) })
  }

  function resetList() {
    listOffset.current = 0
    listViewport.current?.scrollTo({ top: 0 })
  }

  const items = useMemo(() => library ? catalogItems(library) : [], [library])
  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const matches = items.filter(({ pack, installed, searchText }) =>
      (!installedOnly || installed) && (!category || pack.categories?.includes(category)) &&
      (!difficulty || pack.difficulties?.includes(difficulty)) && words.every((word) => searchText.includes(word)))
    if (sort === 'name') matches.sort((left, right) => left.pack.name.localeCompare(right.pack.name))
    if (sort === 'lessons') matches.sort((left, right) => right.pack.topicCount - left.pack.topicCount)
    if (sort === 'recent') matches.sort((left, right) =>
      (left.recent ?? Number.MAX_SAFE_INTEGER) - (right.recent ?? Number.MAX_SAFE_INTEGER))
    return matches
  }, [items, query, category, difficulty, installedOnly, sort])

  useEffect(() => {
    const restore = returnFocus.current
    if (details || preview || pending || !restore) return
    if (restore === 'import') importButton.current?.focus()
    else if (!filtered.some(({ pack }) => pack.id === restore.packId)) search.current?.focus()
    else return // The row restores focus when the list renders it again.
    returnFocus.current = null
  }, [details, preview, pending, filtered])

  function packActions({ pack, installed, canUpdate }: CatalogItem, inDetails = false) {
    const { id, name } = pack
    const manageInstalled = installed && (!canUpdate || inDetails)
    return <div className="marketplace-actions">
      {(!installed || canUpdate) && <button type="button" className="button marketplace-button marketplace-primary"
        data-testid="marketplace-install" data-pack={id} disabled={pending !== null}
        aria-label={(installed ? 'Update ' : 'Install ') + name}
        onClick={() => void update('install:' + id, () => packs.install(id),
          installed ? name + ' updated.' : name + ' installed. Choose it in Learn when you’re ready.')}>
        {pending === 'install:' + id ? 'Working…' : installed ? 'Update' : 'Install'}
      </button>}
      {manageInstalled && <button type="button" className="button marketplace-button marketplace-primary" data-testid="marketplace-use"
        data-pack={id} disabled={pending !== null} aria-label={'Use ' + name + ' in Learn'}
        onClick={() => void update('use:' + id, () => packs.select(id), undefined, true)}>
        {pending === 'use:' + id ? 'Opening…' : 'Use in Learn'}
      </button>}
      {inDetails && installed && <button type="button" className="button marketplace-button" data-testid="marketplace-export"
        data-pack={id} disabled={pending !== null} onClick={() => void exportPack(pack)}>Export</button>}
      {manageInstalled && <button type="button" className="icon-button marketplace-remove" data-testid="marketplace-remove" data-pack={id}
        title={'Remove ' + name} aria-label={'Remove ' + name} disabled={pending !== null}
        onClick={() => void update('remove:' + id, () => packs.remove(id), name + ' removed.')}>
        <Icon name="trash" size={13}/>
      </button>}
    </div>
  }

  function packRow(item: CatalogItem, position: number, count: number) {
    const { pack, installed, canUpdate, recent } = item
    const { id, name, summary } = pack
    return <li className="marketplace-pack" key={id} data-testid="marketplace-pack" data-pack={id}
      aria-posinset={position} aria-setsize={count}>
      <div className="marketplace-pack-title">
        <h4><button type="button" className="marketplace-pack-link" data-testid="marketplace-details" data-pack={id}
          ref={(button) => {
            const restore = returnFocus.current
            if (button && !button.disabled && restore && restore !== 'import' && restore.packId === id) {
              button.focus({ preventScroll: true })
              returnFocus.current = null
            }
          }}
          aria-label={'View ' + name + ' details'} title={name} disabled={pending !== null}
          onClick={() => void openDetails(id)}><span>{name}</span><Icon name="chevron" size={11}/></button></h4>
        <span className={installed ? 'marketplace-current' : 'marketplace-available'}>
          {library?.selected === id ? 'In use' : canUpdate ? 'Update available' : installed ? 'Installed' : 'Bundled'}
        </span>
      </div>
      <p className="marketplace-pack-summary">{summary}</p>
      <p className="marketplace-pack-size">
        {[lessonCount(pack), packSize(pack), recent === undefined ? null : 'Recent'].filter(Boolean).join(' · ')}
      </p>
      {packActions(item)}
    </li>
  }

  const detailItem = details ? items.find(({ pack }) => pack.id === details.pack.id) : undefined
  return <aside className="learning-pane marketplace-pane" aria-label="Marketplace" data-testid="marketplace-pane">
    <header className="pane-title">
      <h2><Icon name="marketplace" size={14}/> Marketplace</h2>
      <button type="button" className="icon-button" aria-label="Hide Marketplace" onClick={onClose}><Icon name="x" size={15}/></button>
    </header>
    {!details && !preview && <div className="marketplace-controls">
      <div className="marketplace-search-row">
        <label className="marketplace-search">
          <Icon name="search" size={15}/>
          <input ref={search} type="search" placeholder="Search languages or topics" aria-label="Find a language pack"
            data-testid="marketplace-search" value={query} onChange={(event) => { resetList(); setQuery(event.currentTarget.value) }}/>
        </label>
        <button ref={importButton} type="button" className="button marketplace-button" data-testid="marketplace-import"
          disabled={!library || pending !== null} title="Review a local JSON learning pack" onClick={() => void importPack()}>
          <Icon name="open" size={13}/>{pending === 'import' ? 'Opening…' : 'Import pack'}
        </button>
      </div>
      <div className="marketplace-filters">
        <select aria-label="Category" data-testid="marketplace-category" value={category}
          onChange={(event) => { resetList(); setCategory(event.currentTarget.value as PackCategory | '') }}>
          <option value="">All categories</option>
          {packCategories.map((tag) => <option key={tag} value={tag}>{categoryNames[tag]}</option>)}
        </select>
        <select aria-label="Difficulty" data-testid="marketplace-difficulty" value={difficulty}
          onChange={(event) => { resetList(); setDifficulty(event.currentTarget.value as PackDifficulty | '') }}>
          <option value="">All levels</option>
          {packDifficulties.map((level) => <option key={level} value={level}>{difficultyNames[level]}</option>)}
        </select>
      </div>
      <div className="marketplace-filter-bottom">
        <label className="marketplace-installed">
          <input type="checkbox" data-testid="marketplace-installed-only" checked={installedOnly}
            onChange={(event) => { resetList(); setInstalledOnly(event.currentTarget.checked) }}/>
          Installed only
        </label>
        <select aria-label="Sort packs" data-testid="marketplace-sort" value={sort}
          onChange={(event) => { resetList(); setSort(event.currentTarget.value as Sort) }}>
          <option value="catalog">Catalog</option>
          <option value="name">A–Z</option>
          <option value="recent">Recent</option>
          <option value="lessons">Lessons</option>
        </select>
        <div className="marketplace-views" role="group" aria-label="Pack view">
          <button type="button" data-testid="marketplace-view-list" aria-pressed={view === 'list'}
            onClick={() => { resetList(); setView('list') }}>List</button>
          <button type="button" data-testid="marketplace-view-cards" aria-pressed={view === 'cards'}
            onClick={() => { resetList(); setView('cards') }}>Cards</button>
        </div>
      </div>
    </div>}
    {notice && <p className={notice.error ? 'marketplace-notice learning-error' : 'marketplace-notice'}
      role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {preview ? <div className="marketplace-scroll marketplace-detail" data-testid="marketplace-import-preview">
      <button ref={detailBack} type="button" className="button marketplace-button" disabled={pending !== null}
        onClick={() => cancelPreview(preview)}>Cancel import</button>
      <p className="marketplace-kicker">{preview.update ? 'Review pack update' : 'Review local import'}</p>
      <h3>{preview.details.pack.name}</h3>
      <p className="marketplace-detail-summary">
        {preview.update ? 'This update keeps the existing lesson history.' : 'Review the pack details before adding it to your library.'}
      </p>
      <button type="button" className="button marketplace-button marketplace-primary" data-testid="marketplace-import-confirm"
        disabled={pending !== null} onClick={() => void update('confirm-import', async () => {
          const next = await packs.confirmImport(preview.token)
          previewToken.current = null
          return next
        }, preview.details.pack.name + (preview.update ? ' updated.' : ' imported.'))}>
        {pending === 'confirm-import' ? 'Saving…' : preview.update ? 'Confirm update' : 'Install pack'}
      </button>
      <DetailContents details={preview.details} onReference={openReference}/>
    </div> : details && detailItem ? <div className="marketplace-scroll marketplace-detail" data-testid="marketplace-detail">
      <button ref={detailBack} type="button" className="button marketplace-button" onClick={() => setDetails(null)}>Back to packs</button>
      <p className="marketplace-kicker">{detailItem.installed ? 'Installed pack' : 'Bundled pack'}</p>
      <h3>{details.pack.name}</h3>
      {packActions(detailItem, true)}
      <DetailContents details={details} onReference={openReference}/>
    </div> : !library ? <div className="marketplace-scroll">
      {loadError ? <><p className="learning-error" role="alert">{loadError}</p>
        {onRetry && <button type="button" className="button" onClick={onRetry}>Retry</button>}</>
        : <p className="learning-copy" role="status">Opening Marketplace…</p>}
    </div> : filtered.length ? <PackList items={filtered} view={view} viewport={listViewport} offset={listOffset} renderPack={packRow}/> :
      <div className="marketplace-scroll"><p className="learning-copy">
        {items.length ? 'No packs match these filters.' : 'No packs are available. Import a JSON learning pack to get started.'}
      </p></div>}
    <p className="marketplace-footer">
      {library && !details && !preview && <span>{filtered.length} {filtered.length === 1 ? 'pack' : 'packs'} · </span>}
      <Icon name="check" size={11}/> Learning material works offline
    </p>
  </aside>
}
