import { posix } from 'node:path'
import { parser, type QualifiedTag } from 'sax'
import type { WordBlock, WordImage, WordPage, WordParagraph, WordRun } from '../../shared/viewers'
import { openZip } from './zip'

const mainPart = 'word/document.xml'
const maxXmlBytes = 8 * 1024 * 1024
const maxImageBytes = 4 * 1024 * 1024
const maxImagePixels = 8_000_000
const pageBudget = 24_000
const wordNamespaces = [
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]
const relationshipNamespaces = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]
const drawingNamespaces = [
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]
const wordDrawingNamespaces = [
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
]
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'

function attr(tag: QualifiedTag, local: string, namespaces: readonly string[] = ['']): string | undefined {
  return Object.values(tag.attributes).find((value) => value.local === local && namespaces.includes(value.uri))?.value
}

function wordAttr(tag: QualifiedTag, local: string): string | undefined {
  return attr(tag, local, wordNamespaces)
}

function xml(
  bytes: Buffer,
  onOpen: (tag: QualifiedTag, depth: number) => void,
  onClose?: (tag: QualifiedTag, depth: number) => void,
  onText?: (text: string) => void,
) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  let source: string
  try {
    source = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Word preview contains invalid XML text encoding.')
  }
  const options = { xmlns: true, strictEntities: true }
  const reader = parser(true, options)
  const stack: QualifiedTag[] = []
  reader.onerror = () => { throw new Error('Word preview could not read malformed XML.') }
  reader.ondoctype = () => { throw new Error('Word preview does not accept XML document types or entities.') }
  reader.onopentag = (tag) => {
    if (stack.length >= 96) throw new Error('Word preview exceeded its XML nesting limit.')
    stack.push(tag as QualifiedTag)
    onOpen(tag as QualifiedTag, stack.length)
  }
  reader.onclosetag = () => {
    const depth = stack.length
    const tag = stack.pop()
    if (tag) onClose?.(tag, depth)
  }
  if (onText) {
    reader.ontext = onText
    reader.oncdata = onText
  }
  reader.write(source).close()
}

function builtInHeading(name: string | undefined): number | undefined {
  if (!name) return
  if (/^title$/i.test(name)) return 1
  const heading = /^heading ?([1-6])$/i.exec(name)
  return heading ? Number(heading[1]) : undefined
}

function outlineHeading(tag: QualifiedTag): number | undefined {
  const value = wordAttr(tag, 'val')
  return value && /^[0-8]$/.test(value) ? Math.min(6, Number(value) + 1) : undefined
}

function readStyles(bytes: Buffer) {
  interface HeadingStyle { heading?: number; base?: string }
  const styles = new Map<string, HeadingStyle>()
  let current: HeadingStyle | undefined
  xml(bytes, (tag) => {
    if (!wordNamespaces.includes(tag.uri)) return
    if (tag.local === 'style') {
      const id = wordAttr(tag, 'styleId')
      if (!id || wordAttr(tag, 'type') !== 'paragraph') return
      if (id.length > 128 || styles.size >= 2000) throw new Error('Word preview exceeded its style limit.')
      current = { heading: builtInHeading(id) }
      styles.set(id, current)
    } else if (current) {
      if (tag.local === 'name') current.heading ??= builtInHeading(wordAttr(tag, 'val'))
      if (tag.local === 'basedOn') current.base = wordAttr(tag, 'val')?.slice(0, 128)
      if (tag.local === 'outlineLvl') current.heading = outlineHeading(tag) ?? current.heading
    }
  }, (tag) => {
    if (wordNamespaces.includes(tag.uri) && tag.local === 'style') current = undefined
  })
  return (id: string | undefined) => {
    for (let depth = 0; id && depth < 16; depth++) {
      const style = styles.get(id)
      const heading = style?.heading ?? builtInHeading(id)
      if (heading) return heading
      id = style?.base
    }
  }
}

