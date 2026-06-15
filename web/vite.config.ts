import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the control-plane admin UI.
 *
 * SAME-ORIGIN, CSP-SAFE BUILD:
 *   The Express control plane (server/app.js) sets a strict helmet CSP with
 *   `scriptSrc: ['self']` and NO 'unsafe-inline'. Vite by default inlines a tiny
 *   module-preload polyfill as an inline <script>, which that CSP would block.
 *   We disable `modulePreload` so the built index.html contains ONLY external
 *   <script type="module" src="/assets/..."> tags (same-origin → allowed by
 *   'self'). This keeps the API's hardened CSP unchanged when it serves the SPA.
 *
 * DEV PROXY:
 *   `npm run ui:dev` runs Vite on :5173 and proxies /api + /healthz to the
 *   control plane on :8080 so cookies + CSRF work against the real backend in
 *   development without CORS. The control plane must be running (`npm run
 *   control`) for dev API calls to succeed.
 *
 * BUILD OUTPUT:
 *   Emitted to web/dist. server/app.js serves that directory as the SPA root
 *   (after the /api routes, with history fallback for client-side routing).
 */

const CONTROL_PLANE_ORIGIN = process.env.CONTROL_ORIGIN || 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  // Assets are served from the control-plane root, so base must be '/'.
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // CSP-CRITICAL: no inline module-preload polyfill script (see header note).
    modulePreload: { polyfill: false },
    // Predictable cache-busted asset names under /assets (matches CSP 'self').
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: CONTROL_PLANE_ORIGIN,
        changeOrigin: false, // keep Host so loopback + Secure-cookie logic is sane
        secure: false,
      },
      '/healthz': {
        target: CONTROL_PLANE_ORIGIN,
        changeOrigin: false,
        secure: false,
      },
    },
  },
});
