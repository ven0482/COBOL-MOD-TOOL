import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Fix for "ResizeObserver loop completed with undelivered notifications"
// This error is often benign and triggered by libraries like Monaco Editor or Framer Motion.
const resizeObserverLoopErr = 'ResizeObserver loop completed with undelivered notifications.';
const resizeObserverLimitErr = 'ResizeObserver loop limit exceeded';

const isResizeObserverError = (message: string) => 
  message === resizeObserverLoopErr || message === resizeObserverLimitErr;

window.addEventListener('error', (e) => {
  if (isResizeObserverError(e.message)) {
    e.stopImmediatePropagation();
  }
});

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && isResizeObserverError(e.reason.message)) {
    e.stopImmediatePropagation();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
