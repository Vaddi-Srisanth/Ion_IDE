import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ThemeData } from '../../shared/themes';
import { loadEditor } from '../load-editor';
import { MarkdownVisibility } from './visibility';

const aliases = new Map([
  ['c', 'c'], ['h', 'c'], ['cpp', 'cpp'], ['c++', 'cpp'], ['cxx', 'cpp'], ['cc', 'cpp'],
  ['java', 'java'], ['python', 'python'], ['py', 'python'], ['python3', 'python'],
  ['javascript', 'javascript'], ['js', 'javascript'], ['mjs', 'javascript'], ['jsx', 'javascript'],
  ['html', 'html'], ['htm', 'html'], ['css', 'css'], ['typescript', 'typescript'], ['ts', 'typescript'],
  ['json', 'json'], ['sh', 'shell'], ['bash', 'shell'], ['shell', 'shell'], ['yaml', 'yaml'], ['yml', 'yaml'],
]);

export function markdownLanguage(classNames: string): string | undefined {
  const language = /(?:^|\s)language-([^\s]+)/i.exec(classNames)?.[1].toLowerCase();
  return language ? aliases.get(language) : undefined;
}

function highlightedNodes(html: string): ReactNode[] | undefined {
  if (html.length > 192 * 1024) return;
  const template = document.createElement('template');
  template.innerHTML = html;
  let count = 0;

  function project(node: Node, depth: number): ReactNode[] {
    const nodes: ReactNode[] = [];
    for (const child of node.childNodes) {
      if (++count > 4000 || depth > 8) throw new Error('Markdown code highlight exceeds the display budget.');
      if (child.nodeType === Node.TEXT_NODE) { nodes.push(child.nodeValue); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const key = count;
      if (element.localName === 'br') nodes.push('\n');
      else if (element.localName === 'span') {
        const className = (element.getAttribute('class') ?? '').split(/\s+/)
          .filter((name) => /^mtk(?:\d{1,4}|[bius])$/.test(name)).join(' ');
        nodes.push(<span key={key} className={className || undefined}>{project(element, depth + 1)}</span>);
      }
    }
    return nodes;
  }

  return project(template.content, 0);
}

export function MarkdownCode({ value, language, theme }: { value: string; language: string; theme?: ThemeData | null }) {
  const visible = useContext(MarkdownVisibility);
  const block = useRef<HTMLPreElement>(null);
  const [nearby, setNearby] = useState(false);
  const [colored, setColored] = useState<{ value: string; language: string; theme?: ThemeData | null; nodes: ReactNode[] }>();
  const eligible = value.length <= 16 * 1024 && value.split('\n', 301).length <= 300;
  const matching = colored?.value === value && colored.language === language && colored.theme === theme;

  useEffect(() => {
    const element = block.current;
    if (!visible || !element || nearby || !eligible) return;
    let active = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (active && entry.isIntersecting) { observer.disconnect(); setNearby(true); }
    }, { root: element.closest('.markdown-preview'), rootMargin: '150px 0px' });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [eligible, nearby, visible]);

  useEffect(() => {
    if (!visible || !nearby || !eligible || matching) return;
    let active = true;
    void loadEditor().then(() => import('monaco-editor/editor/editor.api.js')).then(async ({ editor }) => {
      if (!active) return;
      const html = await editor.colorize(value, language, { tabSize: 4 });
      if (!active) return;
      const nodes = highlightedNodes(html);
      if (nodes) setColored({ value, language, theme, nodes });
    }).catch(() => { /* Plain code remains available if a grammar cannot load. */ });
    return () => { active = false; };
  }, [eligible, language, matching, nearby, theme, value, visible]);

  const nodes = matching ? colored.nodes : value;
  return <pre ref={block}><code data-language={language}>{nodes}</code></pre>;
}
