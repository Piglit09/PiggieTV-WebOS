import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/global.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root mount point.');
}

const bootstrapStatus = rootElement.querySelector('#ptv-bootstrap-status');
const statusElement = bootstrapStatus instanceof HTMLDivElement ? bootstrapStatus : null;
if (statusElement) {
  statusElement.textContent = 'PiggieTV script initialized';
}
const setBootstrapStatus = (window as unknown as { __ptvSetBootstrapStatus?: (message: string, isError?: boolean) => void }).__ptvSetBootstrapStatus;
if (typeof setBootstrapStatus === 'function') {
  setBootstrapStatus('PTV app script loaded');
}

try {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown bootstrap error';
  if (statusElement) {
    statusElement.textContent = `PTV bootstrap failed: ${message}`;
    statusElement.style.color = '#ffe2e2';
    statusElement.style.borderColor = '#ff7d7d';
    statusElement.style.background = 'rgba(65, 16, 16, 0.85)';
  }
  throw error;
}
