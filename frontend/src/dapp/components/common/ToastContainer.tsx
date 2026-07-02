import React from 'react';
import { useToastStore } from '../../store/toast';

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" style={{
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px'
    }}>
      {toasts.map(toast => (
        <div key={toast.id} className={`card toast toast--${toast.type}`} onClick={() => removeToast(toast.id)} style={{
          padding: '12px 24px',
          cursor: 'pointer',
          backgroundColor: toast.type === 'error' ? 'rgba(255,50,50,0.1)' : 'var(--color-surface-elevated)',
          border: `1px solid ${toast.type === 'error' ? 'var(--color-error)' : 'var(--color-border)'}`,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
        }}>
          <p className="text-body" style={{ margin: 0, color: toast.type === 'error' ? 'var(--color-error)' : 'inherit' }}>{toast.message}</p>
        </div>
      ))}
    </div>
  );
}
