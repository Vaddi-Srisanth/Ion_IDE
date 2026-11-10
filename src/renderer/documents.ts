import type { Entry, IonBridge, RecoveryDraft, Settings } from '../shared/contracts';
import type { EditorViewState } from '../shared/editor-session';
import { documentFormat, type DocumentFormat } from '../shared/viewers';
import { isNotebookName } from '../shared/notebook-path';
import { isWithin } from './paths';

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  dirty: boolean;
  conflict: boolean;
  error: string | null;
  epoch: number;
  viewer?: DocumentFormat;
  notebookMode?: 'notebook' | 'json';
  notebookRunning?: boolean;
  recoveredFrom?: string;
}

interface DraftState {
  metadata: RecoveryDraft;
  timer?: ReturnType<typeof setTimeout>;
  writing?: Promise<void>;
  changed: boolean;
  checkpointed?: boolean;
  warned?: boolean;
}

interface DraftCursor {
  line: number;
  column: number;
}

export interface InitialDraft {
  name?: string;
  text: string;
  cursor?: DraftCursor;
}

interface RecordState {
  tab: Tab;
  revision: string | null;
  baseHash?: string;
  version: number;
  stagedText?: string;
  initialCursor?: DraftCursor;
  editorView?: EditorViewState;
  forgetUndo?: () => void;
  load?: Promise<string>;
  save?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
  autoSaveBlocked: boolean;
  formatHoldsSave?: boolean;
  draft?: DraftState;
}

export interface ModelAccess {
  getText(id: string): string | undefined;
  getTextPrefix?(id: string, length: number): string | undefined;
  drop(id: string): void;
}

export interface DocumentsSnapshot {
  tabs: Tab[];
  activeId: string | null;
}

const TAB_LIMIT = 64;
const RECOVERY_INTERVAL = 350;

