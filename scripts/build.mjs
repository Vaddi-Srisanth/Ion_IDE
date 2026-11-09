import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { buildWindowsPty } from './windows/build-pty.mjs'
import { build as bundle } from 'esbuild'
import electron from 'electron'
import { build, createServer } from 'vite'

const mode = process.argv[2]
const require = createRequire(import.meta.url)
const output = process.env.ION_BUILD_OUTPUT_DIR ?? (mode === 'baseline' ? 'dist-baseline' : 'dist')
const targetPlatform = process.env.ION_TARGET_PLATFORM ?? process.platform
const targetArch = process.env.ION_TARGET_ARCH ?? (targetPlatform === 'darwin' ? process.env.ION_MAC_ARCH : undefined) ?? process.arch
if (targetPlatform !== process.platform && (targetPlatform !== 'win32' || mode === 'dev')) {
  throw new Error('Cross-platform builds are supported for Windows packaging only.')
}

async function buildSearchTool() {
  const name = `@vscode/ripgrep-${targetPlatform}-${targetArch}`
  const installed = resolve(process.env.ION_RIPGREP_PACKAGE_DIR ?? join('node_modules', name))
  const manifest = await readFile(join(installed, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined)
  const project = JSON.parse(await readFile('package.json', 'utf8'))
  if (manifest?.name !== name || manifest.version !== project.devDependencies['@vscode/ripgrep']) {
    throw new Error(`Install the pinned ${name} package or set ION_RIPGREP_PACKAGE_DIR to its extracted directory.`)
  }
  const folder = resolve(output, 'native')
  const extension = targetPlatform === 'win32' ? '.exe' : ''
  await mkdir(folder, { recursive: true })
  await Promise.all([
    cp(join(installed, 'bin', 'rg' + extension), join(folder, 'ion-rg' + extension)),
    cp(join(installed, 'LICENSE'), join(folder, 'ion-rg-LICENSE.txt')),
    cp('src/main/ripgrep-NOTICES.txt', join(folder, 'ion-rg-NOTICES.txt')),
  ])
}

async function buildPty() {
  const source = 'src/main/run-console/pty-helper.c'
  const folder = resolve(output, 'native')
  const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', join(folder, 'ion-pty')]
  const run = promisify(execFile)
  if (targetPlatform === 'darwin') {
    await mkdir(folder, { recursive: true })
    const arch = targetArch
    if (arch !== 'arm64' && arch !== 'x64') throw new Error('Unsupported macOS PTY architecture.')
    await run('/usr/bin/xcrun', ['clang', '-D_DARWIN_C_SOURCE', '-arch', arch === 'arm64' ? 'arm64' : 'x86_64',
      '-mmacosx-version-min=13.0', ...args])
  } else if (targetPlatform === 'linux') {
    await mkdir(folder, { recursive: true })
    await run('cc', ['-D_DEFAULT_SOURCE', ...args, '-lutil'])
  } else if (targetPlatform === 'win32') {
    await buildWindowsPty(join(folder, 'ion-pty.exe'), targetArch)
  }
}

async function buildDesktop() {
  await bundle({
    entryPoints: {
      'main/index': 'src/main/index.ts',
      'main/learning/index': 'src/main/learning/index.ts',
      'main/learning/catalog-store': 'src/main/learning/catalog-store.ts',
      'main/practice/index': 'src/main/practice/index.ts',
      'main/projects/ipc': 'src/main/projects/ipc.ts',
      'main/viewers/index': 'src/main/viewers/index.ts',
      'main/viewers/document-worker': 'src/main/viewers/document-worker.ts',
      'main/notebooks/kernel-service': 'src/main/notebooks/kernel-service.ts',
      'main/run-console/index': 'src/main/run-console/index.ts',
      'main/terminal/service': 'src/main/terminal/service.ts',
      'main/web-preview': 'src/main/web-preview.ts',
      'main/profile-export': 'src/main/profile-export.ts',
      'main/workspace-search': 'src/main/workspace-search.ts',
      'preload/index': 'src/preload/index.ts',
    },
    plugins: [{
      name: 'optional-desktop-features',
      setup(build) {
        build.onResolve({ filter: /^\.\/(learning(?:\/catalog-store)?|practice|projects\/ipc|viewers|run-console|terminal\/service|web-preview|profile-export|workspace-search|notebooks\/kernel-service)$/ }, ({ path, kind }) => {
          if (kind !== 'dynamic-import') return
          const singleFile = path.endsWith('/ipc') || path === './web-preview' || path === './profile-export'
            || path === './notebooks/kernel-service' || path === './learning/catalog-store'
            || path === './workspace-search' || path === './terminal/service'
          return { path: path + (singleFile ? '.cjs' : '/index.cjs'), external: true }
        })
      },
    }],
    bundle: true,
    loader: { '.py': 'text' },
    external: ['electron'],
    outdir: output,
    outExtension: { '.js': '.cjs' },
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: mode === 'dev' ? 'inline' : false,
    minify: mode !== 'dev',
  })
  const { compileLearningCatalog } = require(resolve(output, 'main/learning/catalog-store.cjs'))
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  await Promise.all([
    buildPty(),
    buildSearchTool(),
    cp('src/main/learning/packs', resolve(output, 'main/learning-packs'), { recursive: true }),
    compileLearningCatalog(resolve('src/main/learning/catalog'), resolve(output, 'main/learning-catalog'), version),
    cp('src/main/themes/palettes', resolve(output, 'main/themes'), { recursive: true }),
    ...[['csv-parse', 'LICENSE'], ['sax', 'LICENSE.md'], ['yauzl', 'LICENSE'], ['pend', 'LICENSE']]
      .map(([name, license]) => cp(resolve('node_modules', name, license), resolve(output, 'main/viewers/licenses', name + '.txt'))),
  ])
}

async function buildPdfAssets(directory) {
  const pdf = resolve('node_modules/pdfjs-dist')
  const assets = resolve(directory, 'pdf-assets')
  await Promise.all([
    ...['cmaps', 'standard_fonts'].map((name) => cp(resolve(pdf, name), resolve(assets, name), { recursive: true })),
    ...['openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js',
      'LICENSE_OPENJPEG', 'LICENSE_JBIG2', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_PDFJS_JBIG2'].map((name) =>
      cp(resolve(pdf, 'wasm', name), resolve(assets, 'wasm', name))),
    cp(resolve(pdf, 'LICENSE'), resolve(assets, 'LICENSE')),
  ])
}

async function copyRendererNotices(directory) {
  const licenses = join(directory, 'licenses')
  await Promise.all([
    cp('node_modules/monaco-editor/ThirdPartyNotices.txt', join(licenses, 'monaco-editor-ThirdPartyNotices.txt')),
    cp('node_modules/dompurify/LICENSE', join(licenses, 'dompurify-LICENSE.txt')),
  ])
}

if (mode === 'dev') {
  const publicDir = await mkdtemp(join(tmpdir(), 'ion-pdf-dev-'))
  let server
  try {
    await Promise.all([buildDesktop(), buildPdfAssets(publicDir)])
    server = await createServer({ publicDir })
    await server.listen()
    const url = server.resolvedUrls.local[0]
    const desktop = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, ION_DEV_URL: url } })
    const stop = () => desktop.kill('SIGTERM')
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    try {
      const [code] = await once(desktop, 'exit')
      process.exitCode = code ?? 0
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  } finally {
    await server?.close()
    await rm(publicDir, { recursive: true, force: true })
  }
} else {
  if (mode === 'baseline') process.env.VITE_ION_EAGER_EDITOR = '1'
  else delete process.env.VITE_ION_EAGER_EDITOR
  await Promise.all([
    buildDesktop(),
    build({
      build: { outDir: resolve(output, 'renderer') },
      define: { 'import.meta.env.VITE_ION_EAGER_EDITOR': JSON.stringify(mode === 'baseline' ? '1' : '0') },
    }).then(() => Promise.all([
      buildPdfAssets(resolve(output, 'renderer')),
      copyRendererNotices(resolve(output, 'renderer')),
    ])),
  ])
}
