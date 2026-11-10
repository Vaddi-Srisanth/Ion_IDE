import type { Plugin } from 'vite'

const bufferPath = '/monaco-editor/esm/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.js'

// Monaco's piece tree retains storage for deleted pieces. Whole-buffer format
// followed by undo can repeatedly append the same large source to that storage.
export function monacoFormatMemory(): Plugin {
  return {
    name: 'ion-monaco-format-memory',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith(bufferPath)) return
      const anchor = '    mightContainRTL() {\n'
      if (!code.includes(anchor) || !code.includes('this._pieceTree = new PieceTreeBase(chunks, eol, eolNormalized);')) {
        throw new Error('Monaco’s text buffer changed. Review the pinned formatting compaction.')
      }
      return { code: code.replace(anchor, `    ionCompactFormattedText(text) {
        const tree = this._pieceTree;
        if (tree.getLength() !== text.length) return;
        let retained = 0;
        for (const chunk of tree._buffers) retained += chunk.buffer.length;
        if (retained < Math.max(1024 * 1024, text.length * 4)) return;
        // Keep the buffer wrapper and the undo stack. Existing snapshots still
        // refer to the previous tree and can finish reading it.
        const replacement = new PieceTreeBase([], tree.getEOL(), true);
        replacement.insert(0, text, true);
        this._pieceTree = replacement;
    }
` + anchor), map: null }
    },
  }
}
