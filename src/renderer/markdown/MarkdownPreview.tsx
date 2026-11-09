import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Marked } from 'marked';
import type { Entry } from '../../shared/contracts';
import { maxMarkdownPreviewSourceLength } from '../../shared/markdown-path';
import type { ThemeData } from '../../shared/themes';
import { MarkdownCode, markdownLanguage } from './MarkdownCode';
import { MarkdownImage } from './MarkdownImage';
import { MarkdownVisibility } from './visibility';
import './markdown.css';

interface MarkdownPreviewProps {
  source: string;
  path: string | null;
  workspacePath?: string;
  theme?: ThemeData | null;
  visible?: boolean;
  onOpenEntry(entry: Entry): void;
  scrollTop?: number;
  onScrollTop?(position: number): void;
}

const markdown = new Marked({ gfm: true, async: false });
const maxHtml = 512 * 1024;
const maxNodes = 6500;
const maxImages = 24;
const maxHighlightedBlocks = 64;
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const htmlTags = new Set(['article', 'section', 'div', 'p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ol', 'ul', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'figure', 'figcaption', 'details',
  'summary', 'kbd', 'samp', 'sub', 'sup', 'mark', 'small', 'br', 'hr']);
const discardedTags = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'canvas',
  'svg', 'math', 'template', 'audio', 'video', 'noscript', 'textarea', 'select', 'form']);
const scheme = /^[a-z][a-z\d+.-]*:/i;
const unsafeHref = /[\\\x00-\x1f\x7f]/;

function relativeHref(href: string): boolean {
  if (!href || href.length > 2048 || href.startsWith('#')) return false;
  try {
    const decoded = decodeURIComponent(href).trim();
    return !!decoded && !decoded.startsWith('/') && !decoded.startsWith('~') && !unsafeHref.test(decoded) && !scheme.test(decoded);
  } catch {
    return false;
  }
}

function linkHref(href: string): string | undefined {
  if (!href || href.length > 2048 || unsafeHref.test(href)) return;
  if (href.startsWith('#') || relativeHref(href)) return href;
  if (!/^https?:\/\//i.test(href)) return;
  try {
    const parsed = new URL(href);
    if (!parsed.username && !parsed.password) return parsed.href;
  } catch { /* Invalid links stay as text. */ }
}

function headingSlug(value: string): string {
  return value.normalize('NFC').trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '').replace(/\s/g, '-');
}

function boundedSource(source: string): string {
  const length = Math.min(source.length, maxMarkdownPreviewSourceLength);
  let lineStart = 0;
  let lineMarkers = 0;
  let paragraphMarkers = 0;
  for (let index = 0; index < length; index++) {
    const character = source[index];
    if (character === '\n') {
      if (source.slice(lineStart, index).trim() === '') paragraphMarkers = 0;
      lineStart = index + 1;
      lineMarkers = 0;
    } else if (index - lineStart >= 8192 || ('[]()<>*_`'.includes(character) && (++lineMarkers > 256 || ++paragraphMarkers > 900))) {
      return source.slice(0, lineStart);
    }
  }
  return source.slice(0, source.length > length ? lineStart : length);
}

interface ProjectionOptions {
  path: string | null;
  workspacePath?: string;
  theme?: ThemeData | null;
  activateLink(href: string): void;
}

