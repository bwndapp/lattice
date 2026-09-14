import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The incubator serves two dirs (see the FastAPI server):
//   public/  → the live site at  /            (SPA catch-all serves files + index.html)
//   webapp/  → the draft at      /preview/
// So we build to a sibling dir chosen by BUILD_TARGET, with a matching base so
// the hashed asset URLs resolve at the right path:
//   npm run build → BUILD_TARGET=public → outDir ../public, base '/'
//   npm run draft → BUILD_TARGET=webapp → outDir ../webapp, base '/preview/'
const target = process.env.BUILD_TARGET === 'webapp' ? 'webapp' : 'public'
const base = target === 'webapp' ? '/preview/' : '/'

export default defineConfig({
  base,
  plugins: [react()],
  // bwnd sign-in: the issuer and this app's client id come from the box's env
  // at build time (see src/bwnd.js). Empty when built outside a box.
  define: {
    'import.meta.env.VITE_BWND_SSO_ISSUER': JSON.stringify(process.env.BWND_SSO_ISSUER || ''),
    'import.meta.env.VITE_BWND_SSO_CLIENT_ID': JSON.stringify(process.env.BWND_SSO_CLIENT_ID || ''),
  },
  build: {
    outDir: `../${target}`,
    emptyOutDir: true, // allow writing to a dir outside the project root
    // One JS file: the server appends ?v= to the entry script, so split chunks that
    // import back into the entry would load a second copy of every Strudel module.
    rollupOptions: { output: { inlineDynamicImports: true } },
    chunkSizeWarningLimit: 4000,
  },
})
