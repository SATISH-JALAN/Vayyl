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
