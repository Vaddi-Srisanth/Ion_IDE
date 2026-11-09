import { parentPort } from 'node:worker_threads'
import type { TableMatch } from '../../shared/viewers'
import type { TableDocument } from './tables'
import type { WordDocument } from './word'

export type DocumentCommand =
  | { kind: 'open-table'; path: string; format: 'csv' | 'xlsx' }
  | { kind: 'open-word' | 'verify-presentation'; path: string }
  | { kind: 'table-page'; sheet: string; row: number; column: number; rows: number; columns: number }
  | { kind: 'table-search'; sheet: string; query: string; after?: TableMatch }
  | { kind: 'word-page'; page: number }
  | { kind: 'word-image'; image: string }

let table: TableDocument | undefined
let word: WordDocument | undefined

async function handle(command: DocumentCommand) {
  switch (command.kind) {
    case 'open-table': {
      const { openTable } = await import('./tables')
      table = await openTable(command.path, command.format)
      return table.sheets
    }
    case 'open-word': {
      const { openWord } = await import('./word')
      word = await openWord(command.path)
      return null
    }
    case 'verify-presentation': {
      const { verifyPresentation } = await import('./verify-presentation')
      await verifyPresentation(command.path)
      return null
    }
    case 'table-page':
      if (table) return table.page(command.sheet, command.row, command.column, command.rows, command.columns)
      break
    case 'table-search':
      if (table) return table.search(command.sheet, command.query, command.after)
      break
    case 'word-page':
      if (word) return word.page(command.page)
      break
    case 'word-image':
      if (word) return word.image(command.image)
      break
  }
  throw new Error('This preview is no longer open.')
}

const port = parentPort
let operations = Promise.resolve()
port?.on('message', ({ id, command }: { id: number; command: DocumentCommand }) => {
  operations = operations.then(async () => {
    try {
      port.postMessage({ id, value: await handle(command) })
    } catch (error) {
      const detail = error instanceof Error && !('code' in error)
        ? error.message.slice(0, 350)
        : 'The document could not be read. It may be damaged or use an unsupported format.'
      port.postMessage({ id, error: detail })
    }
  })
})
