import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { AppSettings, AuthStatus, ChatEffort } from '../../../shared/ipc-contract'
import { api, useInvoke } from '../lib/api'
import { applyTranslucency } from '../lib/translucency'
import { Input, Button, Chip, Select, Segmented } from '../components/ui'

const MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default (Claude Code)' },
  { value: 'fable', label: 'Fable 5' },
  { value: 'opus', label: 'Opus 4.8' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'haiku', label: 'Haiku 4.5' }
]

const EFFORTS: { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' }
]

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [trans, setTrans] = useState(0)

  useEffect(() => {
    void api.invoke('settings:get').then((s) => {
      setSettings(s)
      setTrans(s.translucency)
    })
    void api.invoke('settings:authStatus').then(setAuth)
  }, [])

  const save = (patch: Partial<AppSettings>): void => {
    void api.invoke('settings:set', patch).then(setSettings)
  }

  // slider: live-preview on drag, persist when the drag ends
  const previewTranslucency = (pct: number): void => {
    setTrans(pct)
    applyTranslucency(pct)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onMouseDown={onClose}
    >
      <div
        className="w-[480px] max-h-[85vh] overflow-y-auto bg-overlay border border-border-strong rounded-xl shadow-2xl p-5 space-y-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            settings
          </span>
          <button onClick={onClose} className="text-faint hover:text-text">
            <X size={15} />
          </button>
        </div>

        {settings && (
          <>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                    window translucency
                  </span>
                  <p className="text-[11px] text-faint">
                    See your desktop through the whole window.
                  </p>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={1}
                    value={trans}
                    onChange={(e) => previewTranslucency(Number(e.target.value))}
                    onPointerUp={() => save({ translucency: trans })}
                    onKeyUp={() => save({ translucency: trans })}
                    className="w-36 accent-accent"
                  />
                  <span className="font-mono text-[11px] text-muted w-8 text-right">
                    {trans}%
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                  claude usage on today
                </span>
                <p className="text-[11px] text-faint">
                  Show today&apos;s Claude Code token usage on the Today view.
                </p>
              </div>
              <input
                type="checkbox"
                checked={settings.showClaudeUsage}
                onChange={(e) => save({ showClaudeUsage: e.target.checked })}
                className="accent-accent w-4 h-4 shrink-0"
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                  auto-label email
                </span>
                <p className="text-[11px] text-faint">
                  Classify inbox email in the background (action-needed, newsletter, finance, …).
                  Uses Haiku via your Claude Code login.
                </p>
              </div>
              <input
                type="checkbox"
                checked={settings.autoLabel}
                onChange={(e) => save({ autoLabel: e.target.checked })}
                className="accent-accent w-4 h-4 shrink-0"
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                  message notifications
                </span>
                <p className="text-[11px] text-faint">
                  Native notifications for new messages while the app is in the background.
                  Important = DMs plus email classified action-needed (fresh mail is
                  classified for this even while auto-label is off).
                </p>
              </div>
              <Segmented
                value={settings.notifyInbox}
                onChange={(v) => save({ notifyInbox: v })}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'important', label: 'Important' },
                  { value: 'all', label: 'All' }
                ]}
              />
            </div>

            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                assistant
              </span>
              <div className="flex items-center gap-2">
                <Select
                  value={settings.chatProvider}
                  onChange={() => save({ chatProvider: 'claude' })}
                  className="flex-1"
                  title="Provider"
                >
                  <option value="claude">Claude</option>
                </Select>
                <Select
                  value={settings.chatModel ?? ''}
                  onChange={(e) => save({ chatModel: e.target.value || null })}
                  className="flex-1"
                  title="Model"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
                <Select
                  value={settings.chatEffort ?? ''}
                  onChange={(e) => save({ chatEffort: (e.target.value || null) as ChatEffort | null })}
                  className="flex-1"
                  title="Reasoning effort"
                >
                  {EFFORTS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="text-[11px] text-faint">
                Provider · model · reasoning effort for the Chat tab. Applies from the next
                message.
              </p>
            </div>

            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                quick-capture hotkey
              </span>
              <Input
                className="w-full font-mono text-[12px]"
                defaultValue={settings.captureHotkey}
                key={settings.captureHotkey}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== settings.captureHotkey) save({ captureHotkey: v })
                }}
              />
              <p className="text-[11px] text-faint">
                Electron accelerator, e.g. Alt+Space, CommandOrControl+Shift+C. Falls back to
                Ctrl/Cmd+Shift+Space if taken.
              </p>
            </div>

            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                claude binary path (optional)
              </span>
              <Input
                className="w-full font-mono text-[12px]"
                placeholder="auto-detect"
                defaultValue={settings.claudePath ?? ''}
                key={settings.claudePath ?? 'auto'}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  save({ claudePath: v || null })
                }}
              />
            </div>
          </>
        )}

        {settings && <ConnectionsSection settings={settings} save={save} />}

        {settings && <RemoteSection settings={settings} save={save} />}

        <div className="space-y-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
            claude subscription
          </span>
          <div>
            {!auth && <span className="text-[12px] text-faint">checking…</span>}
            {auth?.ok && (
              <span className="inline-flex items-center gap-2 text-[12.5px]">
                <Chip tone="ok">connected</Chip> {auth.email} · {auth.subscriptionType}
              </span>
            )}
            {auth && !auth.ok && (
              <span className="inline-flex items-center gap-2 text-[12.5px]">
                <Chip tone="danger">unavailable</Chip> {auth.message}
              </span>
            )}
          </div>
          <p className="text-[11px] text-faint">
            The chat panel and MCP server use your Claude Code login. The app itself never needs
            it.
          </p>
        </div>

        <div className="pt-1 flex justify-end">
          <Button variant="ghost" onClick={() => void api.invoke('settings:authStatus').then(setAuth)}>
            re-check auth
          </Button>
        </div>
      </div>
    </div>
  )
}

