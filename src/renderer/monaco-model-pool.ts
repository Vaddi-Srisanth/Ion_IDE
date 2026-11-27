import { editor, Uri } from 'monaco-editor/editor/editor.api.js'
import type { Documents, Tab } from './documents'

interface PooledModel {
  model: editor.ITextModel
  listener: { dispose(): void }
  epoch: number
  users: Set<string>
}

interface PendingModel {
  epoch: number
  promise: Promise<PooledModel | null>
}

const retainedModelLimit = 3
const textOf = (model: editor.ITextModel) => model.getValue(undefined, true)

function discardModel(model: editor.ITextModel) {
  if (model.canUndo() || model.canRedo()) model.setValue('')
  model.dispose()
}

export class MonacoModelPool {
  private models = new Map<string, PooledModel>()
  private pending = new Map<string, PendingModel>()
  private detach = new Set<(id: string) => void>()
  private disposed = false

  constructor(private readonly documents: Documents, private tabSize: number) {
    documents.attachModels({
      getText: (id) => this.models.has(id) ? textOf(this.models.get(id)!.model) : undefined,
      getTextPrefix: (id, length) => {
        const model = this.models.get(id)?.model
        if (!model) return
        if (model.getValueLength() <= length) return model.getValue()
        const end = model.getPositionAt(length)
        return model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column })
      },
      drop: (id) => this.drop(id),
    })
  }

  register(detach: (id: string) => void) {
    this.detach.add(detach)
    return () => this.detach.delete(detach)
  }

  get(id: string) { return this.models.get(id)?.model }

  async acquire(tab: Tab, language: string, owner: string): Promise<editor.ITextModel | null> {
    if (this.disposed) return null
    let pooled = this.models.get(tab.id)
    if (pooled && pooled.epoch !== tab.epoch) {
      this.drop(tab.id)
      pooled = undefined
    }
    if (!pooled) {
      const existing = this.pending.get(tab.id)
      const pending = existing?.epoch === tab.epoch ? existing.promise : this.create(tab, language)
      if (!existing || existing.epoch !== tab.epoch) this.pending.set(tab.id, { epoch: tab.epoch, promise: pending })
      pooled = await pending ?? undefined
      if (!pooled || this.disposed) return null
    }
    if (pooled.model.getLanguageId() !== language) editor.setModelLanguage(pooled.model, language)
    pooled.users.add(owner)
    this.touch(tab.id, pooled)
    return pooled.model
  }

  release(id: string, owner: string) {
    const pooled = this.models.get(id)
    if (!pooled) return
    pooled.users.delete(owner)
    this.trim()
  }

  updateTabSize(tabSize: number) {
    this.tabSize = tabSize
    for (const { model } of this.models.values()) model.updateOptions({ tabSize, insertSpaces: true })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.documents.attachModels(null)
    for (const id of [...this.models.keys()]) this.drop(id)
    this.pending.clear()
    this.detach.clear()
  }

  private create(tab: Tab, language: string): Promise<PooledModel | null> {
    const { id, epoch } = tab
    const promise = this.documents.loadText(id).then((value) => {
      if (this.disposed || !this.documents.getSnapshot().tabs.some((entry) => entry.id === id && entry.epoch === epoch)) return null
      const current = this.models.get(id)
      if (current?.epoch === epoch) return current
      if (current) this.drop(id)
      const uri = Uri.file(`/ion/editor/${id}/${epoch}`)
      const existing = editor.getModel(uri)
      if (existing) discardModel(existing)
      const model = editor.createModel(value, language, uri)
      model.updateOptions({ tabSize: this.tabSize, insertSpaces: true })
      const pooled: PooledModel = { model, epoch, users: new Set(), listener: model.onDidChangeContent(() => this.documents.changed(id)) }
      this.models.set(id, pooled)
      this.documents.modelReady(id)
      this.trim()
      return pooled
    }).catch(() => null).finally(() => {
      if (this.pending.get(id)?.promise === promise) this.pending.delete(id)
    })
    return promise
  }

  private touch(id: string, pooled: PooledModel) {
    this.models.delete(id)
    this.models.set(id, pooled)
  }

  private trim() {
    const retained = [...this.models].filter(([, model]) => model.users.size === 0)
    while (retained.length > retainedModelLimit) {
      const [id] = retained.shift()!
      this.drop(id)
    }
  }

  private drop(id: string) {
    const pooled = this.models.get(id)
    if (!pooled) return
    for (const detach of this.detach) detach(id)
    pooled.listener.dispose()
    const forgetUndo = pooled.model.canUndo() || pooled.model.canRedo() ? () => {
      const uri = pooled.model.uri
      const detached = editor.getModel(uri)
      if (detached) discardModel(detached)
      else discardModel(editor.createModel('', 'plaintext', uri))
    } : undefined
    this.documents.releaseModel(id, () => textOf(pooled.model), forgetUndo)
    pooled.model.dispose()
    this.models.delete(id)
  }
}
