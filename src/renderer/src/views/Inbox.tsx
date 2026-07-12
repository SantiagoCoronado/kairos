import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Mail,
  RefreshCw,
  Hash,
  Link2,
  Unlink,
  SlidersHorizontal,
  PenLine,
  Send,
  Plus,
  Trash2,
  Archive,
  ArchiveRestore,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pin,
  Check,
  Sparkles,
  Tag,
  Play,
  Pause,
  Mic,
  ChevronLeft
} from 'lucide-react'
import type {
  CommsAccount,
  CommsAttachment,
  CommsThread,
  CommsThreadListItem,
  CommsMessage,
  CommsProvider,
  MessageSearchHit
} from '../../../core/comms-types'
import { COMMS_LABELS } from '../../../core/labels'
import { api, useInvoke } from '../lib/api'
import { useIsMobile } from '../lib/mobile'
import { Input, Button, Chip, EmptyState, cn } from '../components/ui'
import { SettingsModal } from '../components/SettingsModal'
import {
  GmailIcon,
  SlackIcon,
  WhatsAppIcon,
  type ProviderIconComponent
} from '../components/provider-icons'

const PROVIDER_ICON: Record<CommsProvider, ProviderIconComponent> = {
  gmail: GmailIcon,
  slack: SlackIcon,
  whatsapp: WhatsAppIcon
}

const RAIL_W_KEY = 'kairos.inbox.railW'
const LIST_W_KEY = 'kairos.inbox.listW'
const RAIL_COLLAPSED_KEY = 'kairos.inbox.railCollapsed'
const RAIL_W = { def: 176, min: 140, max: 280 }
const LIST_W = { def: 320, min: 240, max: 480 }

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/* --- mobile swipe-to-reveal on thread rows --------------------------------
   Same touch plumbing as useCalendarDrag: Chromium only delivers cancelable
   touchmoves to non-passive listeners pre-registered on the touched element
   itself, so each row registers the shared blocker at mount and it goes hot
   (preventDefault → no native scroll/pointercancel) only while a swipe owns
   the gesture. */
let swipeOwned = false
const blockScrollWhileSwiping = (e: TouchEvent): void => {
  if (swipeOwned) e.preventDefault()
}
const SWIPE_SLOP_PX = 10
const SWIPE_STRIP_W = 128 // two 64px action buttons per side
const SWIPE_COMMIT_FRACTION = 0.55 // full swipe left past this = archive

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

const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

/** Person-aware display: DMs adopt the linked person's name; emails prefix it; groups keep their subject (the latest sender's name is noise on a multi-person chat). */
function threadLabel(t: CommsThreadListItem): { name: string | null; title: string } {
  if (!t.person_name || t.kind === 'group') return { name: null, title: t.title || '(untitled)' }
  if (t.kind === 'dm') return { name: null, title: t.person_name }
  return { name: t.person_name, title: t.title || '(untitled)' }
}