function readRelationships(bytes: Buffer) {
  const images = new Map<string, string>()
  xml(bytes, (tag) => {
    if (tag.uri !== packageNamespace || tag.local !== 'Relationship') return
    const kind = attr(tag, 'Type')
    const mode = attr(tag, 'TargetMode')
    if (mode && mode !== 'Internal' || !relationshipNamespaces.some((namespace) => kind === namespace + '/image')) return
    const id = attr(tag, 'Id')
    const target = attr(tag, 'Target')
    if (!id || id.length > 128 || !target || target.length > 1024) return
    let name: string
    try {
      const decoded = decodeURIComponent(target)
      if (/[\\%?#\u0000-\u001f\u007f]/u.test(decoded)) return
      name = decoded.startsWith('/') ? posix.normalize(decoded).slice(1) : posix.join('word', decoded)
    } catch {
      return
    }
    if (!name.startsWith('word/media/') || !/\.(?:png|jpe?g)$/i.test(name)) return
    if (images.size >= 1000) throw new Error('Word preview exceeded its image relationship limit.')
    if (!images.has(id)) images.set(id, name)
  })
  return images
}

function drawingPixels(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,10}$/.test(value)) return
  const pixels = Math.round(Number(value) / 9525)
  if (pixels > 0) return Math.min(pixels, 1800)
}

type WordPicture = Extract<WordBlock, { kind: 'image' }>
type Row = WordParagraph[][]
interface Table {
  rows: Row[]
  row: Row | null
  cell: WordParagraph[] | null
  cost: number
  rowCost: number
}
const unsupportedWordTags = new Set([
  'altChunk', 'object', 'pict', 'txbxContent', 'headerReference', 'footerReference',
  'footnoteReference', 'endnoteReference', 'numPr', 'fldSimple', 'instrText', 'gridSpan', 'vMerge',
])
const skippedWordTags = new Set(['altChunk', 'object', 'pict', 'txbxContent', 'del', 'moveFrom'])