function renderMarkdown(source: string, options: ProjectionOptions) {
  const bounded = boundedSource(source);
  const html = markdown.parse(bounded, { async: false });
  // Template contents remain inert. Mount fresh elements with explicit attributes.
  const template = document.createElement('template');
  template.innerHTML = html.slice(0, maxHtml);
  const usedSlugs = new Set<string>();
  let nodes = 0;
  let images = 0;
  let blocks = 0;
  let limited = bounded.length !== source.length || html.length > maxHtml;

  function children(parent: Node, depth: number): ReactNode[] {
    const result: ReactNode[] = [];
    for (const child of parent.childNodes) {
      if (++nodes > maxNodes || depth > 40) { limited = true; break; }
      if (child.nodeType === Node.TEXT_NODE) { result.push(child.nodeValue); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.localName;
      if (element.namespaceURI !== htmlNamespace || discardedTags.has(tag)) continue;
      const key = nodes;

      if (tag === 'img') {
        const href = (element.getAttribute('src') ?? '').trim();
        const alt = (element.getAttribute('alt') || 'Image').slice(0, 512);
        if (options.path && options.workspacePath && relativeHref(href) && images++ < maxImages) {
          result.push(<MarkdownImage key={key} path={options.path} workspacePath={options.workspacePath} href={href} alt={alt}/>);
        } else result.push(<span key={key} className="markdown-image-note">{alt}</span>);
        continue;
      }
      if (tag === 'input') {
        if (element.getAttribute('type') === 'checkbox') {
          const checked = element.hasAttribute('checked');
          result.push(<input key={key} type="checkbox" checked={checked} readOnly disabled
            aria-label={checked ? 'Task completed' : 'Task incomplete'}/>);
        }
        continue;
      }
      if (tag === 'pre' && element.childElementCount === 1 && element.firstElementChild?.localName === 'code') {
        const code = element.firstElementChild;
        const language = markdownLanguage(code.getAttribute('class') ?? '');
        const value = code.textContent ?? '';
        result.push(language && blocks++ < maxHighlightedBlocks
          ? <MarkdownCode key={key} value={value} language={language} theme={options.theme}/>
          : <pre key={key}><code>{value}</code></pre>);
        continue;
      }

      const contents = children(element, depth + 1);
      if (tag === 'a') {
        const href = linkHref((element.getAttribute('href') ?? '').trim());
        if (href) {
          result.push(<a key={key} href={href} title={element.getAttribute('title')?.slice(0, 512)}
            rel="noreferrer noopener" onClick={(event) => { event.preventDefault(); options.activateLink(href); }}
            onAuxClick={(event) => event.preventDefault()}>{contents}</a>);
        } else result.push(<span key={key}>{contents}</span>);
      } else if (htmlTags.has(tag)) {
        const attributes: { key: number; id?: string; colSpan?: number; rowSpan?: number; start?: number;
          style?: { textAlign: 'left' | 'center' | 'right' } } = { key };
        if (/^h[1-6]$/.test(tag)) {
          const base = headingSlug(element.textContent ?? '') || 'section';
          let slug = base;
          for (let suffix = 1; usedSlugs.has(slug); suffix++) slug = `${base}-${suffix}`;
          usedSlugs.add(slug);
          attributes.id = `markdown-preview-${slug}`;
        }
        if (tag === 'th' || tag === 'td') {
          for (const [name, property] of [['colspan', 'colSpan'], ['rowspan', 'rowSpan']] as const) {
            const value = Number(element.getAttribute(name));
            if (Number.isInteger(value) && value > 0 && value <= 100) attributes[property] = value;
          }
          const align = element.getAttribute('align');
          if (align === 'left' || align === 'center' || align === 'right') attributes.style = { textAlign: align };
        }
        if (tag === 'ol' && element.hasAttribute('start')) {
          const start = Number(element.getAttribute('start'));
          if (Number.isInteger(start) && Math.abs(start) <= 100_000) attributes.start = start;
        }
        const node = createElement(tag, attributes, ...(contents.length ? [contents] : []));
        result.push(tag === 'table' ? <div className="markdown-table" key={key}>{node}</div> : node);
      } else result.push(...contents);
    }
    return result;
  }

  const content = children(template.content, 0);
  return { content, limited };
}

export default function MarkdownPreview({ source, path, workspacePath, theme, visible = true,
  onOpenEntry, scrollTop = 0, onScrollTop }: MarkdownPreviewProps) {
  const scroller = useRef<HTMLElement>(null);
  const openEntry = useRef(onOpenEntry);
  const lifetime = useRef<AbortController>(null);
  const [linkError, setLinkError] = useState('');

  useLayoutEffect(() => { openEntry.current = onOpenEntry; }, [onOpenEntry]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [path, visible, workspacePath]);
  useLayoutEffect(() => {
    if (visible && scroller.current) scroller.current.scrollTop = scrollTop;
  }, [scrollTop, visible]);

  const activateLink = useCallback((href: string) => {
    setLinkError('');
    if (href.startsWith('#')) {
      if (href === '#') { if (scroller.current) scroller.current.scrollTop = 0; return; }
      try {
        const slug = headingSlug(decodeURIComponent(href.slice(1)));
        scroller.current?.querySelector(`#${CSS.escape(`markdown-preview-${slug}`)}`)?.scrollIntoView({ block: 'start' });
      } catch { /* A malformed fragment has no destination. */ }
      return;
    }
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    void window.ion.markdown.openLink(path, href).then((entry) => {
      if (!signal.aborted && entry) openEntry.current(entry);
    }).catch(() => {
      if (!signal.aborted) setLinkError('This link could not be opened. Local links need a file in the open workspace folder.');
    });
  }, [path]);

  // Keep the committed input while hidden so toggling does not parse or rebuild the document.
  const [input, setInput] = useState<(ProjectionOptions & { source: string }) | null>(() =>
    visible ? { source, path, workspacePath, theme, activateLink } : null);
  if (visible && (!input || input.source !== source || input.path !== path || input.workspacePath !== workspacePath
    || input.theme !== theme || input.activateLink !== activateLink)) {
    setInput({ source, path, workspacePath, theme, activateLink });
  }
  const rendered = useMemo(() => {
    if (!input) return null;
    try { return renderMarkdown(input.source, input); }
    catch { return null; }
  }, [input]);

  return <section className="markdown-preview" aria-label="Markdown preview" data-testid="markdown-preview"
    ref={scroller} aria-hidden={!visible || undefined} tabIndex={visible ? 0 : -1}
    onScroll={visible ? (event) => onScrollTop?.(event.currentTarget.scrollTop) : undefined}>
    <MarkdownVisibility.Provider value={visible}>
      <article className="markdown-content">
        {linkError && <p className="markdown-notice" role="status">{linkError}</p>}
        {rendered?.content}
        {rendered?.limited && <p className="markdown-notice">Preview shortened to keep large or complex Markdown responsive.</p>}
        {rendered && !rendered.content.length && !rendered.limited && <p className="markdown-notice">The Markdown file is empty.</p>}
        {input && !rendered && <p className="markdown-notice" role="status">This Markdown could not be rendered.</p>}
      </article>
    </MarkdownVisibility.Provider>
  </section>;
}
