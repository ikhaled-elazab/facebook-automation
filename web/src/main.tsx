/*
 * main.tsx — application entry.
 *
 * Imports self-hosted fonts (bundled by Vite → same-origin → CSP-clean: no CDN
 * <link> that would trip the strict scriptSrc/defaultSrc policy), the design
 * system stylesheets, and mounts the provider tree:
 *   ErrorBoundary → ToastProvider → AuthProvider → App (router)
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted fonts (weights actually used). Bundled as same-origin assets.
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/screens.css';

import { App } from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>
);
