import { useMemo, useState } from 'react'
import type { SourceControlBlame } from '../../shared/source-control'
import { Modal } from '../Dialogs'

export type LineHistoryState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SourceControlBlame }

export default function LineHistory({ path, review, dirty, changed, onClose }: {
  path: string; review: LineHistoryState; dirty: boolean; changed: boolean; onClose(): void
}) {
  return <Modal title="Line history" className="git-line-history" onClose={onClose}>
    <p className="git-line-path" dir="auto">{path}</p>
    <p>Line numbers refer to the committed file at HEAD.
      {dirty ? ' Unsaved edits can place these lines elsewhere in the editor.' : changed ? ' Local changes can shift the lines in your working file.' : ''}</p>
    {review.kind === 'loading' && <p role="status">Reading committed line history…</p>}
    {review.kind === 'error' && <p role="alert">{review.message}</p>}
    {review.kind === 'ready' && <CommittedRanges data={review.data}/>}
    <button className="button" type="button" onClick={onClose}>Done</button>
  </Modal>
}

function CommittedRanges({ data }: { data: SourceControlBlame }) {
  const [visible, setVisible] = useState(40)
  const dates = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }), [])
  const limit = Math.min(200, data.ranges.length)
  return <>
    <p>HEAD <code title={data.head}>{data.head.slice(0, 10)}</code></p>
    {limit > 0 ? <ol className="git-line-ranges" aria-label="Committed line ranges" tabIndex={0}>
      {data.ranges.slice(0, Math.min(visible, limit)).map(range => {
        const date = new Date(range.time * 1000)
        return <li key={range.start}>
          <span className="git-line-number">{range.count === 1 ? 'Line ' + range.start : 'Lines ' + range.start + '–' + (range.start + range.count - 1)}</span>
          <div><span className="git-line-subject" dir="auto">{range.subject || '(No subject)'}</span>
            <div className="git-browser-metadata">
              <code title={range.oid}>{range.oid.slice(0, 10)}</code>
              <span dir="auto">{range.author || 'Unknown author'}</span>
              {Number.isFinite(date.getTime()) && <time dateTime={date.toISOString()}>{dates.format(date)}</time>}
            </div>
          </div>
        </li>
      })}
    </ol> : <p role="status">{data.truncated ? 'No committed ranges are available in this preview.' : 'This committed file has no lines.'}</p>}
    {visible < limit && <button type="button" className="button" onClick={() => setVisible(n => n + 40)}>Show more ranges</button>}
    {(data.truncated || limit < data.ranges.length) && <p>Some committed history is outside the preview limits.</p>}
  </>
}
