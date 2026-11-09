import sax, { type QualifiedTag } from 'sax'
import { openZip, openZipBuffer, type DocumentZip } from './zip'

const forbiddenPart = /(?:^|\/)(?:activex|embeddings|macros|scripts|customui)(?:\/|$)|vbaproject|vbadata|\.bin$/
const forbiddenRelationship = /activex|oleobject|attachedtemplate|vbaproject|macro|script|embeddedpackage|dde|\/control$/
const chartWorkbook = /^ppt\/embeddings\/[^/]+\.xlsx$/
const printerSettings = /^(?:ppt|xl)\/printersettings\/[^/]+\.bin$/
const activePart = (name: string) => forbiddenPart.test(name) && !printerSettings.test(name)

function inspectXml(xml: string, visit: (tag: QualifiedTag) => void) {
  const options = { xmlns: true, strictEntities: true }
  const parser = sax.parser(true, options)
  let depth = 0
  parser.onopentag = (tag) => {
    if (++depth > 128) throw new Error('An Office XML part is too deeply nested.')
    if ('local' in tag) visit(tag)
  }
  parser.onclosetag = () => { depth-- }
  parser.write(xml).close()
}

function attribute(tag: QualifiedTag, key: string) {
  return Object.values(tag.attributes).find((value) => value.local === key && value.uri === '')?.value ?? ''
}

async function readXml(zip: DocumentZip, name: string): Promise<string> {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(await zip.read(name, 16 * 1024 * 1024))
  if (xml.includes('\0') || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('The presentation contains unsupported XML declarations.')
  }
  return xml
}

async function verifyChartData(bytes: Buffer) {
  const workbook = await openZipBuffer(bytes, 24 * 1024 * 1024)
  try {
    if (!workbook.has('xl/workbook.xml')) throw new Error('The chart data is not a workbook.')
    await workbook.verifyLocalHeaders()
    for (const name of workbook.names) {
      const lower = name.toLowerCase()
      if (activePart(lower) || /^xl\/(?:externallinks|connections|querytables)/.test(lower)) {
        throw new Error('The chart workbook contains active or external content.')
      }
      if (!/\.(?:xml|rels|vml)$/i.test(name)) continue
      inspectXml(await readXml(workbook, name), (tag) => {
        if (['f', 'ddeLink', 'oleLink', 'externalLink', 'externalReference'].includes(tag.local)
          || /macroEnabled|vbaProject|activeX|oleObject/i.test(attribute(tag, 'ContentType'))
          || attribute(tag, 'TargetMode').toLowerCase() === 'external'
          || forbiddenRelationship.test(attribute(tag, 'Type').toLowerCase())) {
          throw new Error('The chart workbook must contain static data without formulas or external resources.')
        }
      })
    }
  } finally {
    workbook.close()
  }
}

export async function verifyPresentation(path: string): Promise<void> {
  const zip = await openZip(path)
  try {
    if (!zip.has('[Content_Types].xml') || !zip.has('ppt/presentation.xml')) {
      throw new Error('This file is not a supported PowerPoint presentation.')
    }
    if (Array.from(zip.names).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length > 400) {
      throw new Error('PowerPoint previews support up to 400 slides.')
    }
    await zip.verifyLocalHeaders()
    for (const name of zip.names) {
      const lower = name.toLowerCase()
      if (chartWorkbook.test(lower)) {
        await verifyChartData(await zip.read(name, 8 * 1024 * 1024))
        continue
      }
      if (activePart(lower)) throw new Error('The presentation contains embedded active content.')
      if (!/\.(?:xml|rels|vml)$/.test(lower)) continue
      inspectXml(await readXml(zip, name), (tag) => {
        if (['oleObj', 'control', 'script'].includes(tag.local)
          || /macroEnabled|vbaProject|activeX|oleObject/i.test(attribute(tag, 'ContentType'))
          || /^ppaction:\/\/(?:program|macro|ole)/i.test(attribute(tag, 'action'))) {
          throw new Error('The presentation contains embedded active content.')
        }
        if (!lower.endsWith('.rels') || tag.local !== 'Relationship') return
        const type = attribute(tag, 'Type').toLowerCase()
        const target = attribute(tag, 'Target')
        if (forbiddenRelationship.test(type)) throw new Error('The presentation contains embedded active content.')
        if (type.endsWith('/package') && (!/^ppt\/charts\/_rels\/[^/]+\.xml\.rels$/.test(lower)
          || !/^\.\.\/embeddings\/[^/]+\.xlsx$/i.test(target))) {
          throw new Error('The presentation contains an unsupported embedded file.')
        }
        if (attribute(tag, 'TargetMode').toLowerCase() === 'external') {
          if (!type.endsWith('/hyperlink')) throw new Error('The presentation refers to an external resource.')
        } else if (/^[a-z][a-z0-9+.-]*:|^\/\/|\\/i.test(target)) {
          throw new Error('The presentation refers to an external resource.')
        }
      })
    }
  } finally {
    zip.close()
  }
}
