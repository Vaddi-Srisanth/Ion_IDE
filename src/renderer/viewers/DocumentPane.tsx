import { useEffect, useState, type ReactNode } from 'react';
import type { DocumentFormat, ViewerSession } from '../../shared/viewers';
import { errorMessage } from '../documents';
import { Icon } from '../icons';

async function viewerFor(session: ViewerSession): Promise<ReactNode> {
  switch (session.format) {
    case 'pdf':
    case 'pptx': {
      const { default: Viewer } = await import('./PagedViewer');
      return <Viewer session={session}/>;
    }
    case 'docx': {
      const { default: Viewer } = await import('./WordViewer');
      return <Viewer session={session}/>;
    }
    case 'csv':
    case 'xlsx': {
      const { default: Viewer } = await import('./TableViewer');
      return <Viewer session={session}/>;
    }
  }
}

export function DocumentPane({ path, name, format, pinned, onPin }: {
  path: string;
  name: string;
  format: DocumentFormat;
  pinned: boolean;
  onPin(): void;
}) {
  const [preview, setPreview] = useState<ReactNode>(null);
  const [failure, setFailure] = useState('');
  const [externalError, setExternalError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = crypto.randomUUID();
    let current = true;
    let sessionId: string | undefined;
    const bridge = window.ion.viewers;
    const close = (id: string) => { void bridge.close(id).catch(() => {}); };
    void bridge.open(path, request).then(async (session) => {
      if (!current) { close(session.id); return; }
      sessionId = session.id;
      const node = await viewerFor(session);
      if (current) setPreview(node);
    }).catch((reason: unknown) => {
      if (!current) return;
      if (sessionId) close(sessionId);
      setFailure(errorMessage(reason));
    });
    return () => {
      current = false;
      if (sessionId) close(sessionId);
      else void bridge.cancel(request).catch(() => {});
    };
  }, [path, attempt]);

  return <section className="document-pane" data-testid="document-viewer" data-format={format} aria-label={`${name} preview`}>
    <div className="document-toolbar">
      <div className="document-title" title={name}><Icon name="file" size={15}/><strong>{name}</strong>
        <span className="document-readonly">Read only</span></div>
      <div className="document-actions">
        <button className="button" data-testid="viewer-split" aria-pressed={pinned}
          title={pinned ? 'Remove from split view' : 'Keep this document beside a code tab'} onClick={onPin}>
          {pinned ? 'Unpin' : 'Split View'}
        </button>
        <button className="button" data-testid="viewer-external" onClick={() => {
          setExternalError('');
          void window.ion.viewers.openExternal(path).catch((reason: unknown) => setExternalError(errorMessage(reason)));
        }}>Open in Default Application</button>
      </div>
    </div>
    {externalError && <p className="document-external-error" role="alert">{externalError}</p>}
    {preview ?? <div className="editor-loading document-placeholder" role={failure ? 'alert' : 'status'}>
      {failure ? <>
        <strong>Preview unavailable</strong>
        <p data-testid="viewer-error">{failure}</p>
        <button className="button" onClick={() => { setFailure(''); setAttempt((value) => value + 1); }}>Retry Preview</button>
      </> : format === 'pptx' ? 'Converting slides locally…' : 'Opening document…'}
    </div>}
  </section>;
}
