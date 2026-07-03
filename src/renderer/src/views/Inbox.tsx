import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Link2,
  SlidersHorizontal,
  PenLine,
  Send,
  Plus,
  Trash2,
  Archive,
  ArchiveRestore,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles
} from 'lucide-react'
import type {
  CommsAccount,
  CommsThread,
  CommsThreadListItem,
  CommsMessage,
  CommsProvider
} from '../../../core/comms-types'
import { api, useInvoke } from '../lib/api'
import { Input, Button, Chip, EmptyState, cn } from '../components/ui'
import { SettingsModal } from '../components/SettingsModal'

const PROVIDER_ICON: Record<CommsProvider, typeof Mail> = {
  gmail: Mail,
  slack: MessageSquare,
  whatsapp: Phone
}

const RAIL_W_KEY = 'kairos.inbox.railW'
const LIST_W_KEY = 'kairos.inbox.listW'
const RAIL_COLLAPSED_KEY = 'kairos.inbox.railCollapsed'
const RAIL_W = { def: 176, min: 140, max: 280 }
const LIST_W = { def: 320, min: 240, max: 480 }

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

const storedWidth = (key: string, spec: { def: number; min: number; max: number }): number => {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw > 0 ? clamp(raw, spec.min, spec.max) : spec.def
}

