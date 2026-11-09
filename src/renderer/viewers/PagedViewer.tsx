import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { AnnotationMode, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import type { PagedViewerSession } from '../../shared/viewers';
import { Icon } from '../icons';
import { loadLocalPdf, normalizePdfQuery, pageContains, pdfErrorMessage, type LoadedPdf } from './pdf-session';
import './paged-viewer.css';

type Size = { width: number; height: number };
type Frame = Size & { top: number };
type Zoom = number | 'width' | 'window';
const gutter = 18;
const thumbnailHeight = 82;
const maxCanvasArea = 4_000_000;
const maxCanvasSide = 4096;
const minZoom = 0.2;
const maxZoom = 3;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function shapeOf(page: PDFPageProxy): Size {
  const { width, height } = page.getViewport({ scale: 1 });
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height) || width > 20_000 || height > 20_000) {
    throw new Error('This page exceeds the preview’s size limits.');
  }
  return { width, height };
}

function fitted(size: Size, view: Size, zoom: Zoom) {
  const limit = Math.min(maxZoom, 8192 / Math.max(size.width, size.height));
  if (typeof zoom === 'number') return Math.min(zoom, limit);
  const width = Math.max(1, view.width - 2 * gutter) / size.width;
  const height = Math.max(1, view.height - 2 * gutter) / size.height;
  return Math.min(limit, zoom === 'width' ? width : Math.min(width, height));
}

