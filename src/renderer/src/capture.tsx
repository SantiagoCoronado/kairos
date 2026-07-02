import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'

function Capture(): React.JSX.Element {
  return (
    <div className="h-full flex items-center px-4 rounded-xl border border-border bg-panel">
      <span className="text-muted">Quick capture — coming in M6.</span>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Capture />)