const timeAgo = (iso: string | null): string => {
  if (!iso) return ''
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`
  return `${Math.floor(mins / (60 * 24))}d`
}

/** true while any input/textarea/select (or editable node) has focus — shortcuts stay inert */
const isTyping = (): boolean => {
  const el = document.activeElement
  return (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  )
}

/** read drop position from the pointer: top half = before, bottom = after */
function dropEdge(e: React.DragEvent): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** Person-aware display: DMs adopt the linked person's name; emails/groups keep the title. */
function threadLabel(t: CommsThreadListItem): { name: string | null; title: string } {
  if (!t.person_name) return { name: null, title: t.title || '(untitled)' }
  if (t.kind === 'dm') return { name: null, title: t.person_name }
  return { name: t.person_name, title: t.title || '(untitled)' }
}

export function InboxView({ onOpenPerson }: { onOpenPerson?: (id: string) => void }): React.JSX.Element {
  const [accountId, setAccountId] = useState<string | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [box, setBox] = useState<'inbox' | 'archived'>('inbox')
  const [search, setSearch] = useState('')
  const [threadId, setThreadId] = useState<string | null>(null)
  // the opened thread stays in the list even when a filter (Unread) would now
  // exclude it — otherwise opening an unread email makes it vanish mid-read
  const [pinned, setPinned] = useState<CommsThreadListItem | null>(null)
  const [mode, setMode] = useState<'threads' | 'channels' | 'compose'>('threads')
  const [showSettings, setShowSettings] = useState(false)

  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'
  )
  const [railW, setRailW] = useState(() => storedWidth(RAIL_W_KEY, RAIL_W))
  const [listW, setListW] = useState(() => storedWidth(LIST_W_KEY, LIST_W))

  const { data: accounts } = useInvoke('comms:accounts', [], ['comms'])
  const { data: threads } = useInvoke(
    'comms:threads',
    [{ accountId: accountId ?? undefined, unreadOnly, box, search: search || undefined }],
    ['comms']
  )

  // filter changes drop the pin (and with it, eventually, the selection)
  useEffect(() => {
    setPinned(null)
  }, [accountId, unreadOnly, box, search])

  const displayThreads = useMemo(() => {
    if (!threads) return threads
    if (!pinned || threads.some((t) => t.id === pinned.id)) return threads
    return [...threads, pinned].sort((a, b) =>
      (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '')
    )
  }, [threads, pinned])

  const selectedAccount = accounts?.find((a) => a.id === accountId) ?? null
  const thread = displayThreads?.find((t) => t.id === threadId) ?? null

  // keep selection valid when the thread leaves both the list and the pin
  useEffect(() => {
    if (threadId && displayThreads && !displayThreads.some((t) => t.id === threadId)) {
      setThreadId(null)
    }
  }, [displayThreads, threadId])

  const openThread = (t: CommsThreadListItem): void => {
    setThreadId(t.id)
    setPinned({ ...t, unread_count: 0 })
    setMode('threads')
    if (t.unread_count > 0) void api.invoke('comms:markRead', t.id)
  }

  const closeThread = (): void => {
    setThreadId(null)
    setPinned(null)
  }

  /**
   * Archive/delete UX: slide the row out first, run the action, then advance
   * to the next conversation (previous at the end of the list). Returns an
   * error message, or null on success.
   */
  const [leavingId, setLeavingId] = useState<string | null>(null)
  const removeWithAnimation = async (
    id: string,
    action: () => Promise<{ ok: true } | { ok: false; message: string }>
  ): Promise<string | null> => {
    const list = displayThreads ?? []
    const idx = list.findIndex((t) => t.id === id)
    const next = list[idx + 1] ?? list[idx - 1] ?? null
    setLeavingId(id)
    await new Promise((r) => setTimeout(r, 200))
    const res = await action()
    setLeavingId(null)
    if (!res.ok) return res.message
    if (next) openThread(next)
    else closeThread()
    return null
  }

  const archiveThread = (t: CommsThreadListItem): Promise<string | null> =>
    removeWithAnimation(t.id, () => api.invoke('comms:archiveThread', t.id, t.is_archived !== 1))

  const deleteThread = (t: CommsThreadListItem): Promise<string | null> =>
    removeWithAnimation(t.id, () => api.invoke('comms:deleteThread', t.id))

  /** mark unread and return to the list — "leave it for later" */
  const markUnread = (t: CommsThreadListItem): void => {
    void api.invoke('comms:markUnread', t.id)
    closeThread()
  }

  const selectAccount = (id: string | null): void => {
    setAccountId(id)
    setMode('threads')
  }

  // keyboard: j/k or ↓/↑ move through the list, esc closes, / searches,
  // u toggles Unread, c composes (gmail). Archive/delete live in ThreadPane.
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping()) return
      if (mode !== 'threads') {
        if (e.key === 'Escape') setMode('threads')
        return
      }
      const list = displayThreads ?? []
      const idx = threadId ? list.findIndex((t) => t.id === threadId) : -1
      if (e.key === 'j' || e.key === 'ArrowDown') {
        const next = list[idx + 1]
        if (next) {
          e.preventDefault()
          openThread(next)
        }
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        if (idx > 0) {
          e.preventDefault()
          openThread(list[idx - 1])
        }
      } else if (e.key === 'Escape') {
        closeThread()
      } else if (e.key === '/') {
        e.preventDefault()
        document.getElementById('inbox-search')?.focus()
      } else if (e.key === 'c' && selectedAccount?.provider === 'gmail') {
        e.preventDefault()
        setMode('compose')
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [displayThreads, threadId, mode, selectedAccount])

  const dropAccount = (draggedId: string, target: CommsAccount, edge: 'before' | 'after'): void => {
    if (!accounts || draggedId === target.id) return
    let beforeId: string | null
    if (edge === 'before') {
      beforeId = target.id
    } else {
      const rest = accounts.filter((a) => a.id !== draggedId)
      const i = rest.findIndex((a) => a.id === target.id)
      beforeId = rest[i + 1]?.id ?? null
    }
    void api.invoke('comms:reorderAccount', draggedId, beforeId)
  }

  const startResize = (e: React.MouseEvent, which: 'rail' | 'list'): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = which === 'rail' ? railW : listW
    const spec = which === 'rail' ? RAIL_W : LIST_W
    let latest = startW
    const move = (ev: MouseEvent): void => {
      latest = clamp(startW + ev.clientX - startX, spec.min, spec.max)
      if (which === 'rail') setRailW(latest)
      else setListW(latest)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      localStorage.setItem(which === 'rail' ? RAIL_W_KEY : LIST_W_KEY, String(latest))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const toggleRail = (): void => {
    setRailCollapsed((c) => {
      localStorage.setItem(RAIL_COLLAPSED_KEY, c ? '0' : '1')
      return !c
    })
  }

  if (accounts && accounts.length === 0) {
    return (
      <EmptyState>
        No accounts connected yet — open Settings (sidebar gear) → Connections.
      </EmptyState>
    )
  }

  return (
    <div className="flex h-full">
      {/* account rail */}
      <div
        className="relative shrink-0 border-r border-border flex flex-col py-2 px-1.5 space-y-0.5"
        style={{ width: railCollapsed ? 44 : railW }}
      >
        <AccountRow
          active={accountId === null}
          collapsed={railCollapsed}
          label="All inboxes"
          icon={Mail}
          onClick={() => selectAccount(null)}
        />
        {accounts?.map((a) => (
          <AccountRow
            key={a.id}
            active={accountId === a.id}
            collapsed={railCollapsed}
            label={a.display_name}
            icon={PROVIDER_ICON[a.provider]}
            status={a.status}
            onClick={() => selectAccount(a.id)}
            account={a}
            onDrop={dropAccount}
            onDeleted={() => {
              if (accountId === a.id) selectAccount(null)
            }}
          />
        ))}
        <AddAccount collapsed={railCollapsed} onWhatsApp={() => setShowSettings(true)} />
        <div className="flex-1" />
        <div
          className={cn(
            'px-1 pt-2 border-t border-border flex items-center gap-1',
            railCollapsed && 'justify-center'
          )}
        >
          {!railCollapsed && (
            <Button
              variant="ghost"
              className="flex-1 !py-1 text-[11px]"
              title="Sync now"
              onClick={() => void api.invoke('comms:syncNow', accountId ?? undefined)}
            >
              <RefreshCw size={12} className="inline mr-1" />
              sync
            </Button>
          )}
          <button
            onClick={toggleRail}
            title={railCollapsed ? 'Expand accounts' : 'Collapse accounts'}
            className="shrink-0 h-6 w-6 rounded flex items-center justify-center text-faint hover:text-text hover:bg-raised"
          >
            {railCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
          </button>
        </div>
        {!railCollapsed && <ResizeHandle onMouseDown={(e) => startResize(e, 'rail')} />}
      </div>

      {/* thread list / channel manager */}
      <div className="relative shrink-0 border-r border-border flex flex-col" style={{ width: listW }}>
        <div className="p-3 space-y-2 border-b border-border">
          <Input
            id="inbox-search"
            className="w-full"
            placeholder="Search conversations… ( / )"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (e.target as HTMLInputElement).blur()}
          />
          <div className="flex items-center gap-1.5">
            <FilterButton active={box === 'archived'} onClick={() => setBox(box === 'archived' ? 'inbox' : 'archived')}>
              Archived
            </FilterButton>
            <FilterButton active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
              Unread
            </FilterButton>
            {selectedAccount?.provider === 'slack' && (
              <button
                onClick={() => setMode(mode === 'channels' ? 'threads' : 'channels')}
                className={cn(
                  'px-2 py-1 rounded text-[11.5px] border transition-colors inline-flex items-center gap-1',
                  mode === 'channels'
                    ? 'bg-raised border-border-strong text-text'
                    : 'border-border text-muted hover:text-text'
                )}
                title="Choose which channels to sync"
              >
                <SlidersHorizontal size={11} /> Channels
              </button>
            )}
            {selectedAccount?.provider === 'gmail' && (
              <button
                onClick={() => setMode(mode === 'compose' ? 'threads' : 'compose')}
                className={cn(
                  'px-2 py-1 rounded text-[11.5px] border transition-colors inline-flex items-center gap-1',
                  mode === 'compose'
                    ? 'bg-raised border-border-strong text-text'
                    : 'border-border text-muted hover:text-text'
                )}
              >
                <PenLine size={11} /> Compose
              </button>
            )}
          </div>
          {selectedAccount?.status === 'error' && (
            <p className="text-[11px] text-danger truncate" title={selectedAccount.error ?? ''}>
              sync error: {selectedAccount.error}
            </p>
          )}
          {selectedAccount?.status === 'needs_auth' && (
            <p className="text-[11px] text-danger">needs reconnect — Settings → Connections</p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {mode === 'channels' && selectedAccount ? (
            <ChannelManager account={selectedAccount} />
          ) : (
            <>
              {displayThreads?.length === 0 && <EmptyState>Nothing here yet.</EmptyState>}
              {displayThreads?.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  showProvider={accountId === null}
                  active={threadId === t.id}
                  leaving={leavingId === t.id}
                  onClick={() => openThread(t)}
                />
              ))}
            </>
          )}
        </div>
        <ResizeHandle onMouseDown={(e) => startResize(e, 'list')} />
      </div>

      {/* message pane */}
      <div className="flex-1 min-w-0 flex flex-col">
        {mode === 'compose' && selectedAccount ? (
          <ComposePane account={selectedAccount} onSent={() => setMode('threads')} />
        ) : thread ? (
          <ThreadPane
            key={thread.id}
            thread={thread}
            onOpenPerson={onOpenPerson}
            onArchive={() => archiveThread(thread)}
            onDelete={() => deleteThread(thread)}
            onMarkUnread={() => markUnread(thread)}
          />
        ) : (
          <EmptyState>Select a conversation.</EmptyState>
        )}
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}

/** 4px grab strip over a column's right border. */
function ResizeHandle({
  onMouseDown
}: {
  onMouseDown: (e: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-accent/30 z-10"
      onMouseDown={onMouseDown}
    />
  )
}

function FilterButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2 py-1 rounded text-[11.5px] border transition-colors',
        active ? 'bg-accent/15 border-accent/40 text-accent' : 'border-border text-muted hover:text-text'
      )}
    >
      {children}
    </button>
  )
}

function AccountRow({
  active,
  collapsed,
  label,
  icon: Icon,
  status,
  onClick,
  account,
  onDrop,
  onDeleted
}: {
  active: boolean
  collapsed: boolean
  label: string
  icon: typeof Mail
  status?: CommsAccount['status']
  onClick: () => void
  /** present on real accounts — enables drag-reorder and delete */
  account?: CommsAccount
  onDrop?: (draggedId: string, target: CommsAccount, edge: 'before' | 'after') => void
  onDeleted?: () => void
}): React.JSX.Element {
  const [dragArmed, setDragArmed] = useState(false)
  const [edge, setEdge] = useState<'before' | 'after' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const draggable = Boolean(account)

  const remove = (): void => {
    if (!account) return
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 3000)
      return
    }
    void api.invoke('comms:disconnect', account.id)
    onDeleted?.()
  }

  return (
    <div
      className={cn(
        'group relative rounded-md',
        edge === 'before' && 'shadow-[inset_0_2px_0_0_var(--color-accent)]',
        edge === 'after' && 'shadow-[inset_0_-2px_0_0_var(--color-accent)]'
      )}
      draggable={draggable && dragArmed}
      onDragStart={(e) => {
        if (!account) return
        e.dataTransfer.setData('text/kairos-account', account.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => setDragArmed(false)}
      onMouseUp={() => setDragArmed(false)}
      onDragOver={(e) => {
        if (!account || !e.dataTransfer.types.includes('text/kairos-account')) return
        e.preventDefault()
        setEdge(dropEdge(e))
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        if (!account) return
        e.preventDefault()
        setEdge(null)
        const id = e.dataTransfer.getData('text/kairos-account')
        if (id) onDrop?.(id, account, dropEdge(e))
      }}
    >
      <button
        onClick={onClick}
        onMouseDown={() => draggable && setDragArmed(true)}
        className={cn(
          'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
          collapsed && 'justify-center px-0',
          active ? 'bg-raised text-text' : 'text-muted hover:text-text hover:bg-raised/50'
        )}
        title={label}
      >
        <span className="relative shrink-0">
          <Icon size={13} strokeWidth={1.75} />
          {collapsed && status && status !== 'connected' && (
            <span
              className={cn(
                'absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full',
                status === 'needs_auth' || status === 'error' ? 'bg-danger' : 'bg-faint'
              )}
              title={status}
            />
          )}
        </span>
        {!collapsed && (
          <>
            <span className="text-[12px] truncate flex-1">{label}</span>
            {status && status !== 'connected' && (
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  status === 'needs_auth' || status === 'error' ? 'bg-danger' : 'bg-faint'
                )}
                title={status}
              />
            )}
          </>
        )}
      </button>
      {!collapsed && account && (
        <button
          onClick={remove}
          title={confirming ? 'Click again to remove this account' : 'Remove account'}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 rounded flex items-center justify-center',
            confirming
              ? 'text-danger bg-danger/15'
              : 'text-faint hover:text-danger opacity-0 group-hover:opacity-100'
          )}
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  )
}

function AddAccount({
  collapsed,
  onWhatsApp
}: {
  collapsed: boolean
  onWhatsApp: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<CommsProvider | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = async (provider: 'gmail' | 'slack'): Promise<void> => {
    if (busy) return
    setBusy(provider)
    setError(null)
    const res = await api.invoke(provider === 'gmail' ? 'comms:connectGmail' : 'comms:connectSlack')
    setBusy(null)
    if (res.ok) setOpen(false)
    else setError(res.message)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Add account"
        className={cn(
          'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-faint hover:text-text hover:bg-raised/50 transition-colors',
          collapsed && 'justify-center px-0'
        )}
      >
        <Plus size={13} className="shrink-0" />
        {!collapsed && <span className="text-[12px]">add account</span>}
      </button>
      {open && (
        <div className="absolute left-full top-0 ml-1 z-30 w-52 bg-overlay border border-border-strong rounded-lg shadow-xl p-1.5 space-y-0.5">
          {(['gmail', 'slack'] as const).map((p) => {
            const Icon = PROVIDER_ICON[p]
            return (
              <button
                key={p}
                disabled={busy !== null}
                onClick={() => void connect(p)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12.5px] hover:bg-raised disabled:opacity-40"
              >
                <Icon size={13} />
                {busy === p ? `connecting ${p}…` : p === 'gmail' ? 'Gmail' : 'Slack'}
              </button>
            )
          })}
          <button
            disabled={busy !== null}
            onClick={() => {
              setOpen(false)
              onWhatsApp()
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12.5px] hover:bg-raised disabled:opacity-40"
          >
            <Phone size={13} />
            WhatsApp (QR in Settings)
          </button>
          {error && <p className="px-2 py-1 text-[11px] text-danger">{error}</p>}
        </div>
      )}
    </div>
  )
}

function ThreadRow({
  thread,
  active,
  showProvider,
  leaving,
  onClick
}: {
  thread: CommsThreadListItem
  active: boolean
  showProvider: boolean
  /** plays the exit animation (slide right + collapse) before removal */
  leaving: boolean
  onClick: () => void
}): React.JSX.Element {
  const Icon = PROVIDER_ICON[thread.provider]
  const { name, title } = threadLabel(thread)
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 overflow-hidden transition-all duration-200 ease-out',
        leaving
          ? 'py-0 max-h-0 opacity-0 translate-x-6'
          : 'py-2 max-h-20 border-b border-border/50 hover:bg-raised/50',
        active && !leaving && 'bg-raised'
      )}
    >
      <div className="flex items-center gap-1.5">
        {showProvider && <Icon size={11} className="shrink-0 text-faint" />}
        <span
          className={cn(
            'text-[13px] truncate flex-1',
            thread.unread_count > 0 && 'font-semibold'
          )}
        >
          {name && <span className="text-accent">{name} · </span>}
          {title}
        </span>
        <span className="font-mono text-[10px] text-faint shrink-0">
          {timeAgo(thread.last_message_at)}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="text-[11px] text-faint truncate flex-1">{thread.snippet}</span>
        {thread.unread_count > 0 && (
          <span className="shrink-0 min-w-4 h-4 px-1 rounded-full bg-accent/20 text-accent font-mono text-[10px] flex items-center justify-center">
            {thread.unread_count}
          </span>
        )}
      </div>
    </button>
  )
}

function ChannelManager({ account }: { account: CommsAccount }): React.JSX.Element {
  const { data: all } = useInvoke('comms:accountThreads', [account.id], ['comms'])
  const channels = useMemo(() => all?.filter((t) => t.kind === 'channel') ?? [], [all])
  return (
    <div>
      <p className="px-3 py-2 text-[11px] text-faint border-b border-border/50">
        Channels are off by default — pick the ones worth syncing.
      </p>
      {channels.length === 0 && <EmptyState>No channels found yet.</EmptyState>}
      {channels.map((c) => (
        <label
          key={c.id}
          className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 hover:bg-raised/50 cursor-pointer"
        >
          <input
            type="checkbox"
            checked={c.sync_enabled === 1}
            onChange={(e) => void api.invoke('comms:setThreadSync', c.id, e.target.checked)}
            className="accent-accent"
          />
          <span className="text-[12.5px] truncate"># {c.title}</span>
        </label>
      ))}
    </div>
  )
}

function ThreadPane({
  thread,
  onOpenPerson,
  onArchive,
  onDelete,
  onMarkUnread
}: {
  thread: CommsThreadListItem
  onOpenPerson?: (id: string) => void
  /** both resolve to an error message, or null on success */
  onArchive: () => Promise<string | null>
  onDelete: () => Promise<string | null>
  onMarkUnread: () => void
}): React.JSX.Element {
  const { data: messages } = useInvoke('comms:messages', [thread.id], ['comms'])
  const [actionError, setActionError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const archived = thread.is_archived === 1
  const { name, title } = threadLabel(thread)

  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [messages, thread.id])

  const toggleArchive = async (): Promise<void> => {
    if (acting) return
    setActing(true)
    setActionError(await onArchive())
    setActing(false)
  }

  // no confirm: deletes go to Gmail's trash, recoverable there for 30 days
  const remove = async (): Promise<void> => {
    if (acting) return
    setActing(true)
    setActionError(await onDelete())
    setActing(false)
  }

  // e = archive, ⌫ = delete (email only — Slack/WhatsApp never delete),
  // u = mark unread + back to list, r = focus the reply box
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping()) return
      if (e.key === 'e') {
        void toggleArchive()
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && thread.provider === 'gmail') {
        void remove()
      } else if (e.key === 'u') {
        onMarkUnread()
      } else if (e.key === 'r') {
        e.preventDefault()
        document.getElementById('inbox-reply')?.focus()
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [thread.id, thread.provider, archived])

  return (
    <>
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <span className="text-[13.5px] font-medium truncate flex-1">
          {thread.person_id && onOpenPerson ? (
            <>
              <button
                className="text-accent hover:underline"
                onClick={() => onOpenPerson(thread.person_id!)}
              >
                {name ?? title}
              </button>
              {name && <span> · {title}</span>}
            </>
          ) : (
            <>
              {name && <span className="text-accent">{name} · </span>}
              {title}
            </>
          )}
        </span>
        <button
          onClick={onMarkUnread}
          title="Mark as unread (u)"
          className="shrink-0 h-6 w-6 rounded flex items-center justify-center text-muted hover:text-text hover:bg-raised"
        >
          <Mail size={14} />
        </button>
        <button
          onClick={() => void toggleArchive()}
          title={archived ? 'Move back to inbox (e)' : 'Archive (e)'}
          className="shrink-0 h-6 w-6 rounded flex items-center justify-center text-muted hover:text-text hover:bg-raised"
        >
          {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </button>
        {thread.provider === 'gmail' && (
          <button
            onClick={() => void remove()}
            title="Delete (⌫) — moves to Gmail trash"
            className="shrink-0 h-6 w-6 rounded flex items-center justify-center text-muted hover:text-danger hover:bg-raised"
          >
            <Trash2 size={14} />
          </button>
        )}
        <Chip tone="muted">{thread.provider}</Chip>
      </div>
      {actionError && (
        <p className="px-4 py-1 text-[11.5px] text-danger border-b border-border">{actionError}</p>
      )}
      <div className="fade-in flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {messages?.map((m) => (
          <MessageBubble key={m.id} message={m} onOpenPerson={onOpenPerson} />
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer thread={thread} />
    </>
  )
}

function MessageBubble({
  message: m,
  onOpenPerson
}: {
  message: CommsMessage
  onOpenPerson?: (id: string) => void
}): React.JSX.Element {
  const [linking, setLinking] = useState(false)
  const when = new Date(m.sent_at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  const html = m.body_html
  return (
    <div className={cn(html ? 'max-w-full' : 'max-w-[85%]', m.is_me ? 'ml-auto' : '')}>
      <div className="flex items-baseline gap-2 mb-0.5 relative">
        {m.is_me ? (
          <span className="text-[11px] text-faint ml-auto">{when}</span>
        ) : (
          <>
            {m.person_id && onOpenPerson ? (
              <button
                className="text-[12px] font-medium text-accent hover:underline"
                onClick={() => onOpenPerson(m.person_id!)}
              >
                {m.sender_name}
              </button>
            ) : (
              <span className="text-[12px] font-medium">{m.sender_name}</span>
            )}
            {!m.person_id && m.sender_handle && (
              <button
                className="text-faint hover:text-accent"
                title="Link sender to a person"
                onClick={() => setLinking((v) => !v)}
              >
                <Link2 size={11} />
              </button>
            )}
            <span className="text-[11px] text-faint">{when}</span>
            {linking && (
              <LinkSenderPopover message={m} onDone={() => setLinking(false)} />
            )}
          </>
        )}
      </div>
      {html ? (
        <div className="rounded-lg overflow-hidden border border-border bg-white">
          <HtmlBody html={html} />
        </div>
      ) : (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap break-words',
            m.is_me ? 'bg-accent/10 border border-accent/20' : 'bg-panel border border-border'
          )}
        >
          {m.body_text || <span className="text-faint italic">(no text)</span>}
        </div>
      )}
      {m.has_attachments === 1 && (
        <div className="mt-1 text-[11px] text-faint">📎 has attachment (open in the app)</div>
      )}
    </div>
  )
}

/**
 * Sandboxed HTML email renderer. allow-same-origin without allow-scripts means
 * no execution is possible while still letting us measure height and intercept
 * link clicks; the CSP is the second lock (no scripts/frames/forms — images,
 * inline styles and fonts only).
 */
function HtmlBody({ html }: { html: string }): React.JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)

  const doc = useMemo(
    () =>
      `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data: cid:; style-src 'unsafe-inline' http: https:; font-src http: https: data:">
<base target="_blank">
<style>
  html { color-scheme: light; }
  body { margin: 0; padding: 12px; background: #fff; color: #111;
         font: 13px/1.45 -apple-system, system-ui, sans-serif; word-break: break-word; }
  img { max-width: 100%; height: auto; }
</style>
</head><body>${html}</body></html>`,
    [html]
  )

  const measure = (): void => {
    const body = ref.current?.contentDocument?.body
    if (body) setHeight(clamp(body.scrollHeight + 4, 40, 2000))
  }

  const onLoad = (): void => {
    measure()
    // images may finish after the load event; settle once more
    setTimeout(measure, 500)
    const cdoc = ref.current?.contentDocument
    if (!cdoc) return
    cdoc.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a')
      if (a?.href) {
        e.preventDefault()
        window.open(a.href) // routed to the system browser by the main process
      }
    })
  }

  return (
    <iframe
      ref={ref}
      sandbox="allow-same-origin"
      srcDoc={doc}
      onLoad={onLoad}
      style={{ height }}
      className="w-full block"
      title="email"
    />
  )
}

function LinkSenderPopover({
  message: m,
  onDone
}: {
  message: CommsMessage
  onDone: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const { data: persons } = useInvoke('people:list', [{ search: query || undefined }], ['people'])
  return (
    <div className="absolute top-5 left-0 z-30 w-60 bg-overlay border border-border-strong rounded-lg shadow-xl p-2 space-y-1.5">
      <Input
        autoFocus
        className="w-full"
        placeholder={`Link ${m.sender_name || m.sender_handle} to…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onDone()}
      />
      <div className="max-h-44 overflow-y-auto">
        {persons?.slice(0, 8).map((p) => (
          <button
            key={p.id}
            className="w-full text-left px-2 py-1 rounded text-[12.5px] hover:bg-raised"
            onClick={() => {
              void api.invoke('comms:linkSender', m.provider, m.sender_handle, p.id)
              onDone()
            }}
          >
            {p.name}
            {p.company && <span className="text-faint"> · {p.company}</span>}
          </button>
        ))}
        {persons?.length === 0 && <p className="px-2 py-1 text-[11.5px] text-faint">no matches</p>}
      </div>
    </div>
  )
}

