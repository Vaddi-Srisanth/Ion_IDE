import type { EditorSessionSnapshot } from '../shared/editor-session';
import type { Documents } from './documents';

const checkpointDelay = 300;

export function captureEditorSession(documents: Documents, rootPath: string | null): EditorSessionSnapshot {
  const { tabs, activeId } = documents.getSnapshot();
  const saved: EditorSessionSnapshot['tabs'] = [];
  let activeIndex = -1;
  for (const { id, path, name, dirty, notebookMode } of tabs) {
    const draftId = dirty ? documents.recoveryId(id) : undefined;
    if (dirty && !path && !draftId) continue;
    if (id === activeId) activeIndex = saved.length;
    saved.push({ path, name, draftId, view: documents.getEditorView(id), notebookMode });
  }
  return {
    rootPath,
    activeIndex,
    tabs: saved,
  };
}

export class EditorSessionWriter {
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private changed = false;
  private warned = false;

  constructor(private readonly save: () => Promise<void>, private readonly onError: (error: unknown) => void) {}

  schedule() {
    this.changed = true;
    if (this.timer || this.writing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.write().catch((error: unknown) => this.report(error));
    }, checkpointDelay);
  }

  private report(error: unknown) {
    if (!this.warned) this.onError(error);
    this.warned = true;
  }

  private write(): Promise<void> {
    this.changed = false;
    const operation = this.save().then(() => {
      this.warned = false;
    }).finally(() => {
      this.writing = undefined;
      if (this.changed) this.schedule();
    });
    this.writing = operation;
    return operation;
  }

  async flush(required = false) {
    this.cancel();
    await this.writing?.catch(() => undefined);
    this.cancel();
    try {
      await this.write();
    } catch (error) {
      if (required) throw error;
      this.report(error);
    }
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.changed = false;
  }
}
