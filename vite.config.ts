import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { monacoTokenizationMemory } from './scripts/monaco-tokenization-memory.ts'
import { monacoViewMemory } from './scripts/monaco-view-memory.ts'

function monacoSanitizer(): Plugin {
  const sanitizeModule = '/monaco-editor/esm/vs/base/browser/domSanitize.js'
  const vendoredImport = "import purify from './dompurify/dompurify.js';"
  return {
    name: 'ion-monaco-sanitizer',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replaceAll('\\', '/').endsWith(sanitizeModule)) return
      if (!code.includes(vendoredImport)) throw new Error('Monaco’s sanitizer import changed. Review the pinned DOMPurify replacement.')
      return { code: code.replace(vendoredImport, "import purify from 'dompurify';"), map: null }
    },
  }
}

const monacoPlugins = () => [monacoSanitizer(), monacoViewMemory(), monacoTokenizationMemory()]

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [...monacoPlugins(), react()],
  optimizeDeps: { rolldownOptions: { plugins: monacoPlugins() } },
  server: { host: '127.0.0.1', strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
    license: { fileName: 'THIRD-PARTY-LICENSES.md' },
    reportCompressedSize: false,
    chunkSizeWarningLimit: 3000,
  },
})