function Composer({ thread }: { thread: CommsThread }): React.JSX.Element {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [drafting, setDrafting] = useState(false)

  const send = async (): Promise<void> => {
    const text = body.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    const res = await api.invoke('comms:send', {
      accountId: thread.account_id,
      threadId: thread.id,
      body: text
    })
    setSending(false)
    if (res.ok) setBody('')
    else setError(res.message)
  }

  // only ever runs when the user presses Draft — never automatic
  const draft = async (): Promise<void> => {
    if (drafting) return
    setDrafting(true)
    setError(null)
    const res = await api.invoke('chat:draft', {
      threadId: thread.id,
      instruction: instruction.trim() || undefined
    })
    setDrafting(false)
    if (res.ok) {
      setBody((prev) => (prev.trim() ? `${prev}\n\n${res.draft}` : res.draft))
      setAiOpen(false)
      setInstruction('')
    } else {
      setError(res.message)
    }
  }

  return (
    <div className="border-t border-border p-3 space-y-1.5">
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
      {aiOpen && (
        <div className="flex gap-2 items-center">
          <Input
            autoFocus
            className="flex-1"
            placeholder="Optional: what should the reply say? (e.g. decline politely)"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void draft()
              if (e.key === 'Escape') setAiOpen(false)
            }}
          />
          <Button variant="accent" disabled={drafting} onClick={() => void draft()}>
            <Sparkles size={12} className="inline mr-1" />
            {drafting ? 'drafting…' : 'Draft'}
          </Button>
        </div>
      )}
      <div className="flex gap-2 items-end">
        <textarea
          id="inbox-reply"
          className="flex-1 bg-raised border border-border rounded-md px-2.5 py-1.5 text-[13px] text-text placeholder:text-faint focus:outline-none focus:border-border-strong resize-none"
          rows={2}
          placeholder="Reply… ⌘↩ to send"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
          }}
        />
        <button
          onClick={() => setAiOpen((v) => !v)}
          title="Draft a reply with AI"
          className={cn(
            'shrink-0 h-8 w-8 rounded-md border flex items-center justify-center transition-colors',
            aiOpen
              ? 'bg-accent/15 border-accent/40 text-accent'
              : 'border-border text-muted hover:text-text'
          )}
        >
          <Sparkles size={14} />
        </button>
        <Button variant="accent" disabled={!body.trim() || sending} onClick={() => void send()}>
          <Send size={13} className="inline mr-1" />
          {sending ? 'sending…' : 'send'}
        </Button>
      </div>
    </div>
  )
}

