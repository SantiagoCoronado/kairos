import { useEffect, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { Sun, Users, CheckSquare, Target, Sparkles, Plus, User, FileDown, PanelLeft, Inbox, StickyNote, Bot, Terminal, CalendarDays, Mic, Loader2, Check, CircleAlert, Compass } from 'lucide-react'
import type { Person } from '../../../core/types'
import type { CaptureContext } from '../../../shared/ipc-contract'
import type { ViewId } from './Sidebar'
import { api, useInvoke } from '../lib/api'
import { getCaptureContext } from '../lib/capture-context'
import { watchForSilence, blobToBase64 } from './MicButton'
import { cn } from './ui'

export function CommandPalette({
  onNavigate,
  onOpenPerson,
  onToggleSidebar
}: {
  onNavigate: (v: ViewId) => void
  onOpenPerson: (id: string) => void
  onToggleSidebar: () => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [persons, setPersons] = useState<Person[]>([])
  const [voice, setVoice] = useState(false)
  const { data: settings } = useInvoke('settings:get', [], ['settings'])

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setVoice(false)
      return
    }
    void api.invoke('people:list', { search: query || undefined }).then((p) => setPersons(p.slice(0, 6)))
  }, [open, query])

  if (!open) return null

  const close = (): void => setOpen(false)
  const go = (v: ViewId): void => {
    onNavigate(v)
    close()
  }

  if (voice) {
    return (
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-[18vh]"
        onMouseDown={close}
      >
        <div className="w-[560px]" onMouseDown={(e) => e.stopPropagation()}>
          <VoicePane context={getCaptureContext()} onClose={close} />
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-[18vh]"
      onMouseDown={close}
    >
      <div className="w-[560px]" onMouseDown={(e) => e.stopPropagation()}>
        <Command
          shouldFilter={true}
          className="bg-overlay border border-border-strong rounded-xl shadow-2xl overflow-hidden"
        >
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command or search…"
            className="w-full bg-transparent px-4 py-3 text-[14px] text-text placeholder:text-faint focus:outline-none border-b border-border"
          />
          <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-faint">
              Nothing found.
            </Command.Empty>

            {settings?.elevenLabsApiKey && (
              <Command.Group>
                <Item
                  keywords={['voice', 'speak', 'dictate', 'record', 'command', 'capture']}
                  onSelect={() => setVoice(true)}
                >
                  <Mic size={14} className="text-accent" />
                  <span>
                    Voice command
                    {getCaptureContext() && (
                      <span className="text-faint text-[11px]"> — about: {getCaptureContext()!.label}</span>
                    )}
                  </span>
                </Item>
              </Command.Group>
            )}

            {query.trim() && (
              <Command.Group>
                <Item
                  onSelect={() => {
                    void api.invoke('tasks:create', { title: query.trim() }).then(close)
                  }}
                >
                  <Plus size={14} className="text-accent" />
                  <span>
                    New task: <span className="text-accent">{query.trim()}</span>
                  </span>
                </Item>
                <Item
                  onSelect={() => {
                    void api
                      .invoke('people:upsert', { name: query.trim() })
                      .then((p) => {
                        onOpenPerson(p.id)
                        close()
                      })
                  }}
                >
                  <User size={14} className="text-accent" />
                  <span>
                    New person: <span className="text-accent">{query.trim()}</span>
                  </span>
                </Item>
                <Item
                  onSelect={() => {
                    void api
                      .invoke('notes:create', { title: query.trim() })
                      .then(() => {
                        onNavigate('notes')
                        close()
                      })
                  }}
                >
                  <StickyNote size={14} className="text-accent" />
                  <span>
                    New note: <span className="text-accent">{query.trim()}</span>
                  </span>
                </Item>
              </Command.Group>
            )}

            <Command.Group
              heading={<GroupLabel>go to</GroupLabel>}
            >
              <Item onSelect={() => go('today')} keywords={['home', 'dashboard']}>
                <Sun size={14} /> Today
              </Item>
              <Item onSelect={() => go('inbox')} keywords={['mail', 'email', 'slack', 'whatsapp', 'messages']}>
                <Inbox size={14} /> Inbox
              </Item>
              <Item onSelect={() => go('people')} keywords={['crm', 'contacts']}>
                <Users size={14} /> People
              </Item>
              <Item onSelect={() => go('tasks')} keywords={['todo']}>
                <CheckSquare size={14} /> Tasks
              </Item>
              <Item onSelect={() => go('notes')} keywords={['keep', 'memo', 'checklist', 'reminders']}>
                <StickyNote size={14} /> Notes
              </Item>
              <Item onSelect={() => go('calendar')} keywords={['events', 'schedule', 'agenda', 'gcal', 'meetings']}>
                <CalendarDays size={14} /> Calendar
              </Item>
              <Item onSelect={() => go('objectives')} keywords={['okr', 'goals']}>
                <Target size={14} /> Objectives
              </Item>
              <Item onSelect={() => go('automations')} keywords={['agent', 'scheduled', 'cron', 'jobs']}>
                <Bot size={14} /> Automations
              </Item>
              <Item onSelect={() => go('chat')} keywords={['claude', 'ai']}>
                <Sparkles size={14} /> Chat
              </Item>
              <Item onSelect={() => go('map')} keywords={['atlas', 'vector', 'semantic', 'embeddings', 'explore']}>
                <Compass size={14} /> Atlas
              </Item>
              <Item onSelect={() => go('terminal')} keywords={['shell', 'console', 'zsh', 'cli']}>
                <Terminal size={14} /> Terminal
              </Item>
            </Command.Group>

            <Command.Group heading={<GroupLabel>actions</GroupLabel>}>
              <Item
                keywords={['backup', 'obsidian']}
                onSelect={() => {
                  void api.invoke('export:markdown').then(close)
                }}
              >
                <FileDown size={14} /> Export Markdown
              </Item>
              <Item
                keywords={['hide', 'show', 'menu', 'collapse']}
                onSelect={() => {
                  onToggleSidebar()
                  close()
                }}
              >
                <PanelLeft size={14} /> Toggle Sidebar
              </Item>
            </Command.Group>

            {persons.length > 0 && (
              <Command.Group heading={<GroupLabel>people</GroupLabel>}>
                {persons.map((p) => (
                  <Item
                    key={p.id}
                    keywords={[p.name, p.company ?? '', p.nickname ?? '']}
                    onSelect={() => {
                      onOpenPerson(p.id)
                      close()
                    }}
                  >
                    <User size={14} />
                    <span>{p.name}</span>
                    {p.company && <span className="text-faint text-[11px]">{p.company}</span>}
                  </Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}

type VoiceStatus = 'recording' | 'transcribing' | 'working' | 'done' | 'error'

/** ⌘K voice command: starts listening immediately, auto-stops on silence
 *  (same VAD as the mic buttons), then executes the instruction against the
 *  published capture context ("make this email a task for tomorrow"). */
function VoicePane({
  context,
  onClose
}: {
  context: CaptureContext | null
  onClose: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState<VoiceStatus>('recording')
  const [message, setMessage] = useState('')
  const recRef = useRef<MediaRecorder | null>(null)

  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | null = null

    const run = async (): Promise<void> => {
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setStatus('error')
        setMessage('Voice capture needs a secure context (or a newer browser).')
        return
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        setStatus('error')
        setMessage('Microphone unavailable — check the mic permission for Kairos.')
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []
      rec.ondataavailable = (e): void => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      const stopWatching = watchForSilence(stream, () => {
        if (rec.state === 'recording') rec.stop()
      })
      cleanup = (): void => {
        stopWatching()
        if (rec.state === 'recording') rec.stop()
        stream.getTracks().forEach((t) => t.stop())
      }
      rec.onstop = async (): Promise<void> => {
        stopWatching()
        stream.getTracks().forEach((t) => t.stop())
        if (cancelled) return
        setStatus('transcribing')
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        const stt = await api.invoke('stt:transcribe', await blobToBase64(blob), blob.type.split(';')[0])
        if (cancelled) return
        if (!stt.ok) {
          setStatus('error')
          setMessage(stt.message)
          return
        }
        if (!stt.text.trim()) {
          setStatus('error')
          setMessage('Heard nothing — try again.')
          return
        }
        setStatus('working')
        setMessage(stt.text)
        const res = await api.invoke('capture:instruct', stt.text, context ?? undefined)
        if (cancelled) return
        setStatus(res.ok ? 'done' : 'error')
        setMessage(res.message)
        if (res.ok) setTimeout(onClose, 1600)
      }
      recRef.current = rec
      rec.start()
    }
    void run()

    return () => {
      cancelled = true
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="bg-overlay border border-border-strong rounded-xl shadow-2xl overflow-hidden p-6 space-y-3">
      <div className="flex items-center gap-3">
        {status === 'recording' && <Mic size={18} className="text-danger animate-pulse shrink-0" />}
        {(status === 'transcribing' || status === 'working') && (
          <Loader2 size={18} className="text-accent animate-spin shrink-0" />
        )}
        {status === 'done' && <Check size={18} className="text-ok shrink-0" />}
        {status === 'error' && <CircleAlert size={18} className="text-danger shrink-0" />}
        <div className="min-w-0">
          <p className="text-[13.5px] text-text">
            {status === 'recording' && 'Listening — speak your command, stops when you pause'}
            {status === 'transcribing' && 'Transcribing…'}
            {status === 'working' && 'Working on it…'}
            {(status === 'done' || status === 'error') && message}
          </p>
          {status === 'working' && message && (
            <p className="text-[11.5px] text-faint truncate">“{message}”</p>
          )}
        </div>
      </div>
      {context && status === 'recording' && (
        <p className="text-[11.5px] text-faint">
          Looking at: <span className="text-muted">{context.label}</span> — “make this a task for
          tomorrow” works.
        </p>
      )}
      <div className="flex justify-end gap-2">
        {status === 'recording' && (
          <button
            onClick={() => recRef.current?.stop()}
            className={cn('px-2.5 py-1 rounded-md text-[12px] bg-raised text-muted hover:text-text')}
          >
            stop now
          </button>
        )}
        <button
          onClick={onClose}
          className="px-2.5 py-1 rounded-md text-[12px] text-faint hover:text-text"
        >
          cancel
        </button>
      </div>
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-faint px-1.5">
      {children}
    </span>
  )
}

function Item({
  children,
  onSelect,
  keywords
}: {
  children: React.ReactNode
  onSelect: () => void
  keywords?: string[]
}): React.JSX.Element {
  return (
    <Command.Item
      onSelect={onSelect}
      keywords={keywords}
      className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] text-muted cursor-pointer data-[selected=true]:bg-raised data-[selected=true]:text-text"
    >
      {children}
    </Command.Item>
  )
}
