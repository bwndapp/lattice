import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// three.js, which only the cube's window uses, goes out as its own files (versioned by
// folder) rather than in the one bundle everybody downloads: abstract/panels.js imports it
// from there the first time a cube is opened.
const THREE_VERSION = JSON.parse(readFileSync(new URL('./node_modules/three/package.json', import.meta.url))).version
const threeFiles = () => ({
  name: 'three-files',
  apply: 'build',
  generateBundle() {
    for (const f of ['three.module.min.js', 'three.core.min.js']) {
      this.emitFile({ type: 'asset', fileName: `three-${THREE_VERSION}/${f}`, source: readFileSync(new URL(`./node_modules/three/build/${f}`, import.meta.url)) })
    }
  },
})

// Strudel's scheduler looks 0.2 s ahead: a slower machine that stalls the page for longer
// than that (a busy patch redrawing) makes it skip whole windows of notes, which you hear
// as the sound cutting in and out. Looking 0.35 s ahead rides out those stalls; edits
// reach the ears that little bit later.
const LOOKAHEAD_OVERLAP = 0.25
const schedulerHeadroom = () => ({
  name: 'scheduler-headroom',
  transform(code, id) {
    if (!/@strudel[\\/]core[\\/]dist[\\/]index\.mjs$/.test(id)) return null
    const from = '// duration of each cycle\n      0.1,\n      0.1,'
    if (!code.includes(from)) { this.warn('scheduler-headroom: Strudel changed, lookahead not widened'); return null }
    return { code: code.replace(from, `// duration of each cycle\n      0.1,\n      ${LOOKAHEAD_OVERLAP},`), map: null }
  },
})

// The incubator serves two dirs (see the FastAPI server):
//   public/  → the live site at  /            (SPA catch-all serves files + index.html)
//   webapp/  → the draft at      /preview/
// We build to a sibling dir chosen by BUILD_TARGET:
//   npm run build → BUILD_TARGET=public → outDir ../public
//   npm run draft → BUILD_TARGET=webapp → outDir ../webapp
// bwnd-publish copies webapp/ to public/ unchanged, so the build can't bake in its
// path: assets are relative ('./') and index.html sets <base href> at load time.
const target = process.env.BUILD_TARGET === 'webapp' ? 'webapp' : 'public'

export default defineConfig({
  base: './',
  // copied as-is into the build (the share image); not "public", which is the live site's dir
  publicDir: 'static',
  plugins: [react(), threeFiles(), schedulerHeadroom()],
  // bwnd sign-in: the issuer and this app's client id come from the box's env
  // at build time (see src/bwnd.js). Empty when built outside a box.
  define: {
    'import.meta.env.VITE_BWND_SSO_ISSUER': JSON.stringify(process.env.BWND_SSO_ISSUER || ''),
    'import.meta.env.VITE_THREE_VERSION': JSON.stringify(THREE_VERSION),
    'import.meta.env.VITE_BWND_SSO_CLIENT_ID': JSON.stringify(process.env.BWND_SSO_CLIENT_ID || ''),
  },
  build: {
    outDir: `../${target}`,
    emptyOutDir: true, // allow writing to a dir outside the project root
    // One JS file: the server appends ?v= to the entry script, so split chunks that
    // import back into the entry would load a second copy of every Strudel module.
    // (three.js, for the cube, is shipped beside it as files of its own: see threeFiles)
    rollupOptions: { output: { inlineDynamicImports: true } },
    chunkSizeWarningLimit: 4000,
  },
})
