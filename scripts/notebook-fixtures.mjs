import { deflateSync } from 'node:zlib'

const dataframe = `<table border="1" class="dataframe">
  <thead>
    <tr style="text-align: right;">
      <th></th>
      <th>Module</th>
      <th>Score</th>
    </tr>
  </thead>
  <tbody>
    <tr><th>0</th><td>Ion notebooks</td><td>98</td></tr>
    <tr><th>1</th><td>Python practice</td><td>86</td></tr>
  </tbody>
</table>`

const savedJpeg = [
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAoAFADASIAAhEBAxEB/',
  '8QAGgABAAMBAQEAAAAAAAAAAAAAAAIEBQMGB//EACoQAAIBAwMDBAICAwAAAAAAAAECAwAEEQUGIRIxQRMUFVEishYyI2HB/8QAGAEBAQADAAAAAAAAAAAAAAAAAAIBAwT/xAAgEQACAQMEAwAAAAAAAAAAAAAAAQIDESESMUHRIlHw/9oADAMBAAIRAxEAPwD5JSlK7zlFKUoBSlKAUre25tz5f1r6+n9no9pzc3Tfon2xyPvGR3JAM7jccFpdXH8e02DTY2bEc56pLgL0leHZj0E9RP4YPYZOM0NbnnTFXZVtdt6jPb+7uEWwsukMLq8JjRgVLDp4y5IU4CgntVC9hgt7pore6W6jCr/mRGUElQSAGAOAcjJAzjOKhc3NxeTtPdTyzzPjqklcsxwMDJPPYVyoUlLdsVYsrK51K9is7OFpriVulEXuT/weSewFcoopJ5UiiRpJHYKiIMlieAAPJr2VwW2JpElnDdL/',
  'ACK+VRcGMAmzhwT0B/DtkE48DjGFYiZzthbsjfNoW1Ei0o2NtrOoB+q/mkZgkfBUxRkYIIDH8vBwcZACV59t2Otrc3m1blpfTUyvpk6lZ41zj8DyJB3PByB0jkmvKVOKWSCVJYnaORGDI6HBUjkEHwaGFTaynn7joSxSQSvFKjRyIxV0cYKkcEEeDW3tzbny/rX19P7PR7Tm5um/RPtjkfeMjuSAdCDcWl685i3ZaZlbAXU7NAkwORn1AOGAUAf1JAHAJOaz9x7j+X9GxsYPZ6PacW1qv7v9scn7xk9ySSMOVSXjaz99Dce4/l/RsbGD2ej2nFtar+7/AGxyfvGT3JJODSlDZGKirIUpShRvaBr9vt+0u54LPr1h8JbXMhDJAhB6iFx/b/fPfwAQ2JLLJPK8srtJI7FndzksTyST5NKUJUUm3yyFKUoUKUpQClKUApSlAf/Z',
].join('')

const savedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80">
  <title>Saved SVG plot</title>
  <rect width="160" height="80" fill="#dce7f0"/>
  <path d="M 10 67 L 48 31 L 82 49 L 115 26 L 148 10" fill="none" stroke="#367caa" stroke-width="3"/>
