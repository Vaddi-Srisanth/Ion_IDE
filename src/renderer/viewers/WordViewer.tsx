import { useEffect, useMemo, useRef, useState } from 'react';
import type { WordBlock, WordPage, WordParagraph, WordViewerSession } from '../../shared/viewers';
import { errorMessage } from '../documents';
import './word-viewer.css';

const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
type Match = { from: number; to: number };

function findMatches(blocks: WordBlock[], query: string) {
  const search = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const highlights = new Map<WordParagraph, Match[]>();
  let count = 0;
  for (const block of blocks) {
    if (block.kind === 'image') continue;
    const paragraphs = block.kind === 'paragraph' ? [block] : block.rows.flat(2);
    for (const paragraph of paragraphs) {
      const matches: Match[] = [];
      for (const match of paragraph.runs.map(({ text }) => text).join('').matchAll(search)) {
        if (++count <= 250) matches.push({ from: match.index, to: match.index + match[0].length });
      }
      if (matches.length) highlights.set(paragraph, matches);
    }
  }
  return { count, highlights };
}

function Paragraph({ paragraph, matches = [] }: { paragraph: WordParagraph; matches?: Match[] }) {
  const Tag = headings[(paragraph.heading ?? 0) - 1] ?? 'p';
  let offset = 0;
  let nextMatch = 0;
  return <Tag>
    {paragraph.runs.map(({ text, bold, italic, underline }, index) => {
      const parts = [];
      const end = offset + text.length;
      let cursor = 0;
      while (nextMatch < matches.length && matches[nextMatch].from < end) {
        const match = matches[nextMatch];
        const from = Math.max(0, match.from - offset);
        const to = Math.min(text.length, match.to - offset);
        parts.push(text.slice(cursor, from), <mark key={match.from}>{text.slice(from, to)}</mark>);
        cursor = to;
        if (match.to > end) break;
        nextMatch++;
      }
      parts.push(text.slice(cursor));
      offset = end;
      return <span key={index} className={`${bold ? 'word-bold' : ''} ${italic ? 'word-italic' : ''} ${underline ? 'word-underline' : ''}`}>
        {parts}
      </span>;
    })}
    {!paragraph.runs.length && <br/>}
  </Tag>;
}

function Picture({ id, picture }: { id: string; picture: Extract<WordBlock, { kind: 'image' }> }) {
  const [result, setResult] = useState<{ url: string } | { error: string }>();
  useEffect(() => {
    let alive = true;
    let objectURL: string | undefined;
    void window.ion.viewers.wordImage(id, picture.id).then(({ bytes, mime }) => {
      if (!alive) return;
      const buffer = bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Uint8Array.from(bytes);
      objectURL = URL.createObjectURL(new Blob([buffer], { type: mime }));
      setResult({ url: objectURL });
    }).catch((reason: unknown) => {
      if (alive) setResult({ error: errorMessage(reason) });
    });
    return () => {
      alive = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [id, picture.id]);

  if (!result) return <p className="word-embedded-status" role="status">Loading embedded image…</p>;
  if ('error' in result) return <p className="word-embedded-status" role="status">{result.error}</p>;
  return <figure className="word-picture">
    <img data-testid="word-image" src={result.url} alt={picture.alt} decoding="async"
      width={picture.width} style={{ maxHeight: picture.height }}
      onError={() => {
        URL.revokeObjectURL(result.url);
        setResult({ error: 'An embedded image could not be displayed.' });
      }}/>
  </figure>;
}

function Content({ session, blocks, highlights }: {
  session: WordViewerSession; blocks: WordBlock[]; highlights?: ReadonlyMap<WordParagraph, Match[]>;
}) {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case 'paragraph':
        return <Paragraph key={index} paragraph={block} matches={highlights?.get(block)}/>;
      case 'image':
        return <Picture key={index} id={session.id} picture={block}/>;
      case 'table':
        return <div key={index} className="word-table" tabIndex={0} aria-label="Document table">
          <table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>
            {row.map((cell, cellIndex) => <td key={cellIndex}>
              {cell.map((paragraph, paragraphIndex) =>
                <Paragraph key={paragraphIndex} paragraph={paragraph} matches={highlights?.get(paragraph)}/>)}
            </td>)}
          </tr>)}</tbody></table>
        </div>;
    }
  });
}

export default function WordViewer({ session }: { session: WordViewerSession }) {
  const [section, setSection] = useState(0);
  const [preview, setPreview] = useState<{ index: number; page: WordPage }>();
  const [error, setError] = useState<{ index: number; message: string }>();
  const [zoom, setZoom] = useState(100);
  const [query, setQuery] = useState('');
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    if (scroll.current) scroll.current.scrollTop = 0;
    void window.ion.viewers.wordPage(session.id, section).then((page) => {
      if (current) {
        setError(undefined);
        setPreview({ index: section, page });
      }
    }).catch((reason: unknown) => {
      if (current) setError({ index: section, message: errorMessage(reason) });
    });
    return () => { current = false; };
  }, [session.id, section]);

  const visible = preview?.index === section ? preview.page : undefined;
  const search = useMemo(() => {
    const text = query.trim();
    return text && visible ? findMatches(visible.blocks, text) : null;
  }, [query, visible]);
  const pageCount = preview?.page.pageCount ?? 1;
  const loading = !visible && error?.index !== section;

  return <section className="word-viewer" aria-label="Word preview" data-testid="word-viewer">
    <div className="word-toolbar" role="toolbar" aria-label="Word preview controls">
      <div className="word-control-group">
        <button className="button" type="button" data-testid="word-prev" aria-label="Previous preview section"
          disabled={section <= 0 || loading} onClick={() => setSection(section - 1)}>‹</button>
        <span aria-live="polite" className="word-section-number">Section {section + 1} of {pageCount}</span>
        <button className="button" type="button" data-testid="word-next" aria-label="Next preview section"
          disabled={section >= pageCount - 1 || loading} onClick={() => setSection(section + 1)}>›</button>
      </div>
      <label className="word-control-group">
        <span className="word-zoom-label">Zoom</span>
        <select aria-label="Word preview zoom" data-testid="word-zoom" value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}>
          {[75, 100, 125, 150].map((scale) => <option key={scale} value={scale}>{scale}%</option>)}
        </select>
      </label>
      <div className="word-control-group word-search-group">
        <input type="search" aria-label="Find text in this Word preview section" data-testid="word-find"
          data-viewer-search="" placeholder="Find in section…" maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)}/>
        {search && <span aria-live="polite">{search.count} {search.count === 1 ? 'match' : 'matches'}</span>}
      </div>
    </div>
    <div className="word-scroll" ref={scroll} tabIndex={0} aria-label="Word document preview content">
      {loading && <p className="word-feedback" role="status">Loading Word preview…</p>}
      {error?.index === section && <p className="word-feedback word-error" role="alert">{error.message}</p>}
      {visible && <article className="word-sheet" data-testid="word-page" style={{ fontSize: 16 * zoom / 100 }} key={section}>
        {visible.unsupported && <p className="word-format-notice">
          Some document formatting or embedded content is omitted in this preview.
        </p>}
        {visible.blocks.length
          ? <Content session={session} blocks={visible.blocks} highlights={search?.highlights}/>
          : <p className="word-feedback">This document has no previewable content.</p>}
      </article>}
    </div>
  </section>;
}
