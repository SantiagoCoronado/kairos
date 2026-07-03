import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { Sun, Users, CheckSquare, Target, Sparkles, Plus, User, FileDown, PanelLeft, Inbox, StickyNote, Bot, Terminal, CalendarDays } from 'lucide-react'
import type { Person } from '../../../core/types'
import type { ViewId } from './Sidebar'
import { api } from '../lib/api'

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
