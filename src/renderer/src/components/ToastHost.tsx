import { useSyncExternalStore } from 'react'
import { Check, CircleAlert, Loader2, X } from 'lucide-react'
import { dismissToast, getToasts, subscribeToasts } from '../lib/toast'

/** Renders the global toast stack above every view (mounted once at the
 *  app root). Floating chrome → bg-overlay, per popover-opacity rule. */
export function ToastHost(): React.JSX.Element | null {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts)
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto w-[340px] flex items-start gap-2.5 rounded-lg border border-border-strong bg-overlay shadow-2xl px-3.5 py-2.5"
        >
          {t.variant === 'working' && (
            <Loader2 size={15} className="text-accent animate-spin shrink-0 mt-px" />
          )}
          {t.variant === 'success' && <Check size={15} className="text-ok shrink-0 mt-px" />}
          {t.variant === 'error' && (
            <CircleAlert size={15} className="text-danger shrink-0 mt-px" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-text break-words">{t.text}</p>
            {t.detail && <p className="text-[11px] text-faint truncate">{t.detail}</p>}
          </div>
          <button
            onClick={() => dismissToast(t.id)}
            className="shrink-0 text-faint hover:text-text"
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