function parseDocument(
  bytes: Buffer,
  relationships: Map<string, string>,
  hasImage: (path: string) => boolean,
  headingFor: (style: string | undefined) => number | undefined,
) {
  const pages: WordBlock[][] = [[]]
  const pictures = new Map<string, string>()
  let unsupported = false
  let validRoot = false
  let hasBody = false
  let bodyDepth = 0
  let skippedDepth = 0
  let currentCost = 0
  let currentImages = 0
  let totalRuns = 0
  let totalChars = 0
  let totalCells = 0
  let paragraph: WordParagraph | null = null
  let paragraphDepth = 0
  let style: string | undefined
  let run: WordRun | null = null
  let textDepth = 0
  let table: Table | null = null
  let drawing: { depth: number; relation?: string; alt?: string; width?: number; height?: number } | null = null

  const nextPage = () => {
    if (!pages.at(-1)?.length) return
    if (pages.length >= 250) throw new Error('Word preview exceeded its section limit.')
    pages.push([])
    currentCost = 0
    currentImages = 0
  }

  const addBlock = (block: WordBlock, cost: number) => {
    if (cost > pageBudget) throw new Error('A Word paragraph or table row exceeds preview limits.')
    if (pages.at(-1)!.length >= 30 || currentCost + cost > pageBudget || block.kind === 'image' && currentImages >= 2) nextPage()
    pages.at(-1)!.push(block)
    currentCost += cost
    if (block.kind === 'image') currentImages++
  }

  const appendText = (text: string) => {
    if (!run) return
    totalChars += text.length
    if (totalChars > 1_000_000 || run.text.length + text.length > 16_000) {
      throw new Error('Word preview exceeded its text limit.')
    }
    run.text += text
  }

  const flushRun = () => {
    if (!run?.text || !paragraph) return
    if (++totalRuns > 25_000) throw new Error('Word preview exceeded its text formatting limit.')
    paragraph.runs.push({ ...run })
    run.text = ''
  }

  const flushParagraph = (includeEmpty: boolean) => {
    if (!paragraph || !includeEmpty && !paragraph.runs.length) return
    const heading = paragraph.heading ?? headingFor(style)
    const content: WordParagraph = { kind: 'paragraph', ...(heading ? { heading } : {}), runs: paragraph.runs }
    const cost = 32 + content.runs.reduce((size, value) => size + value.text.length + 16, 0)
    if (table?.cell) {
      table.cell.push(content)
      table.rowCost += cost
      if (table.rowCost > pageBudget) throw new Error('A Word table row exceeds preview limits.')
    } else {
      addBlock(content, cost)
    }
    paragraph.runs = []
  }

  const flushTable = () => {
    if (!table?.rows.length) return
    addBlock({ kind: 'table', rows: table.rows }, table.cost)
    table.rows = []
    table.cost = 0
  }

  const finishDrawing = (current: NonNullable<typeof drawing>) => {
    const path = current.relation ? relationships.get(current.relation) : undefined
    if (!path || !hasImage(path) || table || !current.relation) {
      unsupported = true
      return
    }
    const id = current.relation
    pictures.set(id, path)
    flushRun()
    flushParagraph(false)
    const image: WordPicture = { kind: 'image', id, alt: current.alt ?? 'Embedded document image' }
    if (current.width) image.width = current.width
    if (current.height) image.height = current.height
    addBlock(image, 1024)
  }

  xml(bytes, (tag, depth) => {
    const isWord = wordNamespaces.includes(tag.uri)
    if (depth === 1) validRoot = isWord && tag.local === 'document'
    if (depth === 2 && validRoot && isWord && tag.local === 'body') {
      hasBody = true
      bodyDepth = depth
    }
    if (!bodyDepth || skippedDepth) return
    if (drawing) {
      if (drawingNamespaces.includes(tag.uri) && tag.local === 'blip') {
        drawing.relation = attr(tag, 'embed', relationshipNamespaces)
      }
      if (wordDrawingNamespaces.includes(tag.uri) && tag.local === 'docPr') {
        drawing.alt = (attr(tag, 'descr') || attr(tag, 'title') || attr(tag, 'name'))?.slice(0, 240)
      }
      if (wordDrawingNamespaces.includes(tag.uri) && tag.local === 'extent') {
        drawing.width = drawingPixels(attr(tag, 'cx'))
        drawing.height = drawingPixels(attr(tag, 'cy'))
      }
      return
    }
    if (!isWord) return
    if (unsupportedWordTags.has(tag.local)) unsupported = true
    if (skippedWordTags.has(tag.local) || tag.local === 'tbl' && table) {
      skippedDepth = depth
      unsupported = true
      return
    }
    switch (tag.local) {
      case 'tbl':
        table = { rows: [], row: null, cell: null, cost: 0, rowCost: 0 }
        break
      case 'tr':
        if (table) {
          table.row = []
          table.rowCost = 64
        }
        break
      case 'tc':
        if (table?.row) {
          if (++totalCells > 20_000 || table.row.length >= 64) throw new Error('Word preview exceeded its table size limit.')
          table.cell = []
          table.rowCost += 32
        }
        break
      case 'p':
        if (table && !table.cell || paragraph) break
        paragraphDepth = depth
        paragraph = { kind: 'paragraph', runs: [] }
        style = undefined
        break
      case 'pStyle':
        style = wordAttr(tag, 'val')
        break
      case 'outlineLvl':
        if (paragraph) paragraph.heading = outlineHeading(tag)
        break
      case 'r':
        if (paragraph) run = { text: '' }
        break
      case 'b':
      case 'i':
      case 'u': {
        const value = wordAttr(tag, 'val')
        if (run && value !== 'false' && value !== 'off' && value !== '0' && value !== 'none') {
          const property = tag.local === 'b' ? 'bold' : tag.local === 'i' ? 'italic' : 'underline'
          run[property] = true
        }
        break
      }
      case 't':
        if (run) textDepth = depth
        break
      case 'br':
        if (wordAttr(tag, 'type') === 'page' && !table) {
          flushRun()
          flushParagraph(false)
          nextPage()
        } else {
          appendText('\n')
        }
        break
      case 'cr':
        appendText('\n')
        break
      case 'tab':
        appendText('\t')
        break
      case 'noBreakHyphen':
        appendText('\u2011')
        break
      case 'drawing':
        drawing = { depth }
        break
    }
  }, (tag, depth) => {
    if (skippedDepth) {
      if (depth === skippedDepth) skippedDepth = 0
      return
    }
    if (drawing) {
      if (depth === drawing.depth) {
        finishDrawing(drawing)
        drawing = null
      }
      return
    }
    if (!wordNamespaces.includes(tag.uri) || !bodyDepth) return
    if (depth === textDepth) textDepth = 0
    if (depth === bodyDepth) bodyDepth = 0
    switch (tag.local) {
      case 'r':
        flushRun()
        run = null
        break
      case 'p':
        if (depth === paragraphDepth) {
          flushParagraph(true)
          paragraph = null
          paragraphDepth = 0
        }
        break
      case 'tc':
        if (table?.row && table.cell) {
          table.row.push(table.cell)
          table.cell = null
        }
        break
      case 'tr':
        if (table?.row?.length) {
          if (table.rows.length >= 14 || table.cost + table.rowCost > pageBudget) flushTable()
          table.rows.push(table.row)
          table.cost += table.rowCost
          table.row = null
        }
        break
      case 'tbl':
        flushTable()
        table = null
        break
    }
  }, (text) => {
    if (textDepth && !skippedDepth) appendText(text)
  })
  if (!validRoot || !hasBody) throw new Error('The package does not contain a supported Word document body.')
  if (pages.length > 1 && !pages.at(-1)?.length) pages.pop()
  return { pages, pictures, unsupported }
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const jpegFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function validateImageDimensions(width: number, height: number) {
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > maxImagePixels) {
    throw new Error('The embedded image exceeds the Word preview dimensions limit.')
  }
}

