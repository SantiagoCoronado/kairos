import { useEffect, useRef, useState } from 'react'
import { Sparkles, Square, Plus, Wrench, Paperclip, X } from 'lucide-react'
import type { ChatAttachment, ChatStreamEvent } from '../../../shared/ipc-contract'
import { api, getRemoteToken } from '../lib/api'
import { IS_REMOTE, useIsMobile } from '../lib/mobile'
import { Button, cn } from '../components/ui'

/** remote client: file bytes travel over HTTP into the Mac's staging dir —
 *  the native dialog and pathForFile only exist inside Electron */
async function uploadFiles(files: File[]): Promise<{ staged: ChatAttachment[]; failed: string[] }> {
  const staged: ChatAttachment[] = []
  const failed: string[] = []
  for (const f of files) {
    try {
      const res = await fetch(`/upload?name=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        headers: { 'x-kairos-token': getRemoteToken() ?? '' },
        body: f
      })
      if (!res.ok) throw new Error(await res.text())
      staged.push((await res.json()) as ChatAttachment)
    } catch (err) {
      failed.push(`${f.name}: ${err instanceof Error ? err.message : 'upload failed'}`)
    }
  }
  return { staged, failed }
}

interface Bubble {
  role: 'user' | 'assistant' | 'error'
  text: string
  tools: string[]
  /** a sealed assistant bubble is complete; the next delta starts a new one */
  sealed?: boolean
}

export function ChatView({
  initialSessionId = null
}: {
  /** continue an existing session (e.g. an agent-task run transcript) */
  initialSessionId?: string | null
}): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const mobile = useIsMobile()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string | null>(null)
  sessionRef.current = sessionId
  const hydratedRef = useRef(false)

  // replay a reopened session's transcript once on mount. The view is keyed by
  // session id in App, so opening a different session remounts and re-hydrates.
  useEffect(() => {
    if (!initialSessionId || hydratedRef.current) return
    hydratedRef.current = true
    void api.invoke('chat:history', initialSessionId).then((msgs) => {
      if (msgs.length === 0) return
      setBubbles(msgs.map((m) => ({ role: m.role, text: m.text, tools: m.tools, sealed: true })))
    })
  }, [initialSessionId])

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
    if ((!text && attachments.length === 0) || busy) return
    // staged paths ride inside the prompt — the agent's Read is scoped to
    // exactly the uploads dir, so a bare path is all it needs
    const attachNote =
      attachments.length > 0
        ? `${text ? '\n\n' : ''}[attached file${attachments.length > 1 ? 's' : ''} — read as needed]\n` +
          attachments.map((a) => `- ${a.path}`).join('\n')
        : ''
    const prompt = text + attachNote
    setInput('')
    setAttachments([])
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setBusy(true)
    setBubbles((prev) => [...prev, { role: 'user', text: prompt, tools: [] }])
    const { localSessionId } = await api.invoke('chat:send', sessionId, prompt)
    setSessionId(localSessionId)
  }

  const addUploads = async (files: File[]): Promise<void> => {
    setAttachError(null)
    const { staged, failed } = await uploadFiles(files)
    if (staged.length > 0) setAttachments((prev) => [...prev, ...staged])
    if (failed.length > 0) {
      setAttachError(failed.join(' · '))
      setTimeout(() => setAttachError(null), 6000)
    }
  }

  const attach = async (): Promise<void> => {
    if (IS_REMOTE) {
      // browser file picker → HTTP upload; the Electron path would pop a
      // native dialog on the Mac, not the phone
      fileInputRef.current?.click()
      return
    }
    const staged = await api.invoke('chat:attach')
    if (staged.length > 0) setAttachments((prev) => [...prev, ...staged])
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragging(false)
    const files = [...e.dataTransfer.files]
    if (files.length === 0) return
    if (IS_REMOTE) {
      await addUploads(files)
      return
    }
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean)
    if (paths.length === 0) return
    const staged = await api.invoke('chat:attachPaths', paths)
    if (staged.length > 0) setAttachments((prev) => [...prev, ...staged])
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
    <div
      className="h-full flex flex-col max-w-3xl mx-auto w-full"
      onDragOver={(e) => {
        // only real OS file drags count — not text selections dragged around
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        // ignore leaves into child elements; only leaving the container ends the drag
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className={cn('flex items-center px-6', mobile ? 'justify-end pt-1' : 'justify-between pt-4')}>
        {!mobile && (
          <span className="text-[12px] text-faint">
            Runs on your Claude Code subscription — the rest of the app works without it.
          </span>
        )}
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
              {sessionId
                ? 'Continuing a task session — send a message to follow up on the run.'
                : '"what follow-ups are due?" · "plan my week" · "log coffee with Anna, set a 3-week cadence"'}
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

      <div className={cn('px-6 pt-1', mobile ? 'pb-2' : 'pb-5')}>
        {/* remote picker target — never rendered as UI */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length > 0) void addUploads(files)
          }}
        />
        {attachError && (
          <p className="pb-1.5 text-[11px] text-danger truncate" title={attachError}>
            {attachError}
          </p>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-1.5">
            {attachments.map((a) => (
              <span
                key={a.path}
                className="inline-flex items-center gap-1.5 max-w-64 px-2 py-1 rounded border border-border bg-raised text-[11.5px]"
              >
                <Paperclip size={11} className="shrink-0 text-faint" />
                <span className="truncate">{a.name}</span>
                <span className="shrink-0 text-faint">{humanKb(a.size)}</span>
                <button
                  title="Remove"
                  className="shrink-0 text-faint hover:text-danger"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          className={cn(
            'flex items-end gap-2 rounded-lg border bg-raised px-2 py-1.5 transition-colors',
            dragging ? 'border-accent border-dashed' : 'border-border focus-within:border-border-strong'
          )}
        >
          <button
            title="Attach files (or drop them anywhere here)"
            onClick={() => void attach()}
            className="shrink-0 p-1.5 rounded text-faint hover:text-text hover:bg-border/50"
          >
            <Paperclip size={14} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value)
              // auto-grow to content, capped by the max-h class below
              e.target.style.height = 'auto'
              e.target.style.height = `${e.target.scrollHeight}px`
            }}
            onKeyDown={(e) => {
              // Shift+Enter = newline; plain Enter sends (but never mid-IME composition)
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={
              dragging
                ? 'Drop files to attach'
                : mobile
                  ? 'Ask anything…'
                  : 'Ask about your people, tasks, objectives… (Shift+Enter for a new line)'
            }
            className="flex-1 max-h-44 resize-none overflow-y-auto bg-transparent py-1 text-[13px] text-text placeholder:text-faint focus:outline-none"
          />
          {busy ? (
            <Button onClick={stop} title="Stop">
              <Square size={14} />
            </Button>
          ) : (
            <Button
              variant="accent"
              onClick={() => void send()}
              disabled={!input.trim() && attachments.length === 0}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function humanKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
