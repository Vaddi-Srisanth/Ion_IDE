import { encodeFixtureZip } from './viewer-zip'

const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relationshipPart = 'http://schemas.openxmlformats.org/package/2006/relationships'

export const quotedCsv = 'Title,Notes,Value\r\n"Course, spring","Line one\nLine two",42\r\n"She said ""hi""",plain,=1+1\r\n'

export const largeCsv = (count: number) => 'Index,Item,Status\n' + Array.from({ length: count }, (_, index) =>
  (index + 1) + ',Assignment ' + (index + 1) + ',' + (index === count - 1 ? 'Final checkpoint' : 'Waiting'),
).join('\n')

export function workbookFixture(sheet2?: string): Buffer {
  return encodeFixtureZip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '</Types>',
    '_rels/.rels': '<Relationships xmlns="' + relationshipPart + '"><Relationship Id="rId1" Type="' + relationships
      + '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns="' + namespace + '" xmlns:r="' + relationships
      + '"><sheets><sheet name="Courses" sheetId="1" r:id="rId1"/><sheet name="Assignments" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="' + relationshipPart + '">'
      + '<Relationship Id="rId1" Type="' + relationships + '/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="' + relationships + '/worksheet" Target="/xl/worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId3" Type="' + relationships + '/sharedStrings" Target="sharedStrings.xml"/>'
      + '<Relationship Id="rId4" Type="' + relationships + '/externalLink" Target="https://example.invalid/never" TargetMode="External"/>'
      + '</Relationships>',
    'xl/sharedStrings.xml': '<sst xmlns="' + namespace + '"><si><t>Operating Systems</t></si>'
      + '<si><r><t xml:space="preserve">Data </t></r><r><t>Structures</t></r><rPh sb="0" eb="1"><t>phonetic</t></rPh></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="' + namespace + '"><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="b"><v>1</v></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><f>10+20</f><v>30</v></c><c r="C3"><f>1+1</f><v></v></c></row>'
      + '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': sheet2 ?? '<worksheet xmlns="' + namespace + '"><sheetData>'
      + '<row r="2"><c r="B2" t="inlineStr"><is><r><t xml:space="preserve">Project </t></r><r><t>deadline</t></r></is></c></row>'
      + '<row r="410"><c r="AC410"><v>99</v></c></row>'
      + '</sheetData></worksheet>',
  })
}
