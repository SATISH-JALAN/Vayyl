import { useToastStore } from '../../store/toast';

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="dapp-toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          className={`dapp-toast dapp-toast--${toast.type}`}
          type="button"
          onClick={() => removeToast(toast.id)}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