function useBox(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const resize = () => setSize((previous) => previous.width === node.clientWidth && previous.height === node.clientHeight
      ? previous : { width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function pageAt(frames: Frame[], scrollTop: number) {
  let start = 0;
  let end = frames.length - 1;
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (frames[middle].top <= scrollTop) start = middle;
    else end = middle - 1;
  }
  return start + 1;
}

function PageCanvas({ pdf, pageNumber, width, height, label, thumbnail, onShape, onTimeout }: {
  pdf: PDFDocumentProxy; pageNumber: number; width: number; height: number; label: string; thumbnail?: boolean;
  onShape?: (number: number, size: Size) => void; onTimeout?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [display, setDisplay] = useState('loading');
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 1 || height < 1) return;
    let current = true;
    let page: PDFPageProxy | undefined;
    let task: RenderTask | undefined;
    setDisplay('loading');
    const deadline = window.setTimeout(() => {
      if (!current) return;
      current = false;
      task?.cancel();
      setDisplay('Page preview timed out.');
      onTimeout?.();
    }, 15_000);
    void pdf.getPage(pageNumber).then(async (loaded) => {
      if (!current) return;
      page = loaded;
      const shape = shapeOf(page);
      onShape?.(pageNumber, shape);
      const scale = Math.min(width / shape.width, height / shape.height);
      const viewport = page.getViewport({ scale });
      const device = Math.min(window.devicePixelRatio || 1, thumbnail ? 1.5 : 2,
        maxCanvasSide / Math.max(viewport.width, viewport.height),
        Math.sqrt(maxCanvasArea / (viewport.width * viewport.height)));
      canvas.width = Math.max(1, Math.floor(viewport.width * device));
      canvas.height = Math.max(1, Math.floor(viewport.height * device));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      task = page.render({
        canvas, viewport, annotationMode: AnnotationMode.DISABLE,
        transform: device === 1 ? undefined : [device, 0, 0, device, 0, 0],
      });
      await task.promise;
      if (current) setDisplay('ready');
    }).catch((reason: unknown) => {
      if (current) setDisplay(pdfErrorMessage(reason));
    }).finally(() => clearTimeout(deadline));
    return () => {
      current = false;
      clearTimeout(deadline);
      task?.cancel();
      page?.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [height, onShape, onTimeout, pageNumber, pdf, thumbnail, width]);

  return <div className="pdf-canvas-frame" style={{ width, height }} data-rendered={display === 'ready' || undefined}>
    <canvas ref={canvasRef} role={thumbnail ? undefined : 'img'} aria-hidden={thumbnail || undefined}
      aria-label={thumbnail ? undefined : label} data-testid={thumbnail ? 'slide-thumbnail-canvas' : 'pdf-page-canvas'} />
    {display !== 'ready' && !thumbnail && <span className="pdf-page-message">{display === 'loading' ? 'Rendering…' : display}</span>}
  </div>;
}

function SlideRail({ pdf, selected, navigate, onShape }: {
  pdf: PDFDocumentProxy; selected: number; navigate(number: number): void; onShape(number: number, size: Size): void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const size = useBox(rail);
  const [offset, setOffset] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const first = Math.max(0, Math.floor(offset / thumbnailHeight) - 1);
  const last = Math.min(pdf.numPages, Math.ceil((offset + size.height) / thumbnailHeight) + 1);
  useLayoutEffect(() => {
    if (!rail.current) return;
    const top = (selected - 1) * thumbnailHeight;
    const bottom = top + thumbnailHeight;
    if (top < rail.current.scrollTop) rail.current.scrollTop = top;
    if (bottom > rail.current.scrollTop + rail.current.clientHeight) rail.current.scrollTop = bottom - rail.current.clientHeight;
    setOffset(rail.current.scrollTop);
  }, [selected, size.height]);
  return <nav className="pdf-slide-rail" ref={rail} aria-label="Slide thumbnails" onScroll={(event) => setOffset(event.currentTarget.scrollTop)}>
    <div style={{ height: pdf.numPages * thumbnailHeight }} className="pdf-thumbnails">
      {ready && Array.from({ length: Math.max(0, last - first) }, (_, offset) => {
        const number = first + offset + 1;
        return <button className="pdf-thumbnail" key={number} type="button" style={{ top: (number - 1) * thumbnailHeight }}
          aria-label={`Show slide ${number}`} aria-current={number === selected ? 'page' : undefined}
          data-testid="slide-thumbnail" data-slide={number} onClick={() => navigate(number)}>
          <PageCanvas pdf={pdf} pageNumber={number} width={102} height={54} label="" thumbnail onShape={onShape}/>
          <span>{number}</span>
        </button>;
      })}
    </div>
  </nav>;
}

function PageNumber({ value, count, unit, navigate }: {
  value: number; count: number; unit: string; navigate(number: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const submit = () => {
    if (draft === null) return;
    const target = Number.parseInt(draft, 10);
    const page = Number.isInteger(target) ? clamp(target, 1, count) : value;
    if (page !== value) navigate(page);
    setDraft(null);
  };
  return <form className="pdf-page-counter" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <label>{unit} <input type="text" inputMode="numeric" aria-label={`${unit} number`} value={draft ?? String(value)} maxLength={4}
      data-testid="pdf-page-number" onChange={(event) => setDraft(event.target.value)} onBlur={submit}/></label>
    <span aria-label={`of ${count}`}>/ {count}</span>
  </form>;
}

function PdfSearch({ pdf, navigate }: { pdf: PDFDocumentProxy; navigate(number: number): void }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<number[]>([]);
  const [index, setIndex] = useState(-1);
  const [status, setStatus] = useState('');
  const request = useRef<AbortController | null>(null);
  const latestNavigate = useRef(navigate);
  useLayoutEffect(() => { latestNavigate.current = navigate; }, [navigate]);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);
  function goToMatch(direction: number) {
    const next = (index + direction + matches.length) % matches.length;
    setIndex(next);
    navigate(matches[next]);
  }
  async function search() {
    const term = normalizePdfQuery(query);
    if (!term) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const found: number[] = [];
    const showMatches = () => {
      setMatches(found.slice());
      setIndex(found.length ? 0 : -1);
      if (found.length) latestNavigate.current(found[0]);
    };
    const deadline = window.setTimeout(() => {
      controller.abort();
      if (request.current !== controller) return;
      request.current = null;
      showMatches();
      setStatus('Search time limit reached.');
    }, 20_000);
    controller.signal.addEventListener('abort', () => clearTimeout(deadline), { once: true });
    setMatches([]);
    setIndex(-1);
    setStatus('Searching…');
    let unreadable = false;
    try {
      for (let number = 1; number <= pdf.numPages && !controller.signal.aborted; number++) {
        try {
          if (await pageContains(pdf, number, term, controller.signal)) found.push(number);
        } catch {
          unreadable = true;
        }
        if (number % 16 === 0 && request.current === controller) setStatus(`Searching page ${number} of ${pdf.numPages}…`);
      }
      if (request.current !== controller || controller.signal.aborted) return;
      showMatches();
      setStatus(unreadable ? 'Some pages could not be searched.' : found.length ? '' : 'No matching text.');
    } finally {
      clearTimeout(deadline);
      if (request.current === controller) request.current = null;
    }
  }
  return <div className="pdf-search">
    <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <input type="search" aria-label="Search PDF text" placeholder="Search text" maxLength={120}
        data-viewer-search data-testid="pdf-search" value={query}
        onChange={(event) => {
          request.current?.abort();
          request.current = null;
          setQuery(event.target.value);
          setMatches([]);
          setStatus('');
          setIndex(-1);
        }}/>
      <button className="icon-button" aria-label="Find text" type="submit" disabled={!query.trim()}><Icon name="search" size={14}/></button>
    </form>
    {matches.length > 0 && <div className="pdf-search-results">
      <span role="status" data-testid="pdf-search-results">Page {matches[index]} · {index + 1}/{matches.length}</span>
      <button className="icon-button" type="button" aria-label="Previous matching page" onClick={() => goToMatch(-1)}><Icon name="chevron" size={13} className="pdf-prev"/></button>
      <button className="icon-button" type="button" aria-label="Next matching page" onClick={() => goToMatch(1)}><Icon name="chevron" size={13}/></button>
    </div>}
    {status && <span role="status" className="pdf-search-status">{status}</span>}
  </div>;
}

function Pages({ loaded, slides, onTimeout }: { loaded: LoadedPdf; slides: boolean; onTimeout(): void }) {
  const { pdf, firstPage } = loaded;
  const unit = slides ? 'Slide' : 'Page';
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const size = useBox(stage);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [zoom, setZoom] = useState<Zoom>(slides ? 'window' : 'width');
  const [selected, setSelected] = useState(1);
  const [offset, setOffset] = useState(0);
  const [shapes, setShapes] = useState(() => new Map([[1, shapeOf(firstPage)]]));
  const onShape = useCallback((number: number, shape: Size) => setShapes((previous) => {
    const old = previous.get(number);
    return old?.width === shape.width && old.height === shape.height ? previous : new Map(previous).set(number, shape);
  }), []);
  const previousLayout = useRef<Frame[] | null>(null);
  const layoutSize = useRef<Size | null>(null);
  const pageAnchor = useRef<number | null>(null);
  const scrollFrame = useRef(0);
  const scrollOffset = useRef(0);
  const presentationZoom = fullscreen ? 'window' : zoom;
  const initial = shapes.get(1)!;
  const selectedShape = shapes.get(selected) ?? initial;
  const layout = useMemo(() => {
    if (slides || !size.width || !size.height) return { frames: [], height: 0, width: 0 };
    let height = gutter;
    let width = size.width;
    const frames = Array.from({ length: pdf.numPages }, (_, i) => {
      const shape = shapes.get(i + 1) ?? initial;
      const scale = fitted(shape, size, zoom);
      const frame = { top: height, width: Math.max(1, shape.width * scale), height: Math.max(1, shape.height * scale) };
      height += frame.height + gutter;
      width = Math.max(width, frame.width + 2 * gutter);
      return frame;
    });
    return { frames, height, width };
  }, [initial, pdf.numPages, shapes, size, slides, zoom]);
  const { frames } = layout;
  const scale = fitted(selectedShape, size, presentationZoom);
  const nearTop = frames.length ? pageAt(frames, offset) : 1;
  const topPage = frames[nearTop - 1];
  const first = topPage && topPage.top + topPage.height <= offset ? nearTop + 1 : nearTop;
  // Size the scroll area for all pages, but rasterize only those that intersect it.
  const last = frames.length ? Math.min(first + 4, pageAt(frames, offset + size.height - 1)) : 0;

  const scrollTo = useCallback((position: number) => {
    if (!stage.current) return;
    stage.current.scrollTop = position;
    scrollOffset.current = stage.current.scrollTop;
    setOffset(scrollOffset.current);
  }, []);
  const navigate = useCallback((number: number) => {
    const page = clamp(number, 1, pdf.numPages);
    setSelected(page);
    if (slides) {
      if (stage.current) stage.current.scrollTop = 0;
      return;
    }
    pageAnchor.current = page;
    if (frames[page - 1]) scrollTo(frames[page - 1].top - gutter);
  }, [frames, pdf.numPages, scrollTo, slides]);
  useLayoutEffect(() => {
    const prior = previousLayout.current;
    const top = scrollOffset.current;
    previousLayout.current = frames;
    layoutSize.current = size;
    if (!frames.length) return;
    if (pageAnchor.current !== null) {
      scrollTo(frames[pageAnchor.current - 1].top - gutter);
      return;
    }
    if (!prior?.length) return;
    const anchor = pageAt(prior, top + gutter);
    const delta = frames[anchor - 1].top - prior[anchor - 1].top;
    scrollTo(top + delta);
  }, [frames, scrollTo, size]);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  useEffect(() => {
    if (!slides) return;
    const change = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, [slides]);
  const exitPresentation = useCallback(() => {
    if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => {});
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') exitPresentation();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [exitPresentation, fullscreen]);

  function scrollPages() {
    if (slides || scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const element = stage.current;
      const currentFrames = previousLayout.current;
      const viewport = layoutSize.current;
      if (!element || !currentFrames?.length || !viewport
        || element.clientWidth !== viewport.width || element.clientHeight !== viewport.height) return;
      const position = element.scrollTop;
      if (position === scrollOffset.current) return;
      pageAnchor.current = null;
      scrollOffset.current = position;
      setOffset(position);
      setSelected(pageAt(currentFrames, position + Math.min(120, element.clientHeight / 4)));
    });
  }
  function zoomTo(next: Zoom) {
    if (!slides && next !== zoom) pageAnchor.current = selected;
    setZoom(next);
  }
  async function present() {
    try {
      if (!root.current) return;
      await root.current.requestFullscreen();
      root.current.focus();
    } catch {
      setFullscreenError('Full-screen presentation is unavailable in this window.');
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('input') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = (event.target as HTMLElement).closest('button');
    const previous = event.key === 'PageUp' || (slides && ['ArrowLeft', 'ArrowUp'].includes(event.key));
    const next = event.key === 'PageDown' || (slides && (['ArrowRight', 'ArrowDown'].includes(event.key) || (event.key === ' ' && !buttons)));
    if (previous || next || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      navigate(previous ? selected - 1 : next ? selected + 1 : event.key === 'Home' ? 1 : pdf.numPages);
    }
  }

  return <section className="paged-viewer" ref={root} tabIndex={0} aria-label={slides ? 'PowerPoint slide viewer' : 'PDF viewer'}
    data-testid={slides ? 'powerpoint-viewer' : 'pdf-viewer'} data-fullscreen={fullscreen || undefined} onKeyDown={onKeyDown}>
    <header className="pdf-toolbar">
      <div className="pdf-controls">
        <button className="icon-button" type="button" aria-label={`Previous ${unit.toLowerCase()}`}
          disabled={selected === 1} onClick={() => navigate(selected - 1)}><Icon name="chevron" className="pdf-prev"/></button>
        <PageNumber unit={unit} value={selected} count={pdf.numPages} navigate={navigate}/>
        <button className="icon-button" type="button" aria-label={`Next ${unit.toLowerCase()}`}
          disabled={selected === pdf.numPages} onClick={() => navigate(selected + 1)}><Icon name="chevron"/></button>
      </div>
      <div className="pdf-controls">
        <button className="icon-button pdf-zoom" type="button" aria-label="Zoom out" disabled={scale <= minZoom}
          onClick={() => zoomTo(clamp(scale / 1.25, minZoom, maxZoom))}>−</button>
        <output className="pdf-zoom-value" aria-label="Zoom level">{Math.round(scale * 100)}%</output>
        <button className="icon-button pdf-zoom" type="button" aria-label="Zoom in" disabled={scale >= maxZoom}
          onClick={() => zoomTo(clamp(scale * 1.25, minZoom, maxZoom))}>+</button>
        <button className="button" type="button" aria-pressed={zoom === 'window'} onClick={() => zoomTo('window')}>Fit to window</button>
        {!slides && <button className="button" type="button" aria-pressed={zoom === 'width'} onClick={() => zoomTo('width')}>Fit width</button>}
      </div>
      {slides ? <button className="button" type="button" onClick={() => void present()}><Icon name="play" size={13}/> Present</button>
        : <PdfSearch pdf={pdf} navigate={navigate}/>}
      {fullscreenError && <span role="alert" className="pdf-search-status">{fullscreenError}</span>}
    </header>
    <div className="pdf-body">
      {slides && !fullscreen && <SlideRail pdf={pdf} selected={selected} navigate={navigate} onShape={onShape}/>}
      <div className="pdf-stage" ref={stage} tabIndex={0} aria-label={slides ? 'Slide canvas' : 'Scrollable PDF pages'} onScroll={scrollPages}>
        {slides ? <div className="pdf-slide-stage">
          {size.width > 0 && size.height > 0 && <PageCanvas key={selected} pdf={pdf} pageNumber={selected}
            width={selectedShape.width * scale} height={selectedShape.height * scale} label={`Slide ${selected}`}
            onShape={onShape} onTimeout={onTimeout}/>}
        </div> : <div className="pdf-page-stack" style={{ width: layout.width, height: layout.height }}>
          {Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => {
            const number = first + i;
            const frame = frames[number - 1];
            return <div className="pdf-page-position" style={{ top: frame.top }} key={number} data-page={number}>
              <PageCanvas pdf={pdf} pageNumber={number} width={frame.width} height={frame.height}
                label={`Page ${number}`} onShape={onShape} onTimeout={onTimeout}/>
            </div>;
          })}
        </div>}
      </div>
    </div>
    {fullscreen && <button className="button pdf-exit-presentation" type="button" onClick={exitPresentation}>
      <Icon name="x" size={14}/> Exit presentation
    </button>}
  </section>;
}

export default function PagedViewer({ session }: { session: PagedViewerSession }) {
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [error, setError] = useState('');
  const failure = useRef<(reason: unknown) => void>(() => {});
  useEffect(() => {
    setLoaded(null);
    setError('');
    let live = true;
    const source = loadLocalPdf(session, (reason) => {
      if (live) {
        setLoaded(null);
        setError(pdfErrorMessage(reason));
      }
    });
    failure.current = source.fail;
    void source.ready.then((result) => {
      if (!live || !result) return;
      try {
        shapeOf(result.firstPage);
        setLoaded(result);
      } catch (reason) {
        source.fail(reason);
      }
    });
    return () => {
      live = false;
      source.dispose();
    };
  }, [session]);
  const onTimeout = useCallback(() => failure.current(new Error('Document rendering timed out.')), []);
  if (error) return <div className="pdf-preview-message" role="alert" data-testid="pdf-error">{error}</div>;
  if (!loaded) return <div className="pdf-preview-message" role="status">Loading preview…</div>;
  return <Pages loaded={loaded} slides={session.format === 'pptx'} onTimeout={onTimeout}/>;
}