function ComposePane({
  account,
  onSent
}: {
  account: CommsAccount
  onSent: () => void
}): React.JSX.Element {
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (): Promise<void> => {
    if (sending) return
    setSending(true)
    setError(null)
    const res = await api.invoke('comms:send', {
      accountId: account.id,
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      subject: subject.trim(),
      body: body.trim()
    })
    setSending(false)
    if (res.ok) onSent()
    else setError(res.message)
  }

  return (
    <div className="p-4 space-y-2 max-w-2xl">
      <p className="font-mono text-[10px] uppercase tracking-wider text-faint">
        new email · {account.display_name}
      </p>
      <Input
        className="w-full"
        placeholder="To (comma-separated)"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <Input
        className="w-full"
        placeholder="Subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        className="w-full bg-raised border border-border rounded-md px-2.5 py-1.5 text-[13px] text-text placeholder:text-faint focus:outline-none focus:border-border-strong resize-none"
        rows={10}
        placeholder="Message"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
      <div className="flex justify-end">
        <Button
          variant="accent"
          disabled={!to.trim() || !subject.trim() || !body.trim() || sending}
          onClick={() => void send()}
        >
          <Send size={13} className="inline mr-1" />
          {sending ? 'sending…' : 'send'}
        </Button>
      </div>
    </div>
  )
}
