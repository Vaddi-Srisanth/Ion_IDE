import { AbortException, getDocument, PDFDataRangeTransport, PDFWorker, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PagedViewerSession } from '../../shared/viewers';

const chunkSize = 64 * 1024;
const ipcLimit = 256 * 1024;
const rangeLimit = 4 * 1024 * 1024;
const maxPages = 2000;

class LocalPdfRanges extends PDFDataRangeTransport {
  private closed = false;
  private pending = Promise.resolve();

  constructor(private readonly session: PagedViewerSession, initial: Uint8Array, private readonly fail: (reason: unknown) => void) {
    super(session.byteLength, initial, true);
  }

  override requestDataRange(begin: number, end: number) {
    if (this.closed) return;
    // Adjacent pages can request data together. Keep their reads below the
    // main-process concurrency ceiling without prefetching unused ranges.
    this.pending = this.pending.then(() => {
      if (!this.closed) return this.read(begin, end);
    }).catch(this.fail);
  }

  override abort() { this.closed = true; }

  private async read(begin: number, end: number) {
    const size = end - begin;
    if (size < 1 || size > rangeLimit || begin < 0 || end > this.session.byteLength) {
      throw new Error('This document exceeds the PDF preview’s byte-range limit.');
    }
    if (size <= ipcLimit) {
      const chunk = await window.ion.viewers.readPdf(this.session.id, begin, size);
      if (!this.closed) this.onDataRange(begin, chunk);
      return;
    }
    const range = new Uint8Array(size);
    for (let offset = begin; offset < end && !this.closed; offset += ipcLimit) {
      const chunk = await window.ion.viewers.readPdf(this.session.id, offset, Math.min(ipcLimit, end - offset));
      range.set(chunk, offset - begin);
    }
    if (!this.closed) this.onDataRange(begin, range);
  }
}

export interface LoadedPdf {
  pdf: PDFDocumentProxy;
  firstPage: PDFPageProxy;
}

export function loadLocalPdf(session: PagedViewerSession, onError: (reason: unknown) => void) {
  let disposed = false;
  let rawWorker: Worker | undefined;
  let worker: PDFWorker | undefined;
  let transport: LocalPdfRanges | undefined;
  let task: PDFDocumentLoadingTask | undefined;
  let loadTimeout = 0;

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(loadTimeout);
    transport?.abort();
    const stopWorker = () => {
      worker?.destroy();
      rawWorker?.terminate();
    };
    if (!task) {
      stopWorker();
      return;
    }
    // Give the parser a chance to release the font loader, pages and message
    // handlers. A stuck or corrupt document cannot keep the worker alive.
    const deadline = window.setTimeout(stopWorker, 500);
    void task.destroy().catch(() => {}).finally(() => {
      clearTimeout(deadline);
      stopWorker();
    });
  }

  function fail(reason: unknown) {
    if (disposed) return;
    dispose();
    onError(reason);
  }

  const ready = (async (): Promise<LoadedPdf | null> => {
    loadTimeout = window.setTimeout(() => fail(new Error('Document preview timed out.')), 20_000);
    const initial = await window.ion.viewers.readPdf(session.id, 0, Math.min(session.byteLength, chunkSize));
    if (disposed) return null;
    rawWorker = new Worker(workerUrl, { type: 'module', name: 'Ion PDF parser' });
    rawWorker.addEventListener('error', () => fail(new Error('Unable to start the local PDF parser.')), { once: true });
    worker = PDFWorker.create({ port: rawWorker });
    const readAll = initial.byteLength === session.byteLength;
    if (!readAll) transport = new LocalPdfRanges(session, initial, fail);
    const assetRoot = new URL('./pdf-assets/', document.baseURI);
    task = getDocument({
      ...(readAll ? { data: initial } : { range: transport }),
      worker,
      rangeChunkSize: chunkSize,
      disableAutoFetch: true,
      disableStream: true,
      disableWorkerRendering: true,
      enableXfa: false,
      enableHWA: false,
      useWasm: false,
      useWorkerFetch: false,
      maxImageSize: 12_000_000,
      canvasMaxAreaInBytes: 24 * 1024 * 1024,
      cMapUrl: new URL('cmaps/', assetRoot).href,
      standardFontDataUrl: new URL('standard_fonts/', assetRoot).href,
      wasmUrl: new URL('wasm/', assetRoot).href,
    });
    task.onPassword = () => fail(new Error('Password-protected PDFs can be opened in your default application.'));
    const pdf = await task.promise;
    if (disposed) return null;
    if (pdf.numPages < 1 || pdf.numPages > maxPages) throw new Error(`Preview supports up to ${maxPages.toLocaleString()} pages.`);
    const firstPage = await pdf.getPage(1);
    if (disposed) return null;
    clearTimeout(loadTimeout);
    return { pdf, firstPage };
  })().catch((reason: unknown) => {
    fail(reason);
    return null;
  });

  return { ready, dispose, fail };
}

export function pdfErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(reason);
}

function normalized(text: string) { return text.toLowerCase().replace(/\s+/g, ' '); }

export async function pageContains(pdf: PDFDocumentProxy, number: number, query: string, signal: AbortSignal) {
  const page = await pdf.getPage(number);
  if (signal.aborted) return false;
  const reader = page.streamTextContent().getReader();
  let finished = false;
  const cancel = () => {
    if (finished) return;
    finished = true;
    // PDF.js requires an Error to mark the worker-side stream cancelled.
    void reader.cancel(new AbortException('PDF text search ended.')).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let tail = '';
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        return false;
      }
      const text = normalized(tail + chunk.value.items.map((item: { str?: string; hasEOL?: boolean }) =>
        (item.str ?? '') + (item.hasEOL ? ' ' : '')).join(''));
      if (text.includes(query)) return true;
      tail = text.slice(-query.length);
    }
    return false;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    page.cleanup();
  }
}

export function normalizePdfQuery(text: string) { return normalized(text).trim(); }
