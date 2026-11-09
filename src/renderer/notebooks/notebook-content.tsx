import { createElement, memo, useMemo, type ReactNode } from 'react';
import { Marked } from 'marked';
import { notebookText, type NotebookCell, type NotebookOutput } from '../../shared/notebook-format';
import { NotebookImage, notebookImageMimes, type NotebookImageMime } from './notebook-images';

const markdown = new Marked({ gfm: true, async: false });
const maxMarkup = 240 * 1024;
const maxMarkdown = 80 * 1024;
const maxCode = 36 * 1024;
const maxOutputText = 48 * 1024;
const maxCellOutputs = 24;

const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const staticTags = new Set(['article', 'section', 'div', 'p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ol', 'ul', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'figure', 'figcaption', 'details',
  'summary', 'kbd', 'samp', 'sub', 'sup', 'mark', 'small', 'br', 'hr']);
const discardTags = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'canvas',
  'svg', 'math', 'template', 'audio', 'video', 'noscript', 'textarea', 'select']);

function firstImage(data: Record<string, unknown> | undefined): [NotebookImageMime, unknown] | undefined {
  if (!data) return;
  for (const mime of notebookImageMimes) {
    const value = data[mime];
    if (typeof value === 'string' && value.length || Array.isArray(value) && value.length) return [mime, value];
  }
}

function markupImage(source: string, attachments: NotebookCell['attachments']): [NotebookImageMime, unknown] | undefined {
  if (source.startsWith('attachment:') && attachments) {
    const attachment = source.slice('attachment:'.length);
    if (Object.hasOwn(attachments, attachment)) return firstImage(attachments[attachment]);
    try {
      const decoded = decodeURIComponent(attachment);
      if (Object.hasOwn(attachments, decoded)) return firstImage(attachments[decoded]);
    } catch { /* A malformed escape cannot refer to a local attachment. */ }
  }
  const inline = /^data:(image\/(?:png|jpeg));base64,/i.exec(source);
  if (inline) return [inline[1].toLowerCase() as NotebookImageMime, source.slice(inline[0].length)];
}

function projectMarkup(html: string, attachments?: NotebookCell['attachments']) {
  // Template contents remain inert. Build fresh elements using static tags and numeric spans.
  const template = document.createElement('template');
  template.innerHTML = html;
  let visited = 0;
  let images = 0;
  let limited = false;

  function content(node: Node, depth: number): ReactNode[] {
    const result: ReactNode[] = [];
    for (const child of node.childNodes) {
      if (++visited > 3500 || depth > 40) {
        limited = true;
        break;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        result.push(child.nodeValue);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.localName;
      if (element.namespaceURI !== htmlNamespace || discardTags.has(tag)) continue;
      const key = visited;
      if (tag === 'img') {
        const image = markupImage(element.getAttribute('src') ?? '', attachments);
        const alt = (element.getAttribute('alt') || 'Notebook attachment').slice(0, 300);
        if (image && images++ < 6) result.push(<NotebookImage key={key} mime={image[0]} value={image[1]} alt={alt}/>);
        else if (element.hasAttribute('alt')) result.push(<span className="notebook-muted" key={key}>{alt}</span>);
        continue;
      }
      if (tag === 'input') {
        if (element.getAttribute('type') === 'checkbox') result.push(<span key={key} aria-label={element.hasAttribute('checked')
          ? 'Task completed' : 'Task incomplete'}>{element.hasAttribute('checked') ? '☑ ' : '☐ '}</span>);
        continue;
      }
      const children = content(element, depth + 1);
      if (tag === 'a') {
        result.push(<span key={key} className="notebook-link">{children}</span>);
      } else if (staticTags.has(tag)) {
        const props: { key: number; colSpan?: number; rowSpan?: number; start?: number } = { key };
        if (tag === 'th' || tag === 'td') {
          for (const [attribute, property] of [['colspan', 'colSpan'], ['rowspan', 'rowSpan']] as const) {
            const span = Number(element.getAttribute(attribute));
            if (Number.isInteger(span) && span > 0 && span <= 100) props[property] = span;
          }
        }
        if (tag === 'ol') {
          const start = Number(element.getAttribute('start'));
          if (Number.isInteger(start) && start > 0 && start <= 100_000) props.start = start;
        }
        result.push(createElement(tag, props, ...(children.length ? [children] : [])));
      } else {
        result.push(...children);
      }
    }
    return result;
  }

  const nodes = content(template.content, 0);
  return { nodes, limited };
}

function markdownWithinBudget(text: string): boolean {
  let markers = 0;
  let line = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\n' || character === '\r') line = 0;
    else if (++line > 8192) return false;
    // Malformed link-heavy input can drive the Markdown parser's regex work.
    if ('[]()<>*_`'.includes(character) && ++markers > 2500) return false;
  }
  return true;
}