export function errorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export class Documents {
  private records = new Map<string, RecordState>();
  private modelAccess: ModelAccess | null = null;
  private readonly notebookAccess = new Map<string, () => string>();
  private activeId: string | null = null;
  private sequence = 0;
  private draftSequence = 0;
  private snapshot: DocumentsSnapshot = { tabs: [], activeId: null };
  private subscribers = new Set<() => void>();
  private editorViewSubscribers = new Set<() => void>();
  private textSubscribers = new Map<string, Set<() => void>>();
  private removingDrafts = new Set<Promise<void>>();

  constructor(
    private readonly bridge: IonBridge,
    private settings: Settings,
    private readonly notify: (message: string, error?: boolean) => void,
    private readonly saved: (entry: Entry) => void,
  ) {}

  subscribe = (listener: () => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  getEditorView = (id: string): EditorViewState | undefined => this.records.get(id)?.editorView;

  setEditorView = (id: string, view: EditorViewState) => {
    const record = this.records.get(id);
    if (!record) return;
    const previous = record.editorView;
    if (previous?.scrollTop === view.scrollTop && previous.scrollLeft === view.scrollLeft
      && previous.selections.length === view.selections.length && previous.selections.every((selection, index) => {
        const next = view.selections[index];
        return selection.selectionStartLineNumber === next.selectionStartLineNumber
          && selection.selectionStartColumn === next.selectionStartColumn
          && selection.positionLineNumber === next.positionLineNumber
          && selection.positionColumn === next.positionColumn;
      })) return;
    record.editorView = view;
    this.editorViewSubscribers.forEach((listener) => listener());
  };

  subscribeEditorView = (listener: () => void) => {
    this.editorViewSubscribers.add(listener);
    return () => { this.editorViewSubscribers.delete(listener); };
  };

  recoveryId = (id: string) => this.records.get(id)?.draft?.metadata.id;

  subscribeText(id: string, listener: () => void): () => void {
    const listeners = this.textSubscribers.get(id) ?? new Set<() => void>();
    this.textSubscribers.set(id, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.textSubscribers.get(id) === listeners) this.textSubscribers.delete(id);
    };
  }

  savedRevision(id: string): string | undefined {
    return this.records.get(id)?.revision ?? undefined;
  }

  async holdAutosaveForFormat(id: string) {
    const record = this.records.get(id);
    if (!record) return () => {};
    record.formatHoldsSave = true;
    this.cancelTimer(record);
    await record.save?.catch(() => false);
    return () => {
      record.formatHoldsSave = false;
      if (this.records.get(id) === record) this.schedule(record);
    };
  }

  markConflict(id: string, path: string) {
    const record = this.records.get(id);
    if (!record || record.tab.path !== path || record.tab.conflict) return;
    this.cancelTimer(record);
    record.autoSaveBlocked = true;
    this.patch(record, { conflict: true });
  }

  private publish() {
    this.snapshot = { tabs: Array.from(this.records.values(), (record) => record.tab), activeId: this.activeId };
    this.subscribers.forEach((listener) => listener());
  }

  private patch(record: RecordState, patch: Partial<Tab>) {
    record.tab = { ...record.tab, ...patch };
    this.publish();
  }

  setSettings(settings: Settings) {
    const changed = this.settings.autoSave !== settings.autoSave || this.settings.autoSaveDelay !== settings.autoSaveDelay;
    this.settings = settings;
    if (changed) this.records.forEach((record) => this.schedule(record));
  }

  attachModels(access: ModelAccess | null) {
    this.modelAccess = access;
  }

  connectNotebook = (id: string, getText: () => string) => {
    this.notebookAccess.set(id, getText);
    this.modelReady(id);
    return () => {
      if (this.notebookAccess.get(id) !== getText) return;
      this.releaseModel(id, getText);
      this.notebookAccess.delete(id);
    };
  };

  private bufferText(id: string): string | undefined {
    return this.notebookAccess.get(id)?.() ?? this.modelAccess?.getText(id);
  }

  setNotebookRunning = (id: string, running: boolean) => {
    const record = this.records.get(id);
    if (record?.tab.notebookMode === 'notebook' && Boolean(record.tab.notebookRunning) !== running) {
      this.patch(record, { notebookRunning: running });
    }
  };

  private releaseKernel(path: string | null, keep = false) {
    if (!path || !isNotebookName(path)) return;
    void this.bridge.notebooks.release(path, keep).catch((reason: unknown) => {
      this.notify(`Could not release the notebook kernel. ${errorMessage(reason)}`, true);
    });
  }

  select = (id: string) => {
    if (this.activeId !== id && this.records.has(id)) {
      this.activeId = id;
      this.publish();
    }
  };

  open = (entry?: Entry, draft?: InitialDraft) => {
    if (entry) {
      const existing = Array.from(this.records.values()).find(({ tab }) => tab.path === entry.path);
      if (existing) {
        this.select(existing.tab.id);
        return existing.tab.id;
      }
    }
    if (this.records.size >= TAB_LIMIT) {
      this.notify(`Close a tab before opening another file. Ion supports ${TAB_LIMIT} open tabs.`, true);
      return null;
    }
    const id = String(++this.sequence);
    const initial = entry ? undefined : draft;
    const namedUntitled = initial?.name && /^Untitled-(\d{1,8})\.c$/.exec(initial.name);
    if (namedUntitled) this.draftSequence = Math.max(this.draftSequence, Number(namedUntitled[1]));
    const tab: Tab = {
      id, path: entry?.path ?? null, name: entry?.name ?? initial?.name ?? `Untitled-${++this.draftSequence}.c`,
      dirty: false, conflict: false, error: null, epoch: 0,
      viewer: entry && documentFormat(entry.name),
      notebookMode: entry && isNotebookName(entry.name) ? 'notebook' : undefined,
    };
    this.records.set(id, { tab, revision: null, version: 0, autoSaveBlocked: false,
      stagedText: initial?.text, initialCursor: initial?.cursor });
    this.activeId = id;
    if (initial?.text) this.changed(id);
    else this.publish();
    return id;
  };

  takeInitialCursor(id: string): DraftCursor | undefined {
    const record = this.records.get(id);
    if (!record) return;
    const cursor = record.initialCursor;
    record.initialCursor = undefined;
    return cursor;
  }

  requestPosition(id: string, line: number, column: number) {
    const record = this.records.get(id);
    if (record) record.initialCursor = { line, column };
  }

  restoreDrafts(drafts: RecoveryDraft[]) {
    const restored: string[] = [];
    for (const metadata of drafts) {
      if (this.records.size >= TAB_LIMIT) break;
      const untitled = !metadata.originalPath && /^Untitled-(\d{1,8})\.c$/.exec(metadata.name);
      if (untitled) this.draftSequence = Math.max(this.draftSequence, Number(untitled[1]));
      const id = String(++this.sequence);
      this.records.set(id, {
        tab: { id, path: null, name: metadata.name, dirty: true, conflict: false, error: null, epoch: 0,
          recoveredFrom: metadata.originalPath, notebookMode: isNotebookName(metadata.name) ? 'notebook' : undefined },
        revision: null, version: 0, autoSaveBlocked: false, draft: { metadata, changed: false, checkpointed: true },
      });
      this.activeId = id;
      restored.push(metadata.id);
    }
    if (restored.length) this.publish();
    return restored;
  }

  loadText = async (id: string): Promise<string> => {
    const record = this.records.get(id);
    if (!record) return '';
    if (record.tab.viewer) throw new Error('This document is read-only in Ion.');
    const modelText = this.bufferText(id);
    if (modelText !== undefined) return modelText;
    if (record.stagedText !== undefined) return record.stagedText;
    const { path, epoch } = record.tab;
    if (record.load) return record.load;
    const recovered = record.draft?.metadata.id;
    const source: Promise<{ text: string; revision: string | null; contentHash?: string }> | null =
      path ? this.bridge.readFile(path, record.tab.notebookMode === 'notebook' ? 'notebook' : undefined)
      : recovered ? this.bridge.recovery.read(recovered).then((text) => ({ text, revision: null })) : null;
    if (!source) return '';

    const current = () => this.records.has(id) && record.tab.path === path && record.tab.epoch === epoch;
    const pending = source.then(({ text, revision, contentHash }) => {
      if (current()) {
        record.revision = revision;
        record.baseHash = contentHash;
      }
      return text;
    }).catch((reason: unknown) => {
      if (current()) this.patch(record, { error: errorMessage(reason) });
      throw reason;
    });
    record.load = pending;
    try {
      return await pending;
    } finally {
      if (record.load === pending) record.load = undefined;
    }
  };

  async loadTextPrefix(id: string, length: number): Promise<string> {
    return this.modelAccess?.getTextPrefix?.(id, length) ?? (await this.loadText(id)).slice(0, length);
  }

  modelReady = (id: string) => {
    const record = this.records.get(id);
    if (!record) return;
    record.stagedText = undefined;
    record.forgetUndo = undefined;
    if (record.tab.error) this.patch(record, { error: null });
  };

  setNotebookMode = (id: string, notebookMode: 'notebook' | 'json') => {
    const record = this.records.get(id);
    if (!record?.tab.notebookMode || record.tab.notebookMode === notebookMode) return;
    if (record.tab.notebookRunning) return;
    const text = record.tab.dirty ? this.bufferText(id) : undefined;
    if (text !== undefined) this.releaseModel(id, () => text);
    this.notebookAccess.delete(id);
    this.dropModel(record);
    record.load = undefined;
    this.patch(record, { notebookMode, error: null, epoch: record.tab.epoch + 1 });
  };

  releaseModel = (id: string, text: () => string, forgetUndo?: () => void) => {
    const record = this.records.get(id);
    if (record?.tab.dirty) record.stagedText = text();
    if (record && forgetUndo) record.forgetUndo = forgetUndo;
  };

  private dropModel(record: RecordState) {
    this.modelAccess?.drop(record.tab.id);
    const forgetUndo = record.forgetUndo;
    record.forgetUndo = undefined;
    forgetUndo?.();
  }

  changed = (id: string) => {
    const record = this.records.get(id);
    if (!record || record.tab.viewer) return;
    record.version++;
    this.textSubscribers.get(id)?.forEach((listener) => listener());
    if (!record.tab.dirty) this.patch(record, { dirty: true });
    record.draft ??= { metadata: {
      id: crypto.randomUUID(), name: record.tab.name, originalPath: record.tab.path ?? undefined,
    }, changed: false };
    this.scheduleRecovery(record);
    this.schedule(record);
  };

  private scheduleRecovery(record: RecordState) {
    const draft = record.draft;
    if (!draft) return;
    draft.changed = true;
    // Throttle from the first unsnapshotted edit, so continuous typing still
    // produces recovery checkpoints. Allow one snapshot in flight per draft.
    if (draft.timer || draft.writing) return;
    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      const text = this.bufferText(record.tab.id) ?? record.stagedText;
      if (text === undefined) return;
      void this.writeRecovery(record, draft, text).catch((reason: unknown) => {
        if (!draft.warned) this.notify(`Could not checkpoint ${record.tab.name}. ${errorMessage(reason)}`, true);
        draft.warned = true;
      }).finally(() => {
        if (record.draft === draft && draft.changed) this.scheduleRecovery(record);
      });
    }, RECOVERY_INTERVAL);
  }

  private writeRecovery(record: RecordState, draft: DraftState, text: string): Promise<void> {
    draft.changed = false;
    draft.metadata = { ...draft.metadata, name: record.tab.name,
      originalPath: record.tab.path ?? draft.metadata.originalPath };
    const writing = this.bridge.recovery.write({ ...draft.metadata, text }).then(() => {
      draft.checkpointed = true;
      draft.warned = false;
    }).finally(() => {
      draft.writing = undefined;
    });
    draft.writing = writing;
    return writing;
  }

  checkpointDrafts = async () => {
    const records = [...this.records.values()];
    if (records.some(({ tab }) => tab.notebookRunning)) throw new Error('Stop notebook execution before keeping drafts.');
    records.forEach((record) => this.cancelTimer(record));
    try {
      for (const record of records) {
        await record.save;
        this.cancelTimer(record);
        if (!record.tab.dirty) continue;
        const draft = record.draft;
        if (!draft) throw new Error(`The unsaved copy of ${record.tab.name} is unavailable.`);
        clearTimeout(draft.timer);
        draft.timer = undefined;
        await draft.writing?.catch(() => undefined);
        clearTimeout(draft.timer);
        draft.timer = undefined;
        const text = this.bufferText(record.tab.id) ?? record.stagedText;
        if (text !== undefined) await this.writeRecovery(record, draft, text);
        else if (!draft.checkpointed || draft.changed) throw new Error(`The unsaved copy of ${record.tab.name} is unavailable.`);
      }
      await Promise.all(this.removingDrafts);
      return () => { records.forEach((record) => this.schedule(record)); };
    } catch (reason) {
      for (const record of records) {
        if (record.tab.dirty) this.scheduleRecovery(record);
        this.schedule(record);
      }
      throw reason;
    }
  };

  private async removeRecoveries(records: RecordState[]) {
    const drafts = records.flatMap((record) => {
      const draft = record.draft;
      if (!draft) return [];
      clearTimeout(draft.timer);
      draft.timer = undefined;
      record.draft = undefined;
      return [{ record, draft }];
    });
    if (!drafts.length) return;
    await Promise.all(drafts.map(({ draft }) => draft.writing?.catch(() => undefined)));
    try {
      await this.bridge.recovery.remove(drafts.map(({ draft }) => draft.metadata.id));
    } catch (reason) {
      for (const { record, draft } of drafts) {
        if (record.tab.dirty && !record.draft) {
          record.draft = draft;
          if (draft.changed) this.scheduleRecovery(record);
        }
      }
      throw reason;
    }
  }

  private forgetSavedRecovery(record: RecordState) {
    if (!record.draft) return;
    const pending = this.removeRecoveries([record])
      .catch((reason: unknown) => this.notify(`Could not clear a recovery copy. ${errorMessage(reason)}`, true))
      .finally(() => { this.removingDrafts.delete(pending); });
    this.removingDrafts.add(pending);
  }

  discard = async (id: string) => {
    const record = this.records.get(id);
    if (!record) return;
    await record.save;
    this.cancelTimer(record);
    try {
      await this.removeRecoveries([record]);
    } catch (reason) {
      this.schedule(record);
      throw reason;
    }
    this.close(id);
  };

  finishWindowClose = async (discard: boolean) => {
    if (discard) {
      const records = [...this.records.values()];
      await Promise.all(records.map((record) => record.save));
      records.forEach((record) => this.cancelTimer(record));
      try {
        await this.removeRecoveries(records);
      } catch (reason) {
        records.forEach((record) => this.schedule(record));
        throw reason;
      }
    }
    await Promise.all(this.removingDrafts);
  };

  private cancelTimer(record: RecordState) {
    clearTimeout(record.timer);
    record.timer = undefined;
  }

  private schedule(record: RecordState) {
    this.cancelTimer(record);
    if (!this.settings.autoSave || !record.tab.dirty || !record.tab.path || record.autoSaveBlocked || record.formatHoldsSave || record.save) return;
    record.timer = setTimeout(() => {
      record.timer = undefined;
      void this.save(record.tab.id, 'auto');
    }, this.settings.autoSaveDelay);
  }

  save = async (id: string, mode: 'manual' | 'auto' | 'as' = 'manual'): Promise<boolean> => {
    const record = this.records.get(id);
    if (!record) return true;
    if (record.tab.viewer) return false;
    if (mode === 'as' && record.tab.notebookRunning) {
      this.notify('Finish or stop notebook execution before using Save As.', true);
      return false;
    }
    this.cancelTimer(record);
    if (record.save) {
      const succeeded = await record.save;
      if (mode !== 'as' && (!succeeded || !record.tab.dirty)) return succeeded;
      return this.save(id, mode);
    }
    if (mode !== 'as' && record.tab.path && !record.tab.dirty) return true;

    const pending = this.saveDocument(record, mode);
    record.save = pending;
    try {
      return await pending;
    } finally {
      record.save = undefined;
      this.schedule(record);
    }
  };

  private async saveDocument(record: RecordState, mode: 'manual' | 'auto' | 'as'): Promise<boolean> {
    const { id, path, name } = record.tab;
    const version = record.version;
    try {
      const text = await this.loadText(id);
      if (mode === 'as' || !path) {
        const entry = await this.bridge.saveFileAs(name, text, record.tab.notebookMode === 'notebook' ? 'notebook' : undefined);
        if (!entry) return false;
        const duplicate = Array.from(this.records.values()).find(({ tab }) => tab.id !== id && tab.path === entry.path);
        if (duplicate?.tab.dirty) {
          this.detachPath(duplicate.tab.id);
          this.notify('The other tab’s edits are now in an unsaved draft.');
        } else if (duplicate) {
          this.close(duplicate.tab.id);
        }
        record.revision = entry.revision;
        record.baseHash = entry.contentHash;
        if (path !== entry.path) this.releaseKernel(path);
        this.patch(record, { path: entry.path, name: entry.name, dirty: record.version !== version, conflict: false, recoveredFrom: undefined,
          notebookMode: isNotebookName(entry.name) ? record.tab.notebookMode ?? 'json' : undefined });
        this.saved(entry);
      } else {
        if (record.revision === null) throw new Error('The file is still loading. Try saving it again.');
        const result = await this.bridge.saveFile(path, text, record.revision, record.baseHash);
        if (record.tab.path !== path) return false;
        record.revision = result.revision;
        record.baseHash = result.contentHash;
        this.patch(record, { dirty: record.version !== version, conflict: false });
      }
      record.autoSaveBlocked = false;
      if (!record.tab.dirty) {
        record.stagedText = undefined;
        this.forgetSavedRecovery(record);
      } else {
        this.scheduleRecovery(record);
      }
      if (mode !== 'auto') this.notify(`Saved ${record.tab.name}`);
      return true;
    } catch (reason) {
      if (record.tab.path !== path) return false;
      record.autoSaveBlocked = true;
      const message = errorMessage(reason);
      if (message.includes('FILE_CHANGED')) {
        this.patch(record, { conflict: true });
        this.notify(`${name} changed on disk. Use Save As to keep your edits.`, true);
      } else {
        this.notify(`Could not save ${name}. ${message}`, true);
      }
      return false;
    }
  }

  reload = async (id: string) => {
    const record = this.records.get(id);
    if (!record?.tab.path || record.tab.viewer || record.tab.notebookRunning) return false;
    this.cancelTimer(record);
    if (record.save) await record.save;
    const version = record.version;
    try {
      const { text, revision, contentHash } = await this.bridge.readFile(record.tab.path,
        record.tab.notebookMode === 'notebook' ? 'notebook' : undefined);
      if (!this.records.has(id) || record.version !== version) return false;
      this.notebookAccess.delete(id);
      this.releaseKernel(record.tab.path);
      this.dropModel(record);
      record.revision = revision;
      record.baseHash = contentHash;
      record.stagedText = text;
      record.autoSaveBlocked = false;
      this.patch(record, { dirty: false, conflict: false, error: null, epoch: record.tab.epoch + 1 });
      this.forgetSavedRecovery(record);
      return true;
    } catch (reason) {
      this.notify(errorMessage(reason), true);
      return false;
    }
  };

  close = (id: string) => {
    const record = this.records.get(id);
    if (!record) return;
    const ids = Array.from(this.records.keys());
    this.cancelTimer(record);
    this.textSubscribers.delete(id);
    this.notebookAccess.delete(id);
    this.releaseKernel(record.tab.path, this.settings.notebookKernelLifetime === 'window');
    this.dropModel(record);
    this.records.delete(id);
    if (this.activeId === id) {
      const index = ids.indexOf(id);
      this.activeId = ids[index + 1] ?? ids[index - 1] ?? null;
    }
    this.publish();
  };

  affected(path: string): Tab[] {
    return this.snapshot.tabs.filter((tab) => tab.path && isWithin(tab.path, path));
  }

  async settle(ids: readonly string[]) {
    await Promise.all(ids.map((id) => this.records.get(id)?.save));
  }

  detachPath(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    this.releaseKernel(record.tab.path);
    this.cancelTimer(record);
    record.revision = null;
    record.baseHash = undefined;
    record.load = undefined;
    record.autoSaveBlocked = false;
    this.patch(record, { path: null, conflict: false, error: null });
  }

  renamed(original: string, entry: Entry) {
    const affected = this.affected(original);
    for (const tab of affected) {
      if (!tab.path) continue;
      const record = this.records.get(tab.id);
      if (!record) continue;
      this.releaseKernel(tab.path);
      const path = entry.path + tab.path.slice(original.length);
      const name = original === tab.path ? entry.name : tab.name;
      this.cancelTimer(record);
      record.load = undefined;
      if (record.tab.dirty) {
        // Preserve edits and the old revision if an edit arrived during the rename.
        this.patch(record, { path, name });
        this.scheduleRecovery(record);
        this.schedule(record);
      } else {
        this.notebookAccess.delete(tab.id);
        this.dropModel(record);
        record.revision = null;
        record.baseHash = undefined;
        record.stagedText = undefined;
        this.patch(record, { path, name, viewer: documentFormat(name),
          notebookMode: isNotebookName(name) ? tab.notebookMode ?? 'notebook' : undefined,
          error: null, epoch: record.tab.epoch + 1 });
      }
    }
  }
}
