'use client';

import { HashRouter } from 'react-router-dom';
import App from '../../dapp/App';

export default function DappRuntime() {
  return (
    <HashRouter>
      <App />
    </HashRouter>
  );
}
