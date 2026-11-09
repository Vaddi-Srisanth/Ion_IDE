export function pdfFixture(pageCount) {
  const kids = Array.from({ length: pageCount }, (_, index) => `${4 + 2 * index} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (let index = 0; index < pageCount; index++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 640]
      /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * index} 0 R >>`)
    const unique = index === 1 ? 'Process topology' : 'Resource management'
    const payload = `q 0.82 0.2 0.24 rg 38 400 140 120 re f Q
q 0.16 0.34 0.78 rg 220 400 140 120 re f Q
BT /F1 26 Tf 40 550 Td (Chapter ${index + 1} - ${unique}) Tj ET
` + `%${'x'.repeat(90)}\n`.repeat(pageCount <= 3 ? 900 : 90)
    objects.push(`<< /Length ${Buffer.byteLength(payload)} >>\nstream\n${payload}endstream`)
  }
  const chunks = ['%PDF-1.4\n']
  const offsets = ['0000000000 65535 f \n']
  let offset = Buffer.byteLength(chunks[0])
  for (const [index, content] of objects.entries()) {
    offsets.push(`${String(offset).padStart(10, '0')} 00000 n \n`)
    const object = `${index + 1} 0 obj\n${content}\nendobj\n`
    chunks.push(object)
    offset += Buffer.byteLength(object)
  }
  chunks.push(`xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`)
  return Buffer.from(chunks.join(''))
}