function rasterMime(bytes: Buffer): WordImage['mime'] {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature)
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    validateImageDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      const kind = bytes.toString('ascii', offset + 4, offset + 8)
      const next = offset + length + 12
      if (next > bytes.length) break
      if (kind === 'acTL') throw new Error('Animated images are omitted from Word previews.')
      if (kind === 'IEND') return 'image/png'
      offset = next
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if (jpegFrameMarkers.has(marker) && length >= 8) {
        validateImageDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
        return 'image/jpeg'
      }
      offset += length
    }
  }
  throw new Error('Word preview can display static PNG and JPEG images.')
}

export interface WordDocument {
  page(index: number): WordPage
  image(id: string): Promise<WordImage>
  close(): void
}

export async function openWord(path: string): Promise<WordDocument> {
  const zip = await openZip(path)
  try {
    const relationshipsPart = 'word/_rels/document.xml.rels'
    const stylesPart = 'word/styles.xml'
    const relationships = zip.has(relationshipsPart)
      ? readRelationships(await zip.read(relationshipsPart, 2 * 1024 * 1024)) : new Map<string, string>()
    const headingFor = zip.has(stylesPart)
      ? readStyles(await zip.read(stylesPart, 2 * 1024 * 1024)) : builtInHeading
    const { pages, pictures, unsupported } = parseDocument(
      await zip.read(mainPart, maxXmlBytes), relationships, (name) => zip.has(name), headingFor,
    )
    let closed = false
    return {
      page(index) {
        if (closed || !Number.isInteger(index) || index < 0 || index >= pages.length) {
          throw new Error('This Word preview section is unavailable.')
        }
        return { blocks: pages[index], pageCount: pages.length, unsupported }
      },
      async image(id) {
        const name = closed ? undefined : pictures.get(id)
        if (!name) throw new Error('This image is not part of the Word preview.')
        const bytes = await zip.read(name, maxImageBytes)
        if (closed) throw new Error('This Word preview has closed.')
        return { bytes, mime: rasterMime(bytes) }
      },
      close() {
        if (closed) return
        closed = true
        pages.length = 0
        pictures.clear()
        zip.close()
      },
    }
  } catch (error) {
    zip.close()
    throw error
  }
}
