// @stellar/stellar-sdk builds ScVals with Node's `Buffer`, which the browser
// doesn't provide. Polyfill it globally before any SDK code runs.
import { Buffer } from 'buffer';
if (!(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.tsx';

import './styles/dapp-tokens.css';
import '../styles/reset.css'; // Reusing global reset
import './styles/dapp-typography.css';
import './styles/dapp-layout.css';
import './styles/dapp-components.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
