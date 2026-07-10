import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { api } from './lib/api'
import './styles.css'

// ship every renderer failure to ~/Kairos/logs/app.log — a silent white
// screen with no trace is not debuggable
const logError = (message: string): void => {
  void api.invoke('log:renderer', 'error', message).catch(() => {})
}
window.addEventListener('error', (e) => {
  logError(`window.onerror: ${e.message} (${e.filename}:${e.lineno})${e.error?.stack ? `\n${e.error.stack}` : ''}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  logError(`unhandledrejection: ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`)
})

interface BoundaryState {
  error: Error | null
}

/** Last-resort UI: a readable error screen instead of a dead white window. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logError(`react crash: ${error.stack ?? error.message}\ncomponent stack:${info.componentStack ?? ''}`)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="h-full flex items-center justify-center bg-overlay p-8">
        <div className="max-w-lg space-y-3">
          <h2 className="text-[15px] font-medium text-danger">Something broke</h2>
          <p className="text-[13px] text-muted">
            The error was written to ~/Kairos/logs/app.log so it can be fixed.
          </p>
          <pre className="text-[11px] font-mono text-faint bg-raised rounded-md p-3 overflow-auto max-h-48 whitespace-pre-wrap">
            {this.state.error.stack ?? this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 rounded-md text-[13px] bg-raised border border-border text-text hover:border-border-strong"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
