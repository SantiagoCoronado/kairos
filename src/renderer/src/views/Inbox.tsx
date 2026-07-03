import { useEffect, useMemo, useRef, useState } from 'react'
import { Mail, MessageSquare, Phone, RefreshCw, Link2, SlidersHorizontal, PenLine, Send } from 'lucide-react'
import type { CommsAccount, CommsThread, CommsMessage, CommsProvider } from '../../../core/comms-types'
import { api, useInvoke } from '../lib/api'
import { Input, Button, Chip, EmptyState, cn } from '../components/ui'

const PROVIDER_ICON: Record<CommsProvider, typeof Mail> = {
  gmail: Mail,
  slack: MessageSquare,
  whatsapp: Phone
}

const timeAgo = (iso: string | null): string => {
  if (!iso) return ''
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`
  return `${Math.floor(mins / (60 * 24))}d`
}

export function InboxView({ onOpenPerson }: { onOpenPerson?: (id: string) => void }): React.JSX.Element {
  const [accountId, setAccountId] = useState<string | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [mode, setMode] = useState<'threads' | 'channels' | 'compose'>('threads')

  const { data: accounts } = useInvoke('comms:accounts', [], ['comms'])
  const { data: threads } = useInvoke(
    'comms:threads',
    [{ accountId: accountId ?? undefined, unreadOnly, search: search || undefined }],
    ['comms']
  )

  const selectedAccount = accounts?.find((a) => a.id === accountId) ?? null
  const thread = threads?.find((t) => t.id === threadId) ?? null

  // keep selection valid when filters change
  useEffect(() => {
    if (threadId && threads && !threads.some((t) => t.id === threadId)) setThreadId(null)
  }, [threads, threadId])

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
      <div className="w-44 shrink-0 border-r border-border flex flex-col py-2 px-1.5 space-y-0.5">
        <AccountRow
          active={accountId === null}
          label="All inboxes"
          icon={Mail}
          onClick={() => {
            setAccountId(null)
            setMode('threads')
          }}
        />
        {accounts?.map((a) => (
          <AccountRow
            key={a.id}
            active={accountId === a.id}
            label={a.display_name}
            icon={PROVIDER_ICON[a.provider]}
            status={a.status}
            onClick={() => {
              setAccountId(a.id)
              setMode('threads')
            }}
          />
        ))}
        <div className="flex-1" />
        <div className="px-1 pb-1 flex items-center gap-1">
          <Button
            variant="ghost"
            className="flex-1 !py-1 text-[11px]"
            title="Sync now"
            onClick={() => void api.invoke('comms:syncNow', accountId ?? undefined)}
          >
            <RefreshCw size={12} className="inline mr-1" />
            sync
          </Button>
        </div>
      </div>

      {/* thread list / channel manager */}
      <div className="w-80 shrink-0 border-r border-border flex flex-col">
        <div className="p-3 space-y-2 border-b border-border">
          <Input
            className="w-full"
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setUnreadOnly((v) => !v)}
              className={cn(
                'px-2 py-1 rounded text-[11.5px] border transition-colors',
                unreadOnly
                  ? 'bg-accent/15 border-accent/40 text-accent'
                  : 'border-border text-muted hover:text-text'
              )}
            >
              Unread
            </button>
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
              {threads?.length === 0 && <EmptyState>Nothing here yet.</EmptyState>}
              {threads?.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  showProvider={accountId === null}
                  active={threadId === t.id}
                  onClick={() => {
                    setThreadId(t.id)
                    setMode('threads')
                    if (t.unread_count > 0) void api.invoke('comms:markRead', t.id)
                  }}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {/* message pane */}
      <div className="flex-1 min-w-0 flex flex-col">
        {mode === 'compose' && selectedAccount ? (
          <ComposePane account={selectedAccount} onSent={() => setMode('threads')} />
        ) : thread ? (
          <ThreadPane thread={thread} onOpenPerson={onOpenPerson} />
        ) : (
          <EmptyState>Select a conversation.</EmptyState>
        )}
      </div>
    </div>
  )
}

function AccountRow({
  active,
  label,
  icon: Icon,
  status,
  onClick
}: {
  active: boolean
  label: string
  icon: typeof Mail
  status?: CommsAccount['status']
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
        active ? 'bg-raised text-text' : 'text-muted hover:text-text hover:bg-raised/50'
      )}
      title={label}
    >
      <Icon size={13} strokeWidth={1.75} className="shrink-0" />
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
    </button>
  )
}

function ThreadRow({
  thread,
  active,
  showProvider,
  onClick
}: {
  thread: CommsThread
  active: boolean
  showProvider: boolean
  onClick: () => void
}): React.JSX.Element {
  const Icon = PROVIDER_ICON[thread.provider]
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2 border-b border-border/50 hover:bg-raised/50',
        active && 'bg-raised'
      )}
    >
      <div className="flex items-center gap-1.5">
        {showProvider && <Icon size={11} className="shrink-0 text-faint" />}
        <span
          className={cn('text-[13px] truncate flex-1', thread.unread_count > 0 && 'font-semibold')}
        >
          {thread.title || '(untitled)'}
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
  onOpenPerson
}: {
  thread: CommsThread
  onOpenPerson?: (id: string) => void
}): React.JSX.Element {
  const { data: messages } = useInvoke('comms:messages', [thread.id], ['comms'])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView()
  }, [messages, thread.id])

  return (
    <>
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <span className="text-[13.5px] font-medium truncate flex-1">
          {thread.title || '(untitled)'}
        </span>
        <Chip tone="muted">{thread.provider}</Chip>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
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
  return (
    <div className={cn('max-w-[85%]', m.is_me ? 'ml-auto' : '')}>
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
      <div
        className={cn(
          'rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap break-words',
          m.is_me ? 'bg-accent/10 border border-accent/20' : 'bg-panel border border-border'
        )}
      >
        {m.body_text || <span className="text-faint italic">(no text)</span>}
        {m.has_attachments === 1 && (
          <div className="mt-1 text-[11px] text-faint">📎 has attachment (open in the app)</div>
        )}
      </div>
    </div>
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

  return (
    <div className="border-t border-border p-3 space-y-1.5">
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
      <div className="flex gap-2 items-end">
        <textarea
          className="flex-1 bg-raised border border-border rounded-md px-2.5 py-1.5 text-[13px] text-text placeholder:text-faint focus:outline-none focus:border-border-strong resize-none"
          rows={2}
          placeholder={`Reply${thread.provider === 'gmail' ? ' (plain text)' : ''}… ⌘↩ to send`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />
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
        placeholder="Message (plain text)"
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