</svg>`

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value
})

function pngChunk(name, data) {
  const chunk = Buffer.allocUnsafe(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(name, 4, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (let i = 4; i < chunk.length - 4; i++) crc = crcTable[(crc ^ chunk[i]) & 255] ^ (crc >>> 8)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

export function savedPlotPng(width, height, seed = 1, noisy = false) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const stride = width * 3 + 1
  const scanlines = Buffer.alloc(stride * height)
  let random = seed
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * stride + x * 3 + 1
      const chart = height * (0.5 - 0.29 * Math.sin(x / width * 7 + seed))
      const line = Math.abs(y - chart) < 2
      random ^= random << 13
      random ^= random >>> 17
      random ^= random << 5
      scanlines[offset] = line ? 45 : 220 - (noisy ? random & 127 : 0)
      scanlines[offset + 1] = line ? 108 : 232 - (noisy ? (random >>> 8) & 127 : 0)
      scanlines[offset + 2] = line ? 167 : 246 - (noisy ? (random >>> 16) & 127 : 0)
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 1 })), pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const kernelMetadata = {
  kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' },
  language_info: { name: 'python', file_extension: '.py', mimetype: 'text/x-python' },
}

const code = (id, source, outputs = [], count = null) => ({
  cell_type: 'code', id, metadata: {}, source, outputs, execution_count: count,
})
const markdown = (id, source) => ({ cell_type: 'markdown', id, metadata: {}, source })
const display = (data) => ({ output_type: 'display_data', metadata: {}, data })

export const encodeNotebook = (notebook) => JSON.stringify(notebook, null, 1) + '\n'

export function smallNotebook({ markerPath } = {}) {
  const attack = '<div><strong>Inert HTML fixture</strong>'
    + '<script>window.ionNotebookActive = true</script>'
    + '<iframe src="https://example.invalid/ion-notebook-frame"></iframe>'
    + '<img src="https://example.invalid/ion-notebook-image" onerror="window.ionNotebookActive = true">'
    + '<form action="https://example.invalid/ion-notebook-form"><button>Unsafe submit</button></form>'
    + '<style>@import url(https://example.invalid/ion-notebook-style)</style></div>'
  const hostileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" '
    + 'onload="window.ionNotebookActive = true"><script>window.ionNotebookActive = true</script>'
    + '<image href="https://example.invalid/ion-notebook-svg-image" width="30" height="30"/></svg>'
  const streamSource = [
    ...(markerPath ? ['from pathlib import Path\n', `Path(${JSON.stringify(markerPath)}).write_text('ran')\n`] : []),
    'print("Visible standard output")\n', 'raise ValueError("Visible Python traceback")\n',
  ]
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { ionFixture: 'ion-notebook-fixture-a', ...kernelMetadata, experimental: { revision: 2, flags: ['keep'] } },
    cells: [
      markdown('introduction', ['# Notebook study fixture\n', '\n', 'Read **saved Markdown** and `inline code` offline.\n']),
      code('dataframe', ['import pandas as pd\n', 'frame = pd.DataFrame(data)\n', 'frame'], [{
        output_type: 'execute_result', execution_count: 7, metadata: { isolated: true },
        data: { 'text/plain': 'A saved Pandas DataFrame', 'text/html': dataframe },
      }], 7),
      code('plots', 'display(saved_charts)', [
        display({ 'image/png': savedPlotPng(144, 72).toString('base64') }),
        display({ 'image/jpeg': savedJpeg }),
        display({ 'image/svg+xml': savedSvg }),
      ], 8),
      code('streams', streamSource, [
        { output_type: 'stream', name: 'stdout', text: ['Visible standard output\n'] },
        { output_type: 'stream', name: 'stderr', text: 'Visible standard error\n' },
        { output_type: 'error', ename: 'ValueError', evalue: 'Visible Python traceback',
          traceback: ['\u001b[31mTraceback (most recent call last)\u001b[0m', 'ValueError: Visible Python traceback'] },
      ], 9),
      { cell_type: 'raw', id: 'raw-notes', metadata: { raw_mimetype: 'text/plain' }, source: 'Raw cell <em>stays literal</em>' },
      code('inert-content', 'display(suspicious_result)', [
        display({ 'text/html': attack }),
        display({ 'image/svg+xml': hostileSvg, 'text/plain': 'Inert SVG fallback' }),
        display({ 'application/vnd.ion.unknown+json': { stable: [1, 2, 3] }, 'text/plain': 'Unknown MIME text fallback' }),
        { output_type: 'ion_unknown', payload: { preserve: true } },
      ]),
    ],
  }
}

export function editableNotebook() {
  const picture = savedPlotPng(90, 50).toString('base64')
  const notebook = {
    nbformat: 4, nbformat_minor: 5,
    metadata: { ...kernelMetadata, course: 'preserve this', calibration: 'numeric fixture', extra: { keep: [1, 2] } },
    cells: [
      { ...code('editable-code', ['original_value = 7\n', 'print(original_value)'], [
        display({ 'application/vnd.ion.future+json': { chart: ['red', 'blue'] } }),
        { output_type: 'ion_unknown', payload: { preserve: true } },
      ], 5), metadata: { ionFrozen: true, tags: ['review'] } },
      { ...markdown('editable-markdown', '# Original notebook note\n\n![Saved attachment](attachment:chart.png)'),
        attachments: { 'chart.png': { 'image/png': picture } }, metadata: { custom: 'Keep this' } },
      { cell_type: 'raw', id: 'editable-raw', metadata: { 'legacy-cell-marker': true }, source: ['Leave the raw cell\n', 'exactly as saved.'] },
    ],
  }
  // Some real notebooks use noncanonical whitespace or custom integers beyond JavaScript precision.
  return encodeNotebook(notebook)
    .replace('"course": "preserve this"', '"course" :  "preserve this"')
    .replace('"calibration": "numeric fixture"', '"calibration"  : 9007199254740993')
    .replace('"ionFrozen": true', '"ionFrozen" :  true')
    .replace('"legacy-cell-marker": true', '"legacy-cell-marker" : true')
}

export function cellNotebook(count = 100) {
  return {
    nbformat: 4, nbformat_minor: 5, metadata: kernelMetadata,
    cells: Array.from({ length: count }, (_, index) => {
      const label = `Notebook cell ${String(index + 1).padStart(3, '0')}`
      return index % 2 === 0
        ? markdown(`cell-${index}`, `### ${label}\n\nExplain this step before running it.`)
        : code(`cell-${index}`, `# ${label}\nresult = ${index + 1} * 2`)
    }),
  }
}

