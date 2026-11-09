const lineBreakBatch = `        const linesContent = this.model.getLinesContent();
        const lineCount = linesContent.length;
        const lineBreaksComputer = this.createLineBreaksComputer();
        for (let i = 0; i < lineCount; i++) {
            lineBreaksComputer.addRequest(i + 1, previousLineBreaks ? previousLineBreaks[i] : null);
        }
        const linesBreaks = lineBreaksComputer.finalize();`

const boundedLineBreakBatch = `        const lineCount = this.model.getLineCount();
        let linesBreaks;
        // The simple break computer returns null for every line in this case.
        // Check the decoration tree once instead of reading every line and
        // searching the tree per line. Keep Monaco's wrapping and injection paths.
        if (this.wrappingColumn !== -1 || this.wrappingStrategy !== 'simple' || this.model.getInjectedTextDecorations(this._editorId).length > 0) {
            const lineBreaksComputer = this.createLineBreaksComputer();
            for (let i = 0; i < lineCount; i++) {
                lineBreaksComputer.addRequest(i + 1, previousLineBreaks ? previousLineBreaks[i] : null);
            }
            linesBreaks = lineBreaksComputer.finalize();
        }`

export function monacoViewMemory() {
  return {
    name: 'ion-monaco-view-memory',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!/[/\\]monaco-editor[/\\]esm[/\\]vs[/\\]editor[/\\]common[/\\]viewModel[/\\]viewModelLines\.js(?:\?.*)?$/.test(id)) return
      const patches = [
        [lineBreakBatch, boundedLineBreakBatch],
        ['const line = createModelLineProjection(linesBreaks[i], !isInHiddenArea);',
          'const line = createModelLineProjection(linesBreaks?.[i] ?? null, !isInHiddenArea);'],
      ]
      for (const [before, after] of patches) {
        const start = code.indexOf(before)
        if (start < 0 || start !== code.lastIndexOf(before)) {
          throw new Error(`Review Ion's view allocation patch for Monaco 0.57.0. Unexpected source in ${id}`)
        }
        code = code.slice(0, start) + after + code.slice(start + before.length)
      }
      return { code, map: null }
    },
  }
}