const STATUS_TONE = {
  connected: 'ok',
  needs_auth: 'danger',
  error: 'danger',
  disabled: 'muted'
} as const

function ConnectionsSection({
  settings,
  save
}: {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const { data: accounts } = useInvoke('comms:accounts', [], ['comms'])
  const { data: calAccounts } = useInvoke('calendar:accounts', [], ['calendar_accounts'])
  const [busy, setBusy] = useState<'gmail' | 'slack' | 'whatsapp' | 'gcal' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [waQr, setWaQr] = useState<string | null>(null)

  useEffect(() => {
    return api.on('comms:event', (e) => {
      if (e.kind === 'wa_qr') setWaQr(e.qrDataUrl)
      if (e.kind === 'sync' && e.status === 'connected') {
        setWaQr(null)
        setBusy(null)
      }
    })
  }, [])

  const connect = (provider: 'gmail' | 'slack' | 'whatsapp'): void => {
    setBusy(provider)
    setError(null)
    const channel =
      provider === 'gmail'
        ? ('comms:connectGmail' as const)
        : provider === 'slack'
          ? ('comms:connectSlack' as const)
          : ('comms:connectWhatsApp' as const)
    void api.invoke(channel).then((res) => {
      if (!res.ok) {
        setError(res.message)
        setBusy(null)
      } else if (provider !== 'whatsapp') {
        setBusy(null)
      }
      // whatsapp stays "busy" while the QR is on screen; the comms:event
      // listener clears it when pairing completes
    })
  }

  const connectCalendar = (): void => {
    setBusy('gcal')
    setError(null)
    void api.invoke('calendar:connectGoogle').then((res) => {
      setBusy(null)
      if (!res.ok) setError(res.message)
    })
  }

  return (
    <div className="space-y-2.5 border-t border-border pt-4">
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
        connections
      </span>

      {(calAccounts?.length ?? 0) > 0 && (
        <div className="space-y-1">
          {calAccounts!.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-[12.5px]">
              <Chip tone={STATUS_TONE[a.status]}>calendar</Chip>
              <span className="truncate flex-1" title={a.error ?? undefined}>
                {a.display_name}
                {a.status !== 'connected' && (
                  <span className="text-faint"> · {a.status.replace('_', ' ')}</span>
                )}
              </span>
              <Button
                variant="ghost"
                className="!py-0.5 text-[11px]"
                onClick={() => connectCalendar()}
              >
                reconnect
              </Button>
              <Button
                variant="ghost"
                className="!py-0.5 text-[11px] text-danger"
                onClick={() => void api.invoke('calendar:disconnect', a.id)}
              >
                remove
              </Button>
            </div>
          ))}
        </div>
      )}

      {(accounts?.length ?? 0) > 0 && (
        <div className="space-y-1">
          {accounts!.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-[12.5px]">
              <Chip tone={STATUS_TONE[a.status]}>{a.provider}</Chip>
              <span className="truncate flex-1" title={a.error ?? undefined}>
                {a.display_name}
                {a.status !== 'connected' && (
                  <span className="text-faint"> · {a.status.replace('_', ' ')}</span>
                )}
              </span>
              {/* always offered: reconnecting refreshes tokens/permissions in place
                  (the OAuth flow upserts into the same account) */}
              {a.provider !== 'whatsapp' && (
                <Button variant="ghost" className="!py-0.5 text-[11px]" onClick={() => connect(a.provider as 'gmail' | 'slack')}>
                  reconnect
                </Button>
              )}
              <Button
                variant="ghost"
                className="!py-0.5 text-[11px] text-danger"
                onClick={() => void api.invoke('comms:disconnect', a.id)}
              >
                remove
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <Button disabled={busy !== null} onClick={() => connect('gmail')}>
          {busy === 'gmail' ? 'waiting for browser…' : '+ Gmail'}
        </Button>
        <Button disabled={busy !== null} onClick={() => connect('slack')}>
          {busy === 'slack' ? 'waiting for browser…' : '+ Slack'}
        </Button>
        <Button disabled={busy !== null} onClick={() => connect('whatsapp')}>
          {busy === 'whatsapp' ? 'linking…' : '+ WhatsApp'}
        </Button>
        <Button disabled={busy !== null} onClick={connectCalendar}>
          {busy === 'gcal' ? 'waiting for browser…' : '+ Google Calendar'}
        </Button>
      </div>
      {error && <p className="text-[11.5px] text-danger">{error}</p>}

      {waQr && (
        <div className="flex flex-col items-center gap-1.5 py-2">
          <img src={waQr} alt="WhatsApp pairing QR" className="w-56 h-56 rounded-lg" />
          <p className="text-[11px] text-faint text-center">
            WhatsApp → Settings → Linked devices → Link a device.
            <br />
            Unofficial bridge — small chance WhatsApp objects. Keep sends personal.
          </p>
        </div>
      )}

      <details className="space-y-2">
        <summary className="text-[11.5px] text-muted cursor-pointer select-none">
          API credentials (one-time setup)
        </summary>
        <div className="space-y-2 pt-1.5">
          <div className="space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
              google oauth client
            </span>
            <div className="flex gap-1.5">
              <Input
                className="flex-1 font-mono text-[11px]"
                placeholder="client id"
                defaultValue={settings.googleClientId ?? ''}
                key={`gid-${settings.googleClientId ?? ''}`}
                onBlur={(e) => save({ googleClientId: e.target.value.trim() || null })}
              />
              <Input
                className="flex-1 font-mono text-[11px]"
                placeholder="client secret"
                type="password"
                defaultValue={settings.googleClientSecret ?? ''}
                key={`gsec-${settings.googleClientSecret ?? ''}`}
                onBlur={(e) => save({ googleClientSecret: e.target.value.trim() || null })}
              />
            </div>
            <div className="text-[11px] text-faint space-y-0.5">
              <p>
                One project serves <b>all</b> your Google accounts — set this up once
                (full guide: docs/google-setup.md in the repo):
              </p>
              <ol className="list-decimal ml-4 space-y-0.5">
                <li>console.cloud.google.com → New project → “Kairos”</li>
                <li>
                  APIs &amp; Services → Library → enable <b>Gmail API</b> and{' '}
                  <b>Google Calendar API</b> (for the upcoming calendar feature)
                </li>
                <li>
                  OAuth consent screen → External → fill name/emails → <b>Publish app</b>{' '}
                  (“In production” — Testing mode kills tokens after 7 days)
                </li>
                <li>
                  Credentials → Create credentials → OAuth client ID → <b>Desktop app</b> →
                  copy id + secret here
                </li>
              </ol>
              <p>
                Then click “+ Gmail” once per account. Google will warn the app is
                unverified — it’s yours: Advanced → “Go to Kairos”.
              </p>
            </div>
          </div>
          <div className="space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
              slack app client
            </span>
            <div className="flex gap-1.5">
              <Input
                className="flex-1 font-mono text-[11px]"
                placeholder="client id"
                defaultValue={settings.slackClientId ?? ''}
                key={`sid-${settings.slackClientId ?? ''}`}
                onBlur={(e) => save({ slackClientId: e.target.value.trim() || null })}
              />
              <Input
                className="flex-1 font-mono text-[11px]"
                placeholder="client secret"
                type="password"
                defaultValue={settings.slackClientSecret ?? ''}
                key={`ssec-${settings.slackClientSecret ?? ''}`}
                onBlur={(e) => save({ slackClientSecret: e.target.value.trim() || null })}
              />
            </div>
            <p className="text-[11px] text-faint">
              api.slack.com/apps → create app → OAuth & Permissions → add redirect URL{' '}
              <code className="font-mono">http://localhost:43117/callback</code>, then connect.
              Works per workspace.
            </p>
          </div>
        </div>
      </details>
    </div>
  )
}

function RemoteSection({
  settings,
  save
}: {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  // settings:set broadcasts db:changed settings, so toggling refreshes this
  const { data: status } = useInvoke('remote:status', [], ['settings'])
  const [copied, setCopied] = useState(false)

  const url = status?.urls[0]
  const copy = (): void => {
    if (!url) return
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
            remote access
          </span>
          <p className="text-[11px] text-faint">
            Serve the app over your private network (Tailscale / same Wi-Fi) so a phone or
            browser can use it. Data requires the link&apos;s token; keep it private.
          </p>
        </div>
        <input
          type="checkbox"
          checked={settings.remoteAccess}
          onChange={(e) => save({ remoteAccess: e.target.checked })}
          className="accent-accent w-4 h-4 shrink-0"
        />
      </div>
      {settings.remoteAccess && status && (
        <div className="space-y-1">
          {status.error && (
            <p className="text-[11px] text-danger">
              failed to start: {status.error} (port {status.port})
            </p>
          )}
          {status.running && url && (
            <div className="flex items-center gap-2">
              <code
                className="flex-1 truncate font-mono text-[11px] text-muted bg-raised border border-border rounded px-2 py-1"
                title={status.urls.join('\n')}
              >
                {url}
              </code>
              <Button variant="ghost" onClick={copy}>
                {copied ? 'copied' : 'copy link'}
              </Button>
            </div>
          )}
          {status.running && (
            <p className="text-[11px] text-faint">
              {status.clients === 0
                ? 'no clients connected'
                : `${status.clients} client${status.clients === 1 ? '' : 's'} connected`}
              {status.urls.length > 1 ? ' · hover the link for every address' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