export function InboxView({ onOpenPerson }: { onOpenPerson?: (id: string) => void }): React.JSX.Element {
  const mobile = useIsMobile()
  const [accountId, setAccountId] = useState<string | null>(null)
  // provider-wide view with no account selected ("All email" = every gmail inbox)
  const [provider, setProvider] = useState<CommsProvider | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [box, setBox] = useState<'inbox' | 'archived'>('inbox')
  const [search, setSearch] = useState('')
  const [threadId, setThreadId] = useState<string | null>(null)
  // the opened thread stays in the list even when a filter (Unread) would now
  // exclude it — otherwise opening an unread email makes it vanish mid-read.
  // (Unrelated to the user-facing pin feature — this is a selection snapshot.)
  const [heldThread, setHeldThread] = useState<CommsThreadListItem | null>(null)
  // archive/delete exit choreography (see removeWithAnimation). Leaving rows
  // are SNAPSHOTS: the refetch drops them from the data almost immediately,
  // and without the snapshot React would yank the row mid-fold (the "snap").
  const [leaving, setLeaving] = useState<ReadonlyMap<string, CommsThreadListItem>>(new Map())
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set())
  // which mobile row has its swipe actions revealed (one at a time, like iOS Mail)
  const [swipedId, setSwipedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [mode, setMode] = useState<'threads' | 'channels' | 'compose'>('threads')
  const [showSettings, setShowSettings] = useState(false)
  const [labelFilter, setLabelFilter] = useState<string | null>(null)

  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'
  )
  const [railW, setRailW] = useState(() => storedWidth(RAIL_W_KEY, RAIL_W))
  const [listW, setListW] = useState(() => storedWidth(LIST_W_KEY, LIST_W))

  // debounced: title/snippet LIKE is cheap but body search scans message
  // bodies — don't run either on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(t)
  }, [search])

  const { data: accounts } = useInvoke('comms:accounts', [], ['comms'])
  const { data: allLabels } = useInvoke('comms:labels', [], ['comms'])
  const { data: threads } = useInvoke(
    'comms:threads',
    [
      {
        accountId: accountId ?? undefined,
        provider: provider ?? undefined,
        unreadOnly,
        label: labelFilter ?? undefined,
        // searching spans everything — archived mail is where searches go to die
        box: debouncedSearch ? 'all' : box,
        search: debouncedSearch || undefined
      }
    ],
    ['comms']
  )

  // filter changes drop the held thread (and with it, eventually, the selection)
  useEffect(() => {
    setHeldThread(null)
  }, [accountId, provider, unreadOnly, box, labelFilter, debouncedSearch])

  // While a fold is playing, the list renders from a frozen copy of itself:
  // any re-render that moves or drops the animating row's DOM node cancels
  // the CSS transition mid-flight (the "snap"), so data updates simply wait
  // out the ~240ms. The freeze lifts the moment no row is leaving.
  const frozen = useRef<CommsThreadListItem[] | null>(null)
  const displayThreads = useMemo(() => {
    if (!threads) return threads
    if (leaving.size === 0) {
      frozen.current = null
    } else if (frozen.current) {
      return frozen.current
    }
    // acted-on threads stay hidden until the refetch drops them (no flicker)
    let list = hiddenIds.size ? threads.filter((t) => !hiddenIds.has(t.id)) : threads
    // the open thread survives filter refetches via its snapshot
    if (heldThread && !hiddenIds.has(heldThread.id) && !list.some((t) => t.id === heldThread.id)) {
      list = [...list, heldThread].sort(
        (a, b) =>
          b.pinned - a.pinned ||
          (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '')
      )
    }
    if (leaving.size > 0) frozen.current = list
    return list
  }, [threads, heldThread, leaving, hiddenIds])

  const selectedAccount = accounts?.find((a) => a.id === accountId) ?? null
  const thread = displayThreads?.find((t) => t.id === threadId) ?? null

  // keep selection valid when the thread leaves both the list and the held snapshot
  useEffect(() => {
    if (threadId && displayThreads && !displayThreads.some((t) => t.id === threadId)) {
      setThreadId(null)
    }
  }, [displayThreads, threadId])

  const openThread = (t: CommsThreadListItem): void => {
    setSwipedId(null)
    setThreadId(t.id)
    setHeldThread({ ...t, unread_count: 0 })
    setMode('threads')
    if (t.unread_count > 0) void api.invoke('comms:markRead', t.id)
  }

  const closeThread = (): void => {
    setThreadId(null)
    setHeldThread(null)
  }

  /**
   * Archive/delete UX: the row folds away in one motion (the pane swap waits
   * for the fold, so building the next email never steals animation frames),
   * the provider call runs in parallel, and the row stays hidden until the
   * refetch actually drops it (no flicker). On failure the row slides back in
   * and a transient banner explains why. Exits are independent, so rapid
   * triage never waits on the network.
   */
  const removeWithAnimation = (
    t: CommsThreadListItem,
    action: () => Promise<{ ok: true } | { ok: false; message: string }>
  ): void => {
    if (leaving.has(t.id)) return
    const list = (displayThreads ?? []).filter((x) => !leaving.has(x.id))
    const idx = list.findIndex((x) => x.id === t.id)
    const next = idx >= 0 ? (list[idx + 1] ?? list[idx - 1] ?? null) : null
    setLeaving((prev) => new Map(prev).set(t.id, t))
    const fold = new Promise((r) => setTimeout(r, 240))
    const pending = action()
    void (async () => {
      await fold
      // the row is at zero height now — drop it for real; the swap is invisible
      setHiddenIds((prev) => new Set(prev).add(t.id))
      setLeaving((prev) => {
        const m = new Map(prev)
        m.delete(t.id)
        return m
      })
      // advance only when the removed thread was the open one — a list-row
      // swipe on mobile must stay on the list, not surprise-open a thread
      if (threadId === t.id) {
        if (next) openThread(next)
        else closeThread()
      }
      const res = await pending
      if (!res.ok) {
        setHiddenIds((prev) => {
          const s = new Set(prev)
          s.delete(t.id)
          return s
        })
        setActionError(res.message)
        setTimeout(() => setActionError(null), 5000)
      }
    })()
  }

  // once the refetched data no longer contains a hidden thread, forget it
  useEffect(() => {
    if (!threads || hiddenIds.size === 0) return
    const still = [...hiddenIds].filter((id) => threads.some((t) => t.id === id))
    if (still.length !== hiddenIds.size) setHiddenIds(new Set(still))
  }, [threads, hiddenIds])

  const archiveThread = (t: CommsThreadListItem): void =>
    removeWithAnimation(t, () => api.invoke('comms:archiveThread', t.id, t.is_archived !== 1))

  const deleteThread = (t: CommsThreadListItem): void =>
    removeWithAnimation(t, () => api.invoke('comms:deleteThread', t.id))

  /** mark unread but keep it open — the badge flips, reading continues */
  const markUnread = (t: CommsThreadListItem): void => {
    void api.invoke('comms:markUnread', t.id)
  }

  /** pin/unpin — local-only, floats the thread to the top of the list */
  const togglePin = (t: CommsThreadListItem): void => {
    const next = t.pinned !== 1
    // keep the held snapshot honest so the header icon flips even when the
    // thread is only in the list via the snapshot (e.g. under the Unread filter)
    setHeldThread((h) => (h && h.id === t.id ? { ...h, pinned: next ? 1 : 0 } : h))
    void api.invoke('comms:pinThread', t.id, next)
  }

  const selectAccount = (id: string | null): void => {
    setAccountId(id)
    setProvider(null)
    setMode('threads')
  }

  /** account-less provider view: "All email" shows every gmail account merged */
  const selectProvider = (p: CommsProvider): void => {
    setAccountId(null)
    setProvider(p)
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

  // channel manager and compose are desktop modes; shrinking mid-mode
  // must not strand the phone on a pane it has no button to leave
  useEffect(() => {
    if (mobile && mode !== 'threads') setMode('threads')
  }, [mobile, mode])

  if (accounts && accounts.length === 0) {
    return (
      <EmptyState>
        No accounts connected yet — open Settings (sidebar gear) → Connections.
      </EmptyState>
    )
  }

  if (mobile) {
    return (
      <div className="flex flex-col h-full">
        {thread ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <ThreadPane
              key={thread.id}
              thread={thread}
              onBack={closeThread}
              onOpenPerson={onOpenPerson}
              onArchive={() => archiveThread(thread)}
              onDelete={() => deleteThread(thread)}
              onMarkUnread={() => markUnread(thread)}
              onTogglePin={() => togglePin(thread)}
            />
          </div>
        ) : (
          <>
            <div className="px-3 pt-2 pb-2 space-y-2 border-b border-border">
              <div className="flex gap-1.5 overflow-x-auto -mx-3 px-3 pb-0.5">
                <MobileAccountChip
                  active={accountId === null && provider === null}
                  label="All"
                  onClick={() => selectAccount(null)}
                />
                {accounts?.some((a) => a.provider === 'gmail') && (
                  <MobileAccountChip
                    active={accountId === null && provider === 'gmail'}
                    label="All email"
                    onClick={() => selectProvider('gmail')}
                  />
                )}
                {accounts?.map((a) => (
                  <MobileAccountChip
                    key={a.id}
                    active={accountId === a.id}
                    label={a.display_name}
                    error={a.status === 'error' || a.status === 'needs_auth'}
                    onClick={() => selectAccount(a.id)}
                  />
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  className="flex-1"
                  placeholder="Search conversations…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <FilterButton
                  active={box === 'archived'}
                  onClick={() => setBox(box === 'archived' ? 'inbox' : 'archived')}
                >
                  Archived
                </FilterButton>
                <FilterButton active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
                  Unread
                </FilterButton>
              </div>
              {actionError && (
                <p className="text-[11px] text-danger truncate" title={actionError}>
                  {actionError}
                </p>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {displayThreads?.length === 0 && !debouncedSearch && (
                <EmptyState>Nothing here yet.</EmptyState>
              )}
              {displayThreads?.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  showProvider={accountId === null && provider === null}
                  active={false}
                  leaving={leaving.has(t.id)}
                  onClick={() => openThread(t)}
                  onTogglePin={() => togglePin(t)}
                  swipe={{
                    isOpen: swipedId === t.id,
                    onOpenChange: (open) =>
                      setSwipedId((cur) => (open ? t.id : cur === t.id ? null : cur)),
                    onArchive: () => archiveThread(t),
                    onDelete: () => deleteThread(t),
                    onMarkUnread: () => markUnread(t)
                  }}
                />
              ))}
              {debouncedSearch && displayThreads && (
                <MessageHits
                  query={debouncedSearch}
                  accountId={accountId}
                  provider={provider}
                  excludeThreadIds={new Set(displayThreads.map((t) => t.id))}
                  noThreadMatches={displayThreads.length === 0}
                  onOpen={openThread}
                />
              )}
            </div>
          </>
        )}
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      </div>
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
          active={accountId === null && provider === null}
          collapsed={railCollapsed}
          label="All inboxes"
          icon={Mail}
          onClick={() => selectAccount(null)}
        />
        {accounts?.some((a) => a.provider === 'gmail') && (
          <AccountRow
            active={accountId === null && provider === 'gmail'}
            collapsed={railCollapsed}
            label="All email"
            icon={GmailIcon}
            onClick={() => selectProvider('gmail')}
          />
        )}
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
          {allLabels && allLabels.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {allLabels.map((l) => (
                <button
                  key={l}
                  onClick={() => setLabelFilter(labelFilter === l ? null : l)}
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[10.5px] border transition-colors',
                    labelFilter === l
                      ? 'bg-accent/15 border-accent/40 text-accent'
                      : 'border-border/70 text-faint hover:text-text'
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
          {selectedAccount?.provider === 'slack' && mode === 'threads' && (
            <SlackChannelHint account={selectedAccount} onOpen={() => setMode('channels')} />
          )}
          {selectedAccount?.status === 'error' && (
            <p className="text-[11px] text-danger truncate" title={selectedAccount.error ?? ''}>
              sync error: {selectedAccount.error}
            </p>
          )}
          {selectedAccount?.status === 'needs_auth' && (
            <p className="text-[11px] text-danger">needs reconnect — Settings → Connections</p>
          )}
          {actionError && <p className="text-[11px] text-danger truncate" title={actionError}>{actionError}</p>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {mode === 'channels' && selectedAccount ? (
            <ChannelManager account={selectedAccount} />
          ) : (
            <>
              {displayThreads?.length === 0 && !debouncedSearch && (
                <EmptyState>Nothing here yet.</EmptyState>
              )}
              {displayThreads?.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  showProvider={accountId === null && provider === null}
                  active={threadId === t.id}
                  leaving={leaving.has(t.id)}
                  onClick={() => openThread(t)}
                  onTogglePin={() => togglePin(t)}
                />
              ))}
              {debouncedSearch && displayThreads && (
                <MessageHits
                  query={debouncedSearch}
                  accountId={accountId}
                  provider={provider}
                  excludeThreadIds={new Set(displayThreads.map((t) => t.id))}
                  noThreadMatches={displayThreads.length === 0}
                  onOpen={openThread}
                />
              )}
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
            onTogglePin={() => togglePin(thread)}
          />
        ) : (
          <EmptyState>Select a conversation.</EmptyState>
        )}
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}

/** phone account filter — horizontal chip rail above the thread list */
function MobileAccountChip({
  active,
  label,
  error,
  onClick
}: {
  active: boolean
  label: string
  error?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'shrink-0 px-3 py-1.5 rounded-full border text-[12.5px] whitespace-nowrap transition-colors',
        active ? 'bg-raised border-border-strong text-text' : 'border-border text-muted',
        error && 'text-danger'
      )}
    >
      {label}
    </button>
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
  icon: ProviderIconComponent
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
            <WhatsAppIcon size={13} />
            WhatsApp (QR in Settings)
          </button>
          {error && <p className="px-2 py-1 text-[11px] text-danger">{error}</p>}
        </div>
      )}
    </div>
  )
}

/** touch swipe wiring — only the mobile list passes this */
type RowSwipe = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onArchive: () => void
  onDelete: () => void
  onMarkUnread: () => void
}

function ThreadRow({
  thread,
  active,
  showProvider,
  leaving,
  onClick,
  onTogglePin,
  swipe
}: {
  thread: CommsThreadListItem
  active: boolean
  showProvider: boolean
  /** plays the exit animation (slide right + collapse) before removal */
  leaving: boolean
  onClick: () => void
  onTogglePin: () => void
  swipe?: RowSwipe
}): React.JSX.Element {
  const Icon = PROVIDER_ICON[thread.provider]
  const { name, title } = threadLabel(thread)
  const ref = useRef<HTMLDivElement>(null)
  // keyboard navigation can select a row that's scrolled out of the list —
  // keep the active one visible (nearest = no jump when it's already in view)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // swipe offset mirrors into a ref so pointer handlers never read stale state
  const [offset, setOffsetState] = useState(0)
  const [dragging, setDragging] = useState(false)
  const offsetRef = useRef(0)
  const setOffset = (v: number): void => {
    offsetRef.current = v
    setOffsetState(v)
  }
  const gesture = useRef<{
    x: number
    y: number
    id: number
    base: number
    mode: 'idle' | 'swipe' | 'scroll'
  } | null>(null)
  const suppressClick = useRef(false)

  // another row opened (or the parent closed us) → snap shut
  useEffect(() => {
    if (swipe && !swipe.isOpen && offsetRef.current !== 0) setOffset(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swipe?.isOpen])

  const setRootRef = (el: HTMLDivElement | null): void => {
    ref.current = el
    // pre-registered non-passive blocker (idempotent: same fn + options)
    if (el && swipe) el.addEventListener('touchmove', blockScrollWhileSwiping, { passive: false })
  }

  const endSwipe = (): void => {
    swipeOwned = false
    setDragging(false)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!swipe || e.pointerType !== 'touch') return
    // a swipe usually generates no click at all, so the suppress flag from the
    // previous gesture may still be armed — every new touch starts clean
    suppressClick.current = false
    gesture.current = {
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      base: offsetRef.current,
      mode: 'idle'
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const s = gesture.current
    if (!swipe || !s || e.pointerId !== s.id || s.mode === 'scroll') return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (s.mode === 'idle') {
      if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(dy) < SWIPE_SLOP_PX) return
      if (Math.abs(dx) > Math.abs(dy) * 1.2) {
        s.mode = 'swipe'
        swipeOwned = true
        setDragging(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      } else {
        s.mode = 'scroll' // vertical-dominant: hand the gesture to native scroll
        return
      }
    }
    const w = ref.current?.offsetWidth ?? 390
    setOffset(clamp(s.base + dx, -w, SWIPE_STRIP_W))
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const s = gesture.current
    gesture.current = null
    if (!swipe || !s || e.pointerId !== s.id || s.mode !== 'swipe') return
    endSwipe()
    suppressClick.current = true // the tap-end click must not open the thread
    const off = offsetRef.current
    const w = ref.current?.offsetWidth ?? 390
    if (off < -w * SWIPE_COMMIT_FRACTION) {
      // full swipe left = archive, Gmail-style
      setOffset(-w)
      swipe.onOpenChange(false)
      swipe.onArchive()
    } else if (off < -SWIPE_STRIP_W / 2) {
      setOffset(-SWIPE_STRIP_W)
      swipe.onOpenChange(true)
    } else if (off > SWIPE_STRIP_W / 2) {
      setOffset(SWIPE_STRIP_W)
      swipe.onOpenChange(true)
    } else {
      setOffset(0)
      swipe.onOpenChange(false)
    }
  }

  const onPointerCancel = (): void => {
    const s = gesture.current
    gesture.current = null
    if (s?.mode === 'swipe') {
      endSwipe()
      setOffset(0)
      swipe?.onOpenChange(false)
    }
  }

  const swipeAction =
    (fn: () => void) =>
    (e: React.MouseEvent): void => {
      e.stopPropagation()
      setOffset(0)
      swipe?.onOpenChange(false)
      fn()
    }

  const archived = thread.is_archived === 1
  return (
    // div, not button: the pin toggle nests inside and buttons can't nest
    <div
      ref={setRootRef}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onClickCapture={(e) => {
        if (!swipe) return
        if (suppressClick.current) {
          suppressClick.current = false
          e.preventDefault()
          e.stopPropagation()
          return
        }
        // a tap on an open row closes it instead of opening the thread
        if (offsetRef.current !== 0 && !(e.target as Element).closest('[data-swipe-btn]')) {
          e.preventDefault()
          e.stopPropagation()
          setOffset(0)
          swipe.onOpenChange(false)
        }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      className={cn(
        'thread-row relative group w-full text-left border-b border-border/50 hover:bg-raised/50 cursor-default',
        active && 'bg-raised',
        leaving && 'thread-row-leaving'
      )}
    >
      {swipe && offset !== 0 && (
        <>
          {/* swipe right → pin + unread (left edge) */}
          <div className="absolute inset-y-0 left-0 flex">
            <button
              data-swipe-btn
              onClick={swipeAction(onTogglePin)}
              className="w-16 flex flex-col items-center justify-center gap-0.5 bg-accent text-black/80"
            >
              <Pin size={14} className={thread.pinned === 1 ? 'fill-current' : undefined} />
              <span className="text-[10px] font-medium">
                {thread.pinned === 1 ? 'Unpin' : 'Pin'}
              </span>
            </button>
            <button
              data-swipe-btn
              onClick={swipeAction(swipe.onMarkUnread)}
              className="w-16 flex flex-col items-center justify-center gap-0.5 bg-raised text-text"
            >
              <Mail size={14} />
              <span className="text-[10px] font-medium">Unread</span>
            </button>
          </div>
          {/* swipe left → delete + archive (right edge; archive outermost = full-swipe action) */}
          <div className="absolute inset-y-0 right-0 flex">
            <button
              data-swipe-btn
              onClick={swipeAction(swipe.onDelete)}
              className="w-16 flex flex-col items-center justify-center gap-0.5 bg-danger text-black/80"
            >
              <Trash2 size={14} />
              <span className="text-[10px] font-medium">Delete</span>
            </button>
            <button
              data-swipe-btn
              onClick={swipeAction(swipe.onArchive)}
              className="w-16 flex flex-col items-center justify-center gap-0.5 bg-ok text-black/80"
            >
              {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              <span className="text-[10px] font-medium">{archived ? 'Restore' : 'Archive'}</span>
            </button>
          </div>
        </>
      )}
      <div
        className="thread-row-inner relative px-3 py-2"
        style={
          swipe
            ? {
                transform: `translateX(${offset}px)`,
                transition: dragging ? 'none' : 'transform 200ms cubic-bezier(0.25, 1, 0.5, 1)',
                // opaque while sliding so the strips don't show through the row
                background: offset !== 0 ? 'var(--color-overlay)' : undefined
              }
            : undefined
        }
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
          <button
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin()
            }}
            title={thread.pinned === 1 ? 'Unpin' : 'Pin to top'}
            className={cn(
              'shrink-0 h-4 w-4 rounded flex items-center justify-center',
              thread.pinned === 1
                ? 'text-accent'
                : 'text-faint hover:text-text opacity-0 group-hover:opacity-100'
            )}
          >
            <Pin size={11} className={thread.pinned === 1 ? 'fill-current' : undefined} />
          </button>
          <span className="font-mono text-[10px] text-faint shrink-0">
            {timeAgo(thread.last_message_at)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[11px] text-faint truncate flex-1">{thread.snippet}</span>
          {thread.labels
            .split(',')
            .filter(Boolean)
            .slice(0, 2)
            .map((l) => (
              <span
                key={l}
                className="shrink-0 px-1 rounded text-[9.5px] border border-border/70 text-faint"
              >
                {l}
              </span>
            ))}
          {thread.unread_count > 0 && (
            <span className="shrink-0 min-w-4 h-4 px-1 rounded-full bg-accent/20 text-accent font-mono text-[10px] flex items-center justify-center">
              {thread.unread_count}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** ~90 chars of body centered on the first match, so the hit itself is visible */
const excerpt = (body: string, query: string): string => {
  const i = body.toLowerCase().indexOf(query.toLowerCase())
  const start = i < 0 ? 0 : Math.max(0, i - 30)
  return (start > 0 ? '…' : '') + body.slice(start, start + 90).replace(/\s+/g, ' ').trim()
}

/** Body-text search results — matches the thread-row search (title/snippet)
 *  can't see. One row per thread, newest hit wins; opens like any thread. */
function MessageHits({
  query,
  accountId,
  provider,
  excludeThreadIds,
  noThreadMatches,
  onOpen
}: {
  query: string
  accountId: string | null
  provider: CommsProvider | null
  /** threads already shown as rows above — don't repeat them here */
  excludeThreadIds: ReadonlySet<string>
  noThreadMatches: boolean
  onOpen: (t: CommsThreadListItem) => void
}): React.JSX.Element | null {
  const { data: hits } = useInvoke(
    'comms:search',
    [query, { accountId: accountId ?? undefined, provider: provider ?? undefined, limit: 30 }],
    ['comms']
  )
  const rows = useMemo(() => {
    const seen = new Set<string>()
    return (hits ?? []).filter((h) => {
      if (excludeThreadIds.has(h.thread_id) || seen.has(h.thread_id)) return false
      seen.add(h.thread_id)
      return true
    })
  }, [hits, excludeThreadIds])
  if (rows.length === 0) {
    return noThreadMatches && hits ? <EmptyState>No matches.</EmptyState> : null
  }
  const open = (h: MessageSearchHit): void => {
    void api.invoke('comms:thread', h.thread_id).then((t) => t && onOpen(t))
  }
  return (
    <div>
      <p className="px-3 pt-3 pb-1 text-[10.5px] uppercase tracking-wide text-faint">
        In message bodies
      </p>
      {rows.map((h) => (
        <button
          key={h.id}
          onClick={() => open(h)}
          className="w-full text-left px-3 py-2 border-b border-border/50 hover:bg-raised/50"
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] truncate flex-1">
              <span className="text-accent">{h.sender_name || h.sender_handle || 'me'} · </span>
              {h.thread_title || '(untitled)'}
            </span>
            <span className="font-mono text-[10px] text-faint shrink-0">{timeAgo(h.sent_at)}</span>
          </div>
          <p className="text-[11px] text-faint truncate mt-0.5">{excerpt(h.body_text, query)}</p>
        </button>
      ))}
    </div>
  )
}

/** Nudge shown while a Slack account syncs zero channels: DMs work out of the
 *  box, but the channel opt-in is invisible unless you know the toggle exists. */
function SlackChannelHint({
  account,
  onOpen
}: {
  account: CommsAccount
  onOpen: () => void
}): React.JSX.Element | null {
  const { data: all } = useInvoke('comms:accountThreads', [account.id], ['comms'])
  const channels = all?.filter((t) => t.kind === 'channel') ?? []
  if (channels.length === 0 || channels.some((c) => c.sync_enabled === 1)) return null
  return (
    <button
      onClick={onOpen}
      className="w-full text-left px-2 py-1.5 rounded border border-border bg-raised/40 text-[11px] text-muted hover:text-text hover:border-border-strong transition-colors"
    >
      <Hash size={11} className="inline mr-1 -mt-px" />
      {channels.length} channels available, none syncing yet.{' '}
      <span className="text-accent">Pick channels →</span>
    </button>
  )
}

/** Keep bulk-enable well under Slack's rate limits — each synced channel is a
 *  conversations.history call per 90 s poll. */
const BULK_ENABLE_CAP = 30

function ChannelManager({ account }: { account: CommsAccount }): React.JSX.Element {
  const { data: all } = useInvoke('comms:accountThreads', [account.id], ['comms'])
  const channels = useMemo(() => all?.filter((t) => t.kind === 'channel') ?? [], [all])
  const enabled = useMemo(() => channels.filter((c) => c.sync_enabled === 1), [channels])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const room = Math.max(0, BULK_ENABLE_CAP - enabled.length)
  const off = channels.filter((c) => c.sync_enabled !== 1)
  const toEnable = off.slice(0, room)
  // note stays while at cap so the leftover channels aren't a mystery
  const capped = off.length > 0 && (toEnable.length < off.length || room === 0)

  const bulk = async (ids: string[], on: boolean): Promise<void> => {
    setBusy(true)
    try {
      await api.invoke('comms:setThreadsSync', ids, on)
    } finally {
      setBusy(false)
    }
  }
  const refresh = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.invoke('comms:refreshChannels', account.id)
      if (!res.ok) setError(res.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="px-3 py-2 space-y-1.5 border-b border-border/50">
        <p className="text-[11px] text-faint">
          Channels are off by default — pick the ones worth syncing.
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted">
            {enabled.length} of {channels.length} syncing
          </span>
          <span className="flex-1" />
          {toEnable.length > 0 && (
            <button
              disabled={busy}
              onClick={() => void bulk(toEnable.map((c) => c.id), true)}
              className="px-2 py-0.5 rounded text-[11px] border border-border text-muted hover:text-text hover:border-border-strong disabled:opacity-50"
            >
              Enable all{capped ? ` (first ${toEnable.length})` : ''}
            </button>
          )}
          {enabled.length > 0 && (
            <button
              disabled={busy}
              onClick={() => void bulk(enabled.map((c) => c.id), false)}
              className="px-2 py-0.5 rounded text-[11px] border border-border text-muted hover:text-text hover:border-border-strong disabled:opacity-50"
            >
              Disable all
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => void refresh()}
            title="Re-list channels from Slack"
            className="h-5 w-5 rounded flex items-center justify-center text-faint hover:text-text hover:bg-raised disabled:opacity-50"
          >
            <RefreshCw size={11} className={busy ? 'animate-spin' : undefined} />
          </button>
        </div>
        {capped && (
          <p className="text-[10.5px] text-faint">
            capped at {BULK_ENABLE_CAP} synced channels to stay under Slack rate limits
          </p>
        )}
        {error && <p className="text-[11px] text-danger truncate" title={error}>{error}</p>}
      </div>
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
  onMarkUnread,
  onTogglePin,
  onBack
}: {
  thread: CommsThreadListItem
  onOpenPerson?: (id: string) => void
  /** fire-and-forget — the list owns the exit animation and error banner */
  onArchive: () => void
  onDelete: () => void
  onMarkUnread: () => void
  onTogglePin: () => void
  /** mobile: the pane is the whole screen — render a back button (also
   *  signals touch-sized targets throughout the header) */
  onBack?: () => void
}): React.JSX.Element {
  const { data: messages } = useInvoke('comms:messages', [thread.id], ['comms'])
  const { data: threadAttachments } = useInvoke('comms:threadAttachments', [thread.id], ['comms'])
  // one fetch per pane, grouped here — a hook per bubble would be N IPC calls
  const attachmentsByMessage = useMemo(() => {
    const map = new Map<string, CommsAttachment[]>()
    for (const a of threadAttachments ?? []) {
      const list = map.get(a.message_id) ?? []
      list.push(a)
      map.set(a.message_id, list)
    }
    return map
  }, [threadAttachments])
  const bottomRef = useRef<HTMLDivElement>(null)
  const archived = thread.is_archived === 1
  const { name, title } = threadLabel(thread)

  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [messages, thread.id])

  // e = archive, ⌫ = delete (email only — Slack/WhatsApp never delete),
  // u = mark unread + back to list, p = pin/unpin, r = focus the reply box
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping()) return
      if (e.key === 'e') {
        onArchive()
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && thread.provider === 'gmail') {
        onDelete()
      } else if (e.key === 'u') {
        onMarkUnread()
      } else if (e.key === 'p') {
        onTogglePin()
      } else if (e.key === 'r') {
        e.preventDefault()
        document.getElementById('inbox-reply')?.focus()
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [thread.id, thread.provider, onArchive, onDelete, onMarkUnread, onTogglePin])

  const actionBtn = onBack ? 'h-9 w-9' : 'h-6 w-6'

  return (
    <>
      <div className={cn('border-b border-border flex items-center gap-2', onBack ? 'pl-1 pr-3 py-2' : 'px-4 py-3')}>
        {onBack && (
          <button
            onClick={onBack}
            title="Back to list"
            className="shrink-0 h-9 w-9 rounded-md flex items-center justify-center text-muted active:bg-raised"
          >
            <ChevronLeft size={20} />
          </button>
        )}
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
        <LabelMenu thread={thread} />
        <button
          onClick={onTogglePin}
          title={thread.pinned === 1 ? 'Unpin (p)' : 'Pin to top (p)'}
          className={cn(
            'shrink-0 rounded flex items-center justify-center hover:bg-raised',
            actionBtn,
            thread.pinned === 1 ? 'text-accent' : 'text-muted hover:text-text'
          )}
        >
          <Pin size={onBack ? 16 : 14} className={thread.pinned === 1 ? 'fill-current' : undefined} />
        </button>
        <button
          onClick={onMarkUnread}
          title="Mark as unread (u)"
          className={cn('shrink-0 rounded flex items-center justify-center text-muted hover:text-text hover:bg-raised', actionBtn)}
        >
          <Mail size={onBack ? 16 : 14} />
        </button>
        <button
          onClick={onArchive}
          title={archived ? 'Move back to inbox (e)' : 'Archive (e)'}
          className={cn('shrink-0 rounded flex items-center justify-center text-muted hover:text-text hover:bg-raised', actionBtn)}
        >
          {archived ? <ArchiveRestore size={onBack ? 16 : 14} /> : <Archive size={onBack ? 16 : 14} />}
        </button>
        {thread.provider === 'gmail' && (
          <button
            onClick={onDelete}
            title="Delete (⌫) — moves to Gmail trash"
            className={cn('shrink-0 rounded flex items-center justify-center text-muted hover:text-danger hover:bg-raised', actionBtn)}
          >
            <Trash2 size={onBack ? 16 : 14} />
          </button>
        )}
        {!onBack && <Chip tone="muted">{thread.provider}</Chip>}
      </div>
      <div className="fade-in flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {messages?.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            attachments={attachmentsByMessage.get(m.id)}
            onOpenPerson={onOpenPerson}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer thread={thread} />
    </>
  )
}

/** Manual label override: taxonomy checkboxes, saved per toggle. */
function LabelMenu({ thread }: { thread: CommsThreadListItem }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const current = new Set(thread.labels.split(',').filter(Boolean))
  const toggle = (label: string): void => {
    const next = new Set(current)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    void api.invoke('comms:setThreadLabels', thread.id, [...next])
  }
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Labels"
        className={cn(
          'h-6 w-6 rounded flex items-center justify-center hover:bg-raised',
          current.size > 0 ? 'text-accent' : 'text-muted hover:text-text'
        )}
      >
        <Tag size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-20 w-40 rounded border border-border bg-overlay shadow-lg py-1">
            {COMMS_LABELS.map((l) => (
              <label
                key={l}
                className="flex items-center gap-2 px-2.5 py-1 text-[12px] hover:bg-raised/60 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={current.has(l)}
                  onChange={() => toggle(l)}
                  className="accent-accent"
                />
                {l}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function MessageBubble({
  message: m,
  attachments,
  onOpenPerson
}: {
  message: CommsMessage
  attachments?: CommsAttachment[]
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
  const audioAtts = attachments?.filter((a) => a.mime_type?.startsWith('audio/')) ?? []
  const imageAtts = attachments?.filter((a) => a.mime_type?.startsWith('image/')) ?? []
  const fileAtts =
    attachments?.filter(
      (a) => !a.mime_type?.startsWith('audio/') && !a.mime_type?.startsWith('image/')
    ) ?? []
  // a voice note's body is just the '[voice message]' placeholder — the
  // player replaces it rather than showing both; same for an uncaptioned
  // photo's '[image]'
  const voiceOnly = audioAtts.length > 0 && !html && m.body_text === '[voice message]'
  const imageOnly = imageAtts.length > 0 && !html && m.body_text === '[image]'
  return (
    <div className={cn(html ? 'max-w-full' : 'max-w-[85%]', m.is_me ? 'ml-auto' : '')}>
      <div className="group/sender flex items-baseline gap-2 mb-0.5 relative">
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
            {m.person_id && m.sender_handle && (
              <button
                className="text-faint hover:text-danger opacity-0 group-hover/sender:opacity-100"
                title="Unlink this sender. If the person's email/phone still matches, the next incoming message re-links"
                onClick={() => void api.invoke('comms:unlinkSender', m.provider, m.sender_handle)}
              >
                <Unlink size={11} />
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
      ) : voiceOnly || imageOnly ? null : (
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap break-words',
            m.is_me ? 'bg-accent/10 border border-accent/20' : 'bg-panel border border-border'
          )}
        >
          {m.body_text || <span className="text-faint italic">(no text)</span>}
        </div>
      )}
      {audioAtts.map((a) => (
        <VoiceNoteChip key={a.id} attachment={a} mine={m.is_me === 1} />
      ))}
      {imageAtts.map((a) => (
        <ImageThumb key={a.id} attachment={a} />
      ))}
      {fileAtts.map((a) => (
        <AttachmentChip key={a.id} attachment={a} />
      ))}
      {m.has_attachments === 1 && !attachments?.length && (
        <div className="mt-1 text-[11px] text-faint">
          📎 attachment (synced before download support — open in the app)
        </div>
      )}
    </div>
  )
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Inline player for voice notes / audio attachments. Bytes come over IPC as
 *  a data URL on first play (then cached on disk main-side). */
function VoiceNoteChip({
  attachment: a,
  mine
}: {
  attachment: CommsAttachment
  mine: boolean
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // guards the await in ensureAudio: without it, unmounting mid-fetch lets
  // the resolved promise create + play an Audio nothing can ever stop
  const aliveRef = useRef(true)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0) // 0..1
  const [clock, setClock] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // leaving the thread must stop playback
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  const ensureAudio = async (): Promise<HTMLAudioElement | null> => {
    if (audioRef.current) return audioRef.current
    setBusy(true)
    try {
      const res = await api.invoke('comms:attachmentData', a.id)
      if (!aliveRef.current) return null
      if (!res.ok) {
        setError(res.message)
        return null
      }
      const audio = new Audio(res.dataUrl)
      audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audio.duration)) setClock(fmtClock(audio.duration))
      })
      audio.addEventListener('timeupdate', () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setProgress(audio.currentTime / audio.duration)
          setClock(fmtClock(audio.currentTime))
        }
      })
      audio.addEventListener('play', () => setPlaying(true))
      audio.addEventListener('pause', () => setPlaying(false))
      audio.addEventListener('ended', () => {
        setPlaying(false)
        setProgress(0)
        audio.currentTime = 0
        if (Number.isFinite(audio.duration)) setClock(fmtClock(audio.duration))
      })
      audio.addEventListener('error', () => {
        setPlaying(false)
        setError('could not play this voice message')
      })
      audioRef.current = audio
      return audio
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (): Promise<void> => {
    setError(null)
    const audio = await ensureAudio()
    if (!audio || !aliveRef.current) return
    if (audio.paused) {
      void audio.play().catch((e) => setError(e instanceof Error ? e.message : String(e)))
    } else {
      audio.pause()
    }
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(audio.duration) || audio.duration === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration
  }

  return (
    <div className="mt-1">
      <div
        className={cn(
          'inline-flex items-center gap-2 w-60 max-w-full px-2.5 py-1.5 rounded-full border',
          mine ? 'bg-accent/10 border-accent/20' : 'bg-panel border-border'
        )}
      >
        <button
          onClick={() => void toggle()}
          disabled={busy}
          title={playing ? 'Pause' : 'Play voice message'}
          className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-full bg-raised hover:bg-border text-text disabled:opacity-60"
        >
          {busy ? (
            <RefreshCw size={11} className="animate-spin text-faint" />
          ) : playing ? (
            <Pause size={11} />
          ) : (
            <Play size={11} className="ml-0.5" />
          )}
        </button>
        <div
          className="flex-1 h-1 rounded-full bg-border cursor-pointer"
          onClick={seek}
          title="Seek"
        >
          <div
            className="h-1 rounded-full bg-accent"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[10px] text-faint inline-flex items-center gap-1">
          <Mic size={10} />
          {clock ?? '· · ·'}
        </span>
      </div>
      {error && (
        <p className="text-[10.5px] text-danger truncate" title={error}>
          {error}
        </p>
      )}
    </div>
  )
}

/** Preview-sized cap mirrors MAX_PREVIEW_BYTES main-side — anything bigger
 *  would be refused there anyway, so don't even request the bytes. */
const MAX_IMG_PREVIEW_BYTES = 10 * 1024 * 1024

/** Inline thumbnail for image attachments: bytes arrive as a data URL over
 *  IPC (cached on disk main-side), click opens the full-size file. Falls back
 *  to the filename chip when the preview can't load. */
function ImageThumb({ attachment: a }: { attachment: CommsAttachment }): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [opening, setOpening] = useState(false)
  const tooBig = a.size_bytes != null && a.size_bytes > MAX_IMG_PREVIEW_BYTES

  useEffect(() => {
    if (tooBig) return undefined
    let stale = false // unmount (thread switch) must not set state afterwards
    void api.invoke('comms:attachmentData', a.id).then((res) => {
      if (stale) return
      if (res.ok) setDataUrl(res.dataUrl)
      else setFailed(true)
    })
    return () => {
      stale = true
    }
  }, [a.id, tooBig])

  if (tooBig || failed) return <AttachmentChip attachment={a} />

  const openFull = async (): Promise<void> => {
    setOpening(true)
    try {
      await api.invoke('comms:downloadAttachment', a.id)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="mt-1">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={a.filename || 'image attachment'}
          title="Click to open full size"
          onClick={() => void openFull()}
          onError={() => setFailed(true)}
          className={cn(
            'max-h-72 max-w-full rounded-lg border border-border cursor-zoom-in',
            opening && 'opacity-60'
          )}
        />
      ) : (
        <div className="w-48 h-32 rounded-lg border border-border bg-panel animate-pulse" />
      )}
    </div>
  )
}

/** Filename chip: click downloads (cached after the first time) and opens. */
function AttachmentChip({ attachment: a }: { attachment: CommsAttachment }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.invoke('comms:downloadAttachment', a.id)
      if (!res.ok) setError(res.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-1">
      <button
        onClick={() => void open()}
        disabled={busy}
        title={a.local_path ? 'Open (downloaded)' : 'Download and open'}
        className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded border border-border bg-panel hover:bg-raised text-[11.5px] disabled:opacity-60"
      >
        {busy ? (
          <RefreshCw size={11} className="shrink-0 animate-spin text-faint" />
        ) : (
          <Paperclip size={11} className="shrink-0 text-faint" />
        )}
        <span className="truncate">{a.filename || 'attachment'}</span>
        {a.size_bytes != null && (
          <span className="shrink-0 text-faint">{humanSize(a.size_bytes)}</span>
        )}
        {!busy && a.local_path && <Check size={11} className="shrink-0 text-accent" />}
      </button>
      {error && (
        <p className="text-[10.5px] text-danger truncate" title={error}>
          {error}
        </p>
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html { color-scheme: light; }
  body { margin: 0; padding: 12px; background: #fff; color: #111;
         font: 13px/1.45 -apple-system, system-ui, sans-serif; word-break: break-word;
         overflow-x: hidden; word-wrap: break-word; }
  /* newsletters are fixed-width (600px+) table layouts; squeeze them to the phone */
  table, td, img, video, div { max-width: 100% !important; }
  img { height: auto; }
</style>
</head><body>${html}</body></html>`,
    [html]
  )

  const measure = (): void => {
    const frame = ref.current
    const body = frame?.contentDocument?.body
    if (!frame || !body) return
    // Fixed-width table newsletters defeat the max-width reset (tables won't
    // shrink below their attribute-forced min-content). Scale those down to
    // fit, like iOS Mail / Gmail; page-level pinch-zoom still works.
    const frameW = frame.clientWidth
    const contentW = body.scrollWidth
    if (frameW > 0 && contentW > frameW + 1) {
      const s = frameW / contentW
      body.style.width = `${contentW}px` // scrollWidth includes padding
      body.style.boxSizing = 'border-box'
      body.style.transformOrigin = '0 0'
      body.style.transform = `scale(${s})`
      setHeight(clamp(body.scrollHeight * s + 4, 40, 2000))
    } else {
      setHeight(clamp(body.scrollHeight + 4, 40, 2000))
    }
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
      loading="lazy"
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
  const mobile = useIsMobile()
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
          placeholder={mobile ? 'Reply…' : 'Reply… ⌘↩ to send'}
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
