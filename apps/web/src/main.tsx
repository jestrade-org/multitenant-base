import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { SessionProvider } from './shared/auth/SessionProvider.js';
import { applyStoredPreference, ThemeProvider } from './shared/theme/ThemeProvider.js';
import './shared/i18n/index.js';
import './shared/design/tokens.css';
import './index.css';

/**
 * The composition root of the client.
 *
 * Each bounded context owns its typed HTTP client (`contexts/<context>/api/`), so there is
 * no app-wide adapter to inject here — only the providers every screen shares.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * Before anything renders.
 *
 * The theme has to be on the document by first paint. A production CSP forbids an inline
 * script in `index.html` (`security-owasp.md` A03), so this runs here instead — still
 * ahead of React, which is what matters: applying it afterwards is what makes a
 * dark-themed device flash white on every load.
 */
applyStoredPreference();

const root = document.getElementById('root');
if (root === null) throw new Error('The #root element is missing from index.html.');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
