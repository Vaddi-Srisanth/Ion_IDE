import type { Plugin } from 'vite'

const tokenizerPath = '/monaco-editor/esm/vs/editor/common/model/textModelTokens.js'

const upstreamScheduler = `        this._isDisposed = false;
        this._isScheduled = false;
    }
    dispose() {
        this._isDisposed = true;
    }
    handleChanges() {
        this._beginBackgroundTokenization();
    }
    _beginBackgroundTokenization() {
        if (this._isScheduled || !this._tokenizerWithStateStore._textModel.isAttachedToEditor() || !this._hasLinesToTokenize()) {
            return;
        }
        this._isScheduled = true;
        runWhenGlobalIdle((deadline) => {
            this._isScheduled = false;
            this._backgroundTokenizeWithDeadline(deadline);
        });
    }`

const deferredScheduler = `        this._isDisposed = false;
        this._attached = false;
        this._attachmentGeneration = 0;
        this._startTimer = undefined;
        this._idleWork = undefined;
    }
    dispose() {
        this._isDisposed = true;
        this._cancelPendingTokenization();
    }
    _cancelPendingTokenization() {
        ++this._attachmentGeneration;
        if (this._startTimer !== undefined) {
            clearTimeout(this._startTimer);
            this._startTimer = undefined;
        }
        this._idleWork?.dispose();
        this._idleWork = undefined;
    }
    handleChanges() {
        const model = this._tokenizerWithStateStore._textModel;
        if (this._isDisposed) {
            return;
        }
        if (!model.isAttachedToEditor()) {
            if (this._attached) {
                this._attached = false;
                this._cancelPendingTokenization();
            }
            return;
        }
        if (!this._attached) {
            this._attached = true;
            // Let short visits to large files render visible tokens without lexing all remaining lines.
            if (this._hasLinesToTokenize() && model.getValueLength() >= 1024 * 1024) {
                this._startTimer = setTimeout(() => {
                    this._startTimer = undefined;
                    this._beginBackgroundTokenization();
                }, 500);
            }
        }
        this._beginBackgroundTokenization();
    }
    _beginBackgroundTokenization() {
        if (this._isDisposed || this._startTimer !== undefined || this._idleWork
            || !this._tokenizerWithStateStore._textModel.isAttachedToEditor() || !this._hasLinesToTokenize()) {
            return;
        }
        this._idleWork = runWhenGlobalIdle((deadline) => {
            this._idleWork = undefined;
            this._backgroundTokenizeWithDeadline(deadline);
        });
    }`

const upstreamSlice = `        const endTime = Date.now() + deadline.timeRemaining();
        const execute = () => {
            if (this._isDisposed || !this._tokenizerWithStateStore._textModel.isAttachedToEditor() || !this._hasLinesToTokenize()) {`
const guardedSlice = `        const endTime = Date.now() + deadline.timeRemaining();
        const generation = this._attachmentGeneration;
        const execute = () => {
            if (generation !== this._attachmentGeneration || this._isDisposed
                || !this._tokenizerWithStateStore._textModel.isAttachedToEditor() || !this._hasLinesToTokenize()) {`

function replaceOnce(code: string, before: string, after: string): string {
  const start = code.indexOf(before)
  if (start === -1 || start !== code.lastIndexOf(before)) {
    throw new Error('Monaco background tokenization changed. Review the Ion scheduler patch for this version.')
  }
  return code.replace(before, after)
}

// Monaco 0.57 exposes no scheduling hook for its default background tokenizer.
// Leave its viewport and forced tokenization paths intact.
export function monacoTokenizationMemory(): Plugin {
  return {
    name: 'ion-monaco-tokenization-memory',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith(tokenizerPath)) return
      return replaceOnce(replaceOnce(code, upstreamScheduler, deferredScheduler), upstreamSlice, guardedSlice)
    },
  }
}
