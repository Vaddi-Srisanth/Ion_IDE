import { useEffect, useState, type ComponentProps } from 'react';
import { maxMarkdownPreviewSourceLength } from '../shared/markdown-path';
import { errorMessage, type Documents } from './documents';
import type MarkdownPreview from './markdown/MarkdownPreview';

type Preview = typeof MarkdownPreview;

export function MarkdownPreviewPane({ documents, id, visible, ...props }: Omit<ComponentProps<Preview>, 'source'> & { documents: Documents; id: string }) {
  const [Preview, setPreview] = useState<Preview | null>(null);
  const [source, setSource] = useState<string>();
  const [sourceError, setSourceError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      const request = ++revision;
      try {
        const text = await documents.loadTextPrefix(id, maxMarkdownPreviewSourceLength + 2);
        if (active && request === revision) { setSource(text); setSourceError(undefined); }
      } catch (reason: unknown) {
        if (active && request === revision) setSourceError(errorMessage(reason));
      }
    }
    const unsubscribe = documents.subscribeText(id, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void read(), 100);
    });
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [documents, id, visible]);

  useEffect(() => {
    if (!visible || Preview) return;
    let active = true;
    void import('./markdown/MarkdownPreview').then((module) => {
      if (active) { setPreview(() => module.default); setLoadError(undefined); }
    }, (reason: unknown) => {
      if (active) setLoadError(errorMessage(reason));
    });
    return () => { active = false; };
  }, [visible, Preview]);

  if (!visible && (!Preview || source === undefined)) return null;
  const error = sourceError ?? loadError;
  return <div className="markdown-preview-pane" hidden={!visible}>
    {Preview && source !== undefined ? <Preview {...props} source={source} visible={visible}/>
      : <p className="editor-loading" role={error ? 'alert' : 'status'}>{error ?? 'Opening Markdown preview…'}</p>}
  </div>;
}