export function NotebookMarkup({ value, isMarkdown, attachments }: {
  value: NotebookCell['source']; isMarkdown?: boolean; attachments?: NotebookCell['attachments'];
}) {
  const limit = isMarkdown ? maxMarkdown : maxMarkup;
  const text = useMemo(() => notebookText(value, limit + 1) ?? '', [value, limit]);
  const preview = useMemo(() => {
    try {
      const source = text.slice(0, limit);
      if (isMarkdown && !markdownWithinBudget(source)) return undefined;
      const html = isMarkdown ? markdown.parse(source, { async: false }) : source;
      const rendered = projectMarkup(html.slice(0, maxMarkup), attachments);
      return { ...rendered, limited: rendered.limited || text.length > limit || html.length > maxMarkup };
    } catch {
      return undefined;
    }
  }, [text, limit, isMarkdown, attachments]);
  if (!preview) return <>
    <pre className="notebook-code">{text.slice(0, maxCode)}</pre>
    {isMarkdown && <p className="notebook-muted">Showing source because this Markdown exceeds the preview limits.</p>}
  </>;
  return <div className="notebook-markup">
    {preview.nodes}
    {preview.limited && <p className="notebook-muted">Preview shortened for this large output.</p>}
  </div>;
}

const pythonTokens = /#[^\r\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|match|None|nonlocal|not|or|pass|raise|return|True|try|type|while|with|yield)\b|\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?[jJ]?)\b/g;

export function NotebookCode({ value, highlight }: { value: NotebookCell['source']; highlight: boolean }) {
  const text = notebookText(value, maxCode + 1) ?? '';
  const visible = text.slice(0, maxCode);
  const nodes = useMemo(() => {
    if (!highlight) return visible;
    const parts: ReactNode[] = [];
    let offset = 0;
    for (const match of visible.matchAll(pythonTokens)) {
      if (parts.length >= 2400) break;
      const token = match[0];
      const type = token.startsWith('#') ? 'comment' : /^["']/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : 'keyword';
      parts.push(visible.slice(offset, match.index), <span className={`notebook-token-${type}`} key={match.index}>{token}</span>);
      offset = match.index + token.length;
    }
    parts.push(visible.slice(offset));
    return parts;
  }, [visible, highlight]);
  return <pre className="notebook-code"><code>{nodes || ' '}</code>
    {text.length > maxCode && <span className="notebook-muted">{'\n'}Source preview shortened.</span>}
  </pre>;
}

function readable(text: string) {
  return text.replace(/\x1b\[[0-?]{0,64}[ -/]{0,8}[@-~]/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
}

function OutputText({ value, tone }: { value: unknown; tone?: 'stderr' | 'error' }) {
  const text = notebookText(value, maxOutputText + 1) ?? '';
  return <pre className={`notebook-code notebook-output-text${tone ? ` notebook-${tone}` : ''}`}>
    {readable(text.slice(0, maxOutputText))}
    {text.length > maxOutputText && <span className="notebook-muted">{'\n'}Text output preview shortened.</span>}
  </pre>;
}

function tracebackPreview(lines: string[]): string {
  const parts: string[] = [];
  let remaining = maxOutputText + 1;
  for (const line of lines) {
    if (remaining <= 0) break;
    const fragment = line.slice(0, remaining);
    parts.push(fragment);
    remaining -= fragment.length + 1;
  }
  return parts.join('\n');
}

function Output({ output }: { output: NotebookOutput }) {
  if (output.output_type === 'stream') return <>
    <span className="notebook-output-label">{output.name === 'stderr' ? 'stderr' : 'stdout'}</span>
    <OutputText value={output.text} tone={output.name === 'stderr' ? 'stderr' : undefined}/>
  </>;
  if (output.output_type === 'error') return <>
    <span className="notebook-output-label notebook-error">{output.ename?.slice(0, 250)}</span>
    <OutputText value={output.traceback?.length ? tracebackPreview(output.traceback) : output.evalue} tone="error"/>
  </>;
  if (output.output_type === 'display_data' || output.output_type === 'execute_result' || output.output_type === 'update_display_data') {
    const image = firstImage(output.data);
    if (image) return <NotebookImage mime={image[0]} value={image[1]} alt="Saved notebook output"/>;
    const html = notebookText(output.data?.['text/html'], maxMarkup + 1);
    if (html) return <NotebookMarkup value={html}/>;
    const renderedMarkdown = notebookText(output.data?.['text/markdown'], maxMarkdown + 1);
    if (renderedMarkdown) return <NotebookMarkup value={renderedMarkdown} isMarkdown/>;
    if (output.data && Object.hasOwn(output.data, 'text/plain')) return <OutputText value={output.data['text/plain']}/>;
  }
  return <p className="notebook-muted">This output type has no static preview.</p>;
}

export const NotebookOutputs = memo(function NotebookOutputs({ outputs }: { outputs: NotebookOutput[] }) {
  return <div className="notebook-outputs" aria-label="Cell outputs">
    {outputs.slice(0, maxCellOutputs).map((output, index) => <div className="notebook-output" data-testid="notebook-output" key={index}>
      <Output output={output}/>
    </div>)}
    {outputs.length > maxCellOutputs && <p className="notebook-muted">Showing the first {maxCellOutputs} outputs in this cell.</p>}
  </div>;
});