export function plotNotebook({ count = 3, width = 960, height = 560 } = {}) {
  return {
    nbformat: 4, nbformat_minor: 5, metadata: kernelMetadata,
    cells: Array.from({ length: count }, (_, index) => code(`plot-${index}`, `# Saved large plot ${index + 1}`,
      [display({ 'image/png': savedPlotPng(width, height, index + 1, true).toString('base64') })], index + 1)),
  }
}

export function kernelNotebook({ markerPath } = {}) {
  const seed = [
    ...(markerPath ? ['from pathlib import Path', `Path(${JSON.stringify(markerPath)}).write_text('executed')`] : []),
    'import os', 'ion_value = 41', 'print("Ion kernel started")', 'print(f"Ion kernel PID {os.getpid()}")',
  ].join('\n')
  const plot = [
    'import io', 'import pandas as pd', 'import matplotlib', 'matplotlib.use("Agg")',
    'from matplotlib import pyplot as plt', 'from IPython.display import Image, display',
    'display(pd.DataFrame({"Module": ["Live Pandas table"], "Score": [ion_value + 1]}))',
    'fig, axes = plt.subplots(figsize=(2.4, 1.6), dpi=90)', 'axes.plot([0, 1, 2], [3, 1, 5])',
    'buffer = io.BytesIO()', 'fig.savefig(buffer, format="png")',
    'display(Image(data=buffer.getvalue(), format="png"))', 'plt.close(fig)',
  ].join('\n')
  return {
    nbformat: 4, nbformat_minor: 5, metadata: kernelMetadata,
    cells: [code('seed-kernel', seed), code('persistent-state', 'print(f"Ion shared state {ion_value + 1}")'),
      code('live-rich-output', plot), code('real-error', 'raise ValueError("Ion live traceback")')],
  }
}

export function interruptNotebook(markerPath) {
  return {
    nbformat: 4, nbformat_minor: 5, metadata: kernelMetadata,
    cells: [code('busy-cell', ['import time', 'from pathlib import Path',
      `Path(${JSON.stringify(markerPath)}).write_text('busy')`, 'print("Ion kernel busy", flush=True)', 'time.sleep(90)'].join('\n'))],
  }
}

export function kernelBenchmarkNotebook() {
  return {
    nbformat: 4, nbformat_minor: 5, metadata: kernelMetadata,
    cells: [code('kernel-bench', 'ion_benchmark_state = 42\nprint("Ion benchmark kernel is live")')],
  }
}

export async function stubNotebookTrust(app, approved) {
  await app.evaluate(({ dialog }, approve) => {
    const original = dialog.showMessageBox
    dialog.showMessageBox = async (window, options) => {
      const index = options.buttons?.indexOf('Trust and Run') ?? -1
      if (index < 0) return original(window, options)
      globalThis.ionTestKernelTrustPrompts = (globalThis.ionTestKernelTrustPrompts ?? 0) + 1
      const cancel = options.buttons.indexOf('Cancel')
      const response = approve ? index : options.cancelId ?? (cancel >= 0 ? cancel : Number(index === 0))
      return { response, checkboxChecked: false }
    }
  }, approved)
}

export async function chooseNotebookPython(view) {
  const chooser = view.getByTestId('notebook-kernel-choose')
  if (!await chooser.isVisible()) await view.getByTestId('notebook-kernel-discover').click()
  await chooser.click()
}

export const notebookCell = (view, index) => view.locator(`[data-testid="notebook-cell"][data-cell-index="${index}"]`)

export async function revealNotebookCell(view, index) {
  const viewport = view.getByTestId('notebook-scroll')
  await viewport.evaluate(async (node, index) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const target = node.querySelector(`[data-testid="notebook-cell"][data-cell-index="${index}"]`)
      if (target) {
        const bounds = node.getBoundingClientRect()
        const top = target.getBoundingClientRect().top - bounds.top
        const atEnd = node.scrollTop >= node.scrollHeight - node.clientHeight - 2
        if (top >= -1 && (top <= 32 || atEnd && top < node.clientHeight - 20)) return
        node.scrollTop += top - 12
      } else {
        const first = node.querySelector('[data-testid="notebook-cell"]')?.dataset.cellIndex
        const direction = first !== undefined && index < Number(first) ? -1 : 1
        node.scrollTop += direction * Math.max(node.clientHeight / 2, 80)
      }
      // Measured row heights and the virtual window can change after the scroll event.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
    throw new Error(`Notebook cell ${index + 1} never reached the visible viewport.`)
  }, index)
  return notebookCell(view, index)
}
