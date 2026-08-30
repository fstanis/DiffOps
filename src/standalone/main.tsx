import React from 'react';
import ReactDOM from 'react-dom/client';
import { HotkeysProvider } from 'react-hotkeys-hook';

import StandaloneApp from './StandaloneApp';
import { registerServiceWorker } from './registerServiceWorker';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

void registerServiceWorker();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <StandaloneApp />
    </HotkeysProvider>
  </React.StrictMode>,
);
