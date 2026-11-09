import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { TableMatch, TablePage, TableViewerSession } from '../../shared/viewers';
import { errorMessage } from '../documents';
import './table-viewer.css';

const pageRows = 50;
const pageColumns = 12;

function columnLabel(index: number): string {
  let label = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
    label = String.fromCharCode(65 + (number - 1) % 26) + label;
  }
  return label;
}

function parseCellAddress(address: string): TableMatch | undefined {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address.trim().toUpperCase());
  if (!match) return undefined;
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, column: column - 1 };
}

function isMatch(left: TableMatch | null, row: number, column: number) {
  return left?.row === row && left.column === column;
}

type Position = { sheetId: string; rowOffset: number; columnOffset: number };
type PageResult = { key: string; data: TablePage } | { key: string; error: string };

function rangeLabel(offset: number, count: number, size: number, label: (index: number) => string): string {
  if (!count) return '—';
  const start = label(offset);
  const end = label(Math.min(offset + size, count) - 1);
  return start === end ? start : start + '–' + end;
}

export default function TableViewer({ session }: { session: TableViewerSession }) {
  const [position, setPosition] = useState<Position>(() => ({
    sheetId: session.sheets[0]?.id ?? '',
    rowOffset: 0,
    columnOffset: 0,
  }));
  const [result, setResult] = useState<PageResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [queryPending, setQueryPending] = useState(false);
  const [message, setMessage] = useState('');
  const [match, setMatch] = useState<TableMatch | null>(null);
  const [jumpAddress, setJumpAddress] = useState('');
  const [zoom, setZoom] = useState(100);
  const scroller = useRef<HTMLDivElement>(null);
  const matchedCell = useRef<HTMLTableCellElement>(null);
  const searchGeneration = useRef(0);
  const { sheetId, rowOffset, columnOffset } = position;
  const pageKey = [session.id, sheetId, rowOffset, columnOffset, attempt].join('/');
  const current = result?.key === pageKey ? result : null;
  const data = current && 'data' in current ? current.data : undefined;
  const totalRows = data?.rowCount ?? 0;
  const totalColumns = data?.columnCount ?? 0;

  useEffect(() => {
    let current = true;
    if (!sheetId) return;
    void window.ion.viewers.tablePage(session.id, sheetId, rowOffset, columnOffset, pageRows, pageColumns).then(
      (data) => { if (current) setResult({ key: pageKey, data }); },
      (reason: unknown) => { if (current) setResult({ key: pageKey, error: errorMessage(reason) }); },
    );
    return () => { current = false; };
  }, [session.id, sheetId, rowOffset, columnOffset, pageKey]);

  useEffect(() => () => { searchGeneration.current++; }, []);

  useEffect(() => {
    if (data) scroller.current?.scrollTo(0, 0);
  }, [data]);

  useEffect(() => {
    if (data && match) matchedCell.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [data, match]);

  function selectSheet(id: string) {
    searchGeneration.current++;
    setQueryPending(false);
    setMessage('');
    setMatch(null);
    setJumpAddress('');
    setPosition({ sheetId: id, rowOffset: 0, columnOffset: 0 });
  }

  function revealCell(cell: TableMatch) {
    const row = Math.floor(cell.row / pageRows) * pageRows;
    const column = Math.floor(cell.column / pageColumns) * pageColumns;
    setPosition({ sheetId, rowOffset: row, columnOffset: column });
    setMatch(cell);
  }

  async function findNext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query || !sheetId || queryPending) return;
    const generation = ++searchGeneration.current;
    setQueryPending(true);
    setMessage('');
    try {
      const found = await window.ion.viewers.tableSearch(session.id, sheetId, query, match ?? undefined);
      if (generation !== searchGeneration.current) return;
      if (found) {
        revealCell(found);
        setMessage('Found ' + columnLabel(found.column) + (found.row + 1) + '.');
      } else {
        setMatch(null);
        setMessage('No matching cells.');
      }
    } catch (reason) {
      if (generation === searchGeneration.current) setMessage(errorMessage(reason));
    } finally {
      if (generation === searchGeneration.current) setQueryPending(false);
    }
  }

  function jump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cell = parseCellAddress(jumpAddress);
    if (!cell || cell.row >= totalRows || cell.column >= totalColumns) {
      setMessage('Enter a cell address within the current sheet.');
      return;
    }
    revealCell(cell);
    setMessage('Showing ' + columnLabel(cell.column) + (cell.row + 1) + '.');
  }

  const columns = Math.min(pageColumns, Math.max(0, totalColumns - columnOffset));
  const rowHeaderWidth = Math.round(60 * zoom / 100);
  const columnWidth = Math.round(150 * zoom / 100);
  const gridStyle = {
    width: rowHeaderWidth + columns * columnWidth,
    '--table-font-size': 12 * zoom / 100 + 'px',
    '--table-row-height': 27 * zoom / 100 + 'px',
  } as CSSProperties;
  return (
    <section className="table-viewer" data-testid="table-viewer" aria-label={session.format === 'xlsx' ? 'Excel preview' : 'CSV preview'}>
      <div className="table-viewer-tools">
        {session.format === 'xlsx' && <label>
          <span>Worksheet</span>
          <select value={sheetId} onChange={(event) => selectSheet(event.target.value)} data-testid="table-sheet-select">
            {session.sheets.map((sheet) => <option value={sheet.id} key={sheet.id}>{sheet.name}</option>)}
          </select>
        </label>}
        <form onSubmit={(event) => void findNext(event)} role="search" aria-label="Find in sheet">
          <input type="search" aria-label="Find cell text" placeholder="Find cell text" data-testid="table-search" data-viewer-search=""
            value={query} maxLength={160} onChange={(event) => {
              searchGeneration.current++;
              setQueryPending(false);
              setQuery(event.target.value);
              setMatch(null);
              setMessage('');
            }}/>
          <button className="button" data-testid="table-find-next" disabled={!query || !data || queryPending}>
            {queryPending ? 'Searching…' : 'Find next'}
          </button>
        </form>
        <div className="table-viewer-page" role="group" aria-label="Table zoom">
          <button type="button" className="button" aria-label="Zoom out" disabled={zoom === 75}
            onClick={() => setZoom((value) => value - 25)}>−</button>
          <button type="button" className="button table-viewer-zoom" aria-label="Reset table zoom" title="Reset table zoom"
            onClick={() => setZoom(100)}>{zoom}%</button>
          <button type="button" className="button" aria-label="Zoom in" disabled={zoom === 150}
            onClick={() => setZoom((value) => value + 25)}>+</button>
        </div>
      </div>
      <div className="table-viewer-scroller" ref={scroller} tabIndex={0} aria-label="Read-only cells" aria-busy={!current && Boolean(sheetId)}>
        {!sheetId && <p className="table-viewer-state">No readable worksheets were found.</p>}
        {sheetId && !current && <p className="table-viewer-state" role="status">Loading sheet…</p>}
        {current && 'error' in current && <div className="table-viewer-state" role="alert">
          <p>{current.error}</p>
          <button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
        </div>}
        {data && (!totalRows || !totalColumns) && <p className="table-viewer-state">This sheet is empty.</p>}
        {data && totalRows > 0 && totalColumns > 0 && <table className="table-viewer-grid" data-testid="table-grid"
          aria-label={session.sheets.find(({ id }) => id === sheetId)?.name} style={gridStyle}>
          <colgroup><col style={{ width: rowHeaderWidth }}/>{Array.from({ length: columns }, (_, index) => <col style={{ width: columnWidth }} key={index}/>)}</colgroup>
          <thead><tr>
            <th scope="col">Row</th>
            {Array.from({ length: columns }, (_, index) => <th scope="col" key={index}>{columnLabel(columnOffset + index)}</th>)}
          </tr></thead>
          <tbody>{data.cells.map((row, index) => (
            <tr key={rowOffset + index}>
              <th scope="row">{rowOffset + index + 1}</th>
              {row.map((value, column) => {
                const selected = isMatch(match, rowOffset + index, columnOffset + column);
                return <td key={column} title={value || undefined} ref={selected ? matchedCell : undefined}
                  className={selected ? 'table-viewer-match' : undefined}>{value}</td>;
              })}
            </tr>
          ))}</tbody>
        </table>}
      </div>
      <div className="table-viewer-footer">
        <div className="table-viewer-page">
          <button type="button" className="button" aria-label="Previous rows" disabled={!data || !rowOffset}
            onClick={() => setPosition({ ...position, rowOffset: rowOffset - pageRows })}>‹</button>
          <span>Rows {rangeLabel(rowOffset, totalRows, pageRows, (index) => (index + 1).toLocaleString())} / {totalRows.toLocaleString()}</span>
          <button type="button" className="button" aria-label="Next rows" data-testid="table-next-rows"
            disabled={!data || rowOffset + pageRows >= totalRows}
            onClick={() => setPosition({ ...position, rowOffset: rowOffset + pageRows })}>›</button>
        </div>
        <div className="table-viewer-page">
          <button type="button" className="button" aria-label="Previous columns" disabled={!data || !columnOffset}
            onClick={() => setPosition({ ...position, columnOffset: columnOffset - pageColumns })}>‹</button>
          <span>Columns {rangeLabel(columnOffset, totalColumns, pageColumns, columnLabel)} / {totalColumns ? columnLabel(totalColumns - 1) : '—'}</span>
          <button type="button" className="button" aria-label="Next columns" data-testid="table-next-columns"
            disabled={!data || columnOffset + pageColumns >= totalColumns}
            onClick={() => setPosition({ ...position, columnOffset: columnOffset + pageColumns })}>›</button>
        </div>
        <form onSubmit={jump} className="table-viewer-jump">
          <input type="text" aria-label="Go to cell address" placeholder="A1" value={jumpAddress} maxLength={10}
            onChange={(event) => setJumpAddress(event.target.value)}/>
          <button className="button" disabled={!data || !jumpAddress}>Go to cell</button>
        </form>
      </div>
      {message && <p role="status" className="table-viewer-message">{message}</p>}
    </section>
  );
}
