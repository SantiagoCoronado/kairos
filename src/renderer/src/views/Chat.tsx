import { useEffect, useRef, useState } from 'react'
import { Sparkles, Square, Plus, Wrench } from 'lucide-react'
import type { ChatStreamEvent } from '../../../shared/ipc-contract'
import { api } from '../lib/api'
import { Button, cn } from '../components/ui'

interface Bubble {
  role: 'user' | 'assistant' | 'error'
  text: string
  tools: string[]
  /** a sealed assistant bubble is complete; the next delta starts a new one */
  sealed?: boolean
}

export function ChatView(): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string | null>(null)
  sessionRef.current = sessionId

  useEffect(() => {
    return api.on('chat:event', (event: ChatStreamEvent) => {
      if (sessionRef.current && event.localSessionId !== sessionRef.current) return
      setBubbles((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        switch (event.kind) {
          case 'delta': {
            if (last?.role === 'assistant' && !last.sealed) {
              next[next.length - 1] = { ...last, text: last.text + event.text }
            } else {
              next.push({ role: 'assistant', text: event.text, tools: [] })
            }
            break
          }
          case 'tool': {
            if (last?.role === 'assistant' && !last.sealed) {
              next[next.length - 1] = { ...last, tools: [...last.tools, event.name] }
            } else {
              next.push({ role: 'assistant', text: '', tools: [event.name] })
            }
            break
          }
          case 'assistant_done': {
            // seal the finished bubble so the next turn starts a fresh one
            if (last?.role === 'assistant' && last.text) {
              next[next.length - 1] = { ...last, sealed: true }
            }
            break
          }
          case 'error':
            next.push({ role: 'error', text: event.message, tools: [] })
            break
          case 'done':
            break
        }
        return next
      })
      if (event.kind === 'done' || event.kind === 'error') setBusy(false)
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [bubbles])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setBubbles((prev) => [...prev, { role: 'user', text, tools: [] }])
    const { localSessionId } = await api.invoke('chat:send', sessionId, text)
    setSessionId(localSessionId)
  }

  const stop = (): void => {
    if (sessionId) void api.invoke('chat:interrupt', sessionId)
  }

  const newChat = (): void => {
    setSessionId(null)
    setBubbles([])
    setBusy(false)
  }

  return (
    <div className="h-full flex flex-col max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between px-6 pt-4">
        <span className="text-[12px] text-faint">
          Runs on your Claude Code subscription — the rest of the app works without it.
        </span>
        <Button variant="ghost" onClick={newChat}>
          <span className="inline-flex items-center gap-1">
            <Plus size={13} /> new chat
          </span>
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3">
        {bubbles.length === 0 && (
          <div className="pt-16 text-center space-y-2">
            <Sparkles size={20} className="mx-auto text-faint" />
            <p className="text-faint text-[13px]">
              "what follow-ups are due?" · "plan my week" · "log coffee with Anna, set a 3-week
              cadence"
            </p>
          </div>
        )}
        {bubbles.map((b, i) => (
          <div key={i} className={cn('flex', b.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[85%] rounded-lg px-3.5 py-2.5 text-[13px] whitespace-pre-wrap leading-relaxed',
                b.role === 'user' && 'bg-raised border border-border',
                b.role === 'assistant' && 'bg-panel border border-border',
                b.role === 'error' && 'bg-danger/10 border border-danger/40 text-danger'
              )}
            >
              {b.tools.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {b.tools.map((t, j) => (
                    <span
                      key={j}
                      className="inline-flex items-center gap-1 font-mono text-[10px] text-accent bg-accent/10 rounded px-1.5 py-0.5"
                    >
                      <Wrench size={9} /> {t}
                    </span>
                  ))}
                </div>
              )}
              {b.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-faint text-[12px] font-mono">
            <span className="animate-pulse">thinking…</span>
          </div>
        )}
      </div>

      <div className="px-6 pb-5 pt-1 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send()}
          placeholder="Ask about your people, tasks, objectives…"
          className="flex-1 bg-raised border border-border rounded-lg px-3.5 py-2.5 text-[13px] text-text placeholder:text-faint focus:outline-none focus:border-border-strong"
        />
        {busy ? (
          <Button onClick={stop} title="Stop">
            <Square size={14} />
          </Button>
        ) : (
          <Button variant="accent" onClick={() => void send()} disabled={!input.trim()}>
            Send
          </Button>
        )}
      </div>
    </div>
  )
}
