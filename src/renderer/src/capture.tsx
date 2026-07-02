import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Zap } from 'lucide-react'
import './styles.css'

type Flash = { ok: boolean; message: string } | null

function Capture(): React.JSX.Element {
  const [text, setText] = useState('')
  const [flash, setFlash] = useState<Flash>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return window.api.on('capture:reset', () => {
      setText('')
      setFlash(null)
      inputRef.current?.focus()
    })
  }, [])

  const submit = async (): Promise<void> => {
    const raw = text.trim()
    if (!raw) {
      void window.api.invoke('capture:hide')
      return
    }
    const result = await window.api.invoke('capture:submit', raw)
    setFlash(result)
    if (result.ok) {
      setText('')
      setTimeout(() => {
        setFlash(null)
        void window.api.invoke('capture:hide')
      }, 550)
    }
  }

  return (
    <div className="h-screen p-2">
      <div className="h-full rounded-xl border border-border-strong bg-panel/95 shadow-2xl flex items-center gap-3 px-4">
        <Zap size={16} className={flash?.ok ? 'text-ok' : 'text-accent'} />
        <input
          ref={inputRef}
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setFlash(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') void window.api.invoke('capture:hide')
          }}
          placeholder='capture…  ("p Anna had coffee" · @work !1 due:fri)'
          className="flex-1 bg-transparent text-[15px] text-text placeholder:text-faint focus:outline-none"
        />
        {flash && (
          <span
            className={`font-mono text-[11px] shrink-0 ${flash.ok ? 'text-ok' : 'text-danger'}`}
          >
            {flash.message}
          </span>
        )}
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Capture />)
