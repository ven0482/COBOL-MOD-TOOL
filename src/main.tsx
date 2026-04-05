import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

console.log('main.tsx: Starting application...');

// Fix for "ResizeObserver loop completed with undelivered notifications"
// This error is often benign and triggered by libraries like Monaco Editor or Framer Motion.
const resizeObserverLoopErr = 'ResizeObserver loop completed with undelivered notifications.';
const resizeObserverLimitErr = 'ResizeObserver loop limit exceeded';

const isResizeObserverError = (message: string) => 
  message === resizeObserverLoopErr || message === resizeObserverLimitErr;

window.addEventListener('error', (e) => {
  if (isResizeObserverError(e.message)) {
    e.stopImmediatePropagation();
  } else {
    console.error('main.tsx: Window error caught:', e.message, e.error);
  }
});

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && isResizeObserverError(e.reason?.message)) {
    e.stopImmediatePropagation();
  } else {
    console.error('main.tsx: Unhandled rejection:', e.reason);
  }
});

const rootElement = document.getElementById('root');
console.log('main.tsx: Root element:', rootElement);

function showErrorFallback(message: string) {
  console.error('main.tsx: Showing error fallback:', message);
  if (rootElement) {
    rootElement.innerHTML = `
      <div style="padding: 20px; color: #d32f2f; font-family: monospace; text-align: center;">
        <h2>Application Error</h2>
        <p>${message}</p>
        <p style="font-size: 12px; color: #666;">Press F12 to open developer console for details</p>
      </div>
    `;
  }
}

if (!rootElement) {
  document.body.innerHTML = '<div style="padding: 20px; color: red; font-family: monospace;">ERROR: root element not found in DOM</div>';
} else {
  try {
    console.log('main.tsx: Creating React root...');
    const root = createRoot(rootElement);
    
    console.log('main.tsx: Rendering React app...');
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    
    console.log('main.tsx: React app rendered successfully');
    
    // Monitor for rendering errors
    setTimeout(() => {
      console.log('main.tsx: Render timeout check - app should be visible now');
    }, 1000);
  } catch (err: any) {
    console.error('main.tsx: Failed to render app:', err);
    console.error('main.tsx: Error stack:', err?.stack);
    showErrorFallback(`Failed to initialize app: ${String(err?.message || err)}`);
  }
}
