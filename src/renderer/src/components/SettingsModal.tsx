import { useEffect, useState } from 'react'
import {
  X,
  SlidersHorizontal,
  Inbox,
  Sparkles,
  Mic,
  Cable,
  Smartphone
} from 'lucide-react'
import type { AppSettings, AuthStatus, ChatEffort } from '../../../shared/ipc-contract'
import { api, useInvoke } from '../lib/api'
import { useIsMobile } from '../lib/mobile'
import { applyTranslucency } from '../lib/translucency'
import { Input, Button, Chip, Select, Segmented, cn } from '../components/ui'

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

type SectionId = 'general' | 'inbox' | 'assistant' | 'voice' | 'connections' | 'remote'

const SECTIONS: { id: SectionId; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'assistant', label: 'Assistant', icon: Sparkles },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'connections', label: 'Connections', icon: Cable },
  { id: 'remote', label: 'Remote access', icon: Smartphone }
]

const SECTION_BLURB: Record<SectionId, string> = {
  general: 'Appearance and app-wide behavior.',
  inbox: 'Email classification and message notifications.',
  assistant: 'The Chat tab: model, personality, and your Claude login.',
  voice: 'ElevenLabs voice briefing and dictation.',
  connections: 'Gmail, Slack, WhatsApp and Google Calendar accounts.',
  remote: 'Use the app from a phone or browser on your private network.'
}

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [section, setSection] = useState<SectionId>('general')
  const mobile = useIsMobile()

  useEffect(() => {
    void api.invoke('settings:get').then(setSettings)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = (patch: Partial<AppSettings>): void => {
    void api.invoke('settings:set', patch).then(setSettings)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onMouseDown={onClose}
    >
      <div
        className={cn(
          'bg-overlay border border-border-strong rounded-xl shadow-2xl overflow-hidden',
          mobile
            ? 'w-[95vw] h-[85vh] flex flex-col'
            : 'w-[780px] max-w-[95vw] h-[600px] max-h-[85vh] flex'
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* section nav: left rail on desktop, scrollable chip row on mobile */}
        <div
          className={cn(
            'shrink-0 bg-panel/60',
            mobile
              ? 'flex gap-1 overflow-x-auto px-2 py-2 border-b border-border'
              : 'w-48 border-r border-border p-3 space-y-0.5'
          )}
        >
          {!mobile && (
            <div className="px-2 pb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              settings
            </div>
          )}
          {SECTIONS.map((s) => {
            const Icon = s.icon
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={cn(
                  'flex items-center gap-2 rounded-md text-[12.5px] transition-colors',
                  mobile ? 'shrink-0 px-2.5 py-1.5' : 'w-full px-2 py-1.5 text-left',
                  section === s.id
                    ? 'bg-raised text-text'
                    : 'text-muted hover:text-text hover:bg-raised/50'
                )}
              >
                <Icon size={14} />
                <span className="whitespace-nowrap">{s.label}</span>
              </button>
            )
          })}
        </div>

        {/* content pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-border shrink-0">
            <div>
              <h2 className="text-[14px] text-text font-medium">
                {SECTIONS.find((s) => s.id === section)!.label}
              </h2>
              <p className="text-[11px] text-faint">{SECTION_BLURB[section]}</p>
            </div>
            <button onClick={onClose} className="text-faint hover:text-text mt-0.5">
              <X size={15} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
            {settings && (
              <>
                {section === 'general' && <GeneralSection settings={settings} save={save} />}
                {section === 'inbox' && <InboxSection settings={settings} save={save} />}
                {section === 'assistant' && <AssistantSection settings={settings} save={save} />}
                {section === 'voice' && <VoiceSection settings={settings} save={save} />}
                {section === 'connections' && <ConnectionsSection settings={settings} save={save} />}
                {section === 'remote' && <RemoteSection settings={settings} save={save} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface SectionProps {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}

/** label + description on the left, control on the right */
function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</span>
        {hint && <p className="text-[11px] text-faint">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function GeneralSection({ settings, save }: SectionProps): React.JSX.Element {
  const [trans, setTrans] = useState(settings.translucency)

  // slider: live-preview on drag, persist when the drag ends
  const previewTranslucency = (pct: number): void => {
    setTrans(pct)
    applyTranslucency(pct)
  }

  return (
    <>
      <Row label="window translucency" hint="See your desktop through the whole window.">
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
          <span className="font-mono text-[11px] text-muted w-8 text-right">{trans}%</span>
        </div>
      </Row>

      <Row
        label="claude usage on today"
        hint="Show today's Claude Code token usage on the Today view."
      >
        <input
          type="checkbox"
          checked={settings.showClaudeUsage}
          onChange={(e) => save({ showClaudeUsage: e.target.checked })}
          className="accent-accent w-4 h-4 shrink-0"
        />
      </Row>

      <Row
        label="semantic index"
        hint={
          <>
            Meaning-based search across messages, notes, tasks, people and events. Fully
            on-device — the first run downloads a 113 MB multilingual model; nothing you wrote
            ever leaves this Mac.
          </>
        }
      >
        <input
          type="checkbox"
          checked={settings.semanticIndex}
          onChange={(e) => save({ semanticIndex: e.target.checked })}
          className="accent-accent w-4 h-4 shrink-0"
        />
      </Row>

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
    </>
  )
}

function InboxSection({ settings, save }: SectionProps): React.JSX.Element {
  return (
    <>
      <Row
        label="auto-label email"
        hint={
          <>
            Classify inbox email in the background (action-needed, newsletter, finance, …). Uses
            Haiku via your Claude Code login.
          </>
        }
      >
        <input
          type="checkbox"
          checked={settings.autoLabel}
          onChange={(e) => save({ autoLabel: e.target.checked })}
          className="accent-accent w-4 h-4 shrink-0"
        />
      </Row>

      <Row
        label="message notifications"
        hint={
          <>
            Native notifications for new messages while the app is in the background. Important =
            Slack DMs, WhatsApp messages the triage flags as urgent, and email classified
            action-needed (fresh items are classified even while auto-label is off).
          </>
        }
      >
        <Segmented
          value={settings.notifyInbox}
          onChange={(v) => save({ notifyInbox: v })}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'important', label: 'Important' },
            { value: 'all', label: 'All' }
          ]}
        />
      </Row>
    </>
  )
}

function AssistantSection({ settings, save }: SectionProps): React.JSX.Element {
  const [auth, setAuth] = useState<AuthStatus | null>(null)

  useEffect(() => {
    void api.invoke('settings:authStatus').then(setAuth)
  }, [])

  return (
    <>
      <div className="space-y-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">model</span>
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
          Provider · model · reasoning effort for the Chat tab. Applies from the next message.
        </p>
      </div>

      <div className="space-y-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
          personality
        </span>
        <textarea
          rows={4}
          placeholder="e.g. Answer in Spanish. Be blunt. Push back on vague plans…"
          className="w-full resize-y bg-raised border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text placeholder:text-faint focus:outline-none focus:border-border-strong"
          defaultValue={settings.chatPersona ?? ''}
          key={settings.chatPersona ?? ''}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v !== (settings.chatPersona ?? '')) save({ chatPersona: v || null })
          }}
        />
        <p className="text-[11px] text-faint">
          Extra standing instructions added to the assistant&apos;s system prompt — tone, language,
          how to behave. Applies from the next message.
        </p>
      </div>

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
          The chat panel and MCP server use your Claude Code login. The app itself never needs it.
        </p>
        <Button
          variant="ghost"
          onClick={() => void api.invoke('settings:authStatus').then(setAuth)}
        >
          re-check auth
        </Button>
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
  )
}

function VoiceSection({ settings, save }: SectionProps): React.JSX.Element {
  const [voices, setVoices] = useState<{ voiceId: string; name: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!settings.elevenLabsApiKey) {
      setVoices(null)
      setError(null)
      return
    }
    void api.invoke('tts:voices').then((res) => {
      if (res.ok) {
        setVoices(res.voices)
        setError(null)
      } else {
        setVoices(null)
        setError(res.message)
      }
    })
  }, [settings.elevenLabsApiKey])

  return (
    <div className="space-y-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
        voice briefing (elevenlabs)
      </span>
      <div className="flex gap-1.5">
        <Input
          className="flex-1 font-mono text-[11px]"
          placeholder="api key"
          type="password"
          defaultValue={settings.elevenLabsApiKey ?? ''}
          key={`elkey-${settings.elevenLabsApiKey ?? ''}`}
          onBlur={(e) => save({ elevenLabsApiKey: e.target.value.trim() || null })}
        />
        {voices && (
          <Select
            value={settings.elevenLabsVoiceId ?? ''}
            onChange={(e) => save({ elevenLabsVoiceId: e.target.value || null })}
            className="flex-1"
            title="Voice"
          >
            <option value="">Default voice</option>
            {voices.map((v) => (
              <option key={v.voiceId} value={v.voiceId}>
                {v.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {error && (
        <p className="text-[11.5px] text-danger">
          Voice list unavailable: {error} The briefing still works with the default voice.
        </p>
      )}
      <p className="text-[11px] text-faint">
        Adds a speaker button on Today that reads your day aloud, and powers the mic buttons for
        voice capture. Get a key at elevenlabs.io → profile → API keys (free tier is plenty).
        Restricted keys need at least text-to-speech permission; add voices-read to pick a voice
        here.
      </p>
    </div>
  )
}

const STATUS_TONE = {
  connected: 'ok',
  needs_auth: 'danger',
  error: 'danger',
  disabled: 'muted'
} as const

function ConnectionsSection({ settings, save }: SectionProps): React.JSX.Element {
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
    <div className="space-y-2.5">
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
                <Button
                  variant="ghost"
                  className="!py-0.5 text-[11px]"
                  onClick={() => connect(a.provider as 'gmail' | 'slack')}
                >
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

      <div className="flex flex-wrap gap-1.5">
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
                One project serves <b>all</b> your Google accounts — set this up once (full
                guide: docs/google-setup.md in the repo):
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
                  Credentials → Create credentials → OAuth client ID → <b>Desktop app</b> → copy
                  id + secret here
                </li>
              </ol>
              <p>
                Then click “+ Gmail” once per account. Google will warn the app is unverified —
                it’s yours: Advanced → “Go to Kairos”.
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
              api.slack.com/apps → create app → OAuth &amp; Permissions → add redirect URL{' '}
              <code className="font-mono">http://localhost:43117/callback</code>, then connect.
              Works per workspace.
            </p>
          </div>
        </div>
      </details>
    </div>
  )
}

function RemoteSection({ settings, save }: SectionProps): React.JSX.Element {
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
      <Row
        label="remote access"
        hint={
          <>
            Serve the app over your private network (Tailscale / same Wi-Fi) so a phone or
            browser can use it. Data requires the link&apos;s token; keep it private.
          </>
        }
      >
        <input
          type="checkbox"
          checked={settings.remoteAccess}
          onChange={(e) => save({ remoteAccess: e.target.checked })}
          className="accent-accent w-4 h-4 shrink-0"
        />
      </Row>
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
          {status.running && status.httpsUrl && status.serveActive && (
            <RemoteHttpsRow url={status.httpsUrl} />
          )}
          {status.running && !status.httpsUrl && (
            <p className="text-[11px] text-faint">
              For the iPhone: install Tailscale on Mac + phone (same account), then run{' '}
              <code className="font-mono">tailscale serve --bg localhost:{status.port}</code>{' '}
              once — an HTTPS link will appear here.
            </p>
          )}
          {status.running && status.httpsUrl && !status.serveActive && (
            <p className="text-[11px] text-faint">
              Tailscale found — run{' '}
              <code className="font-mono">tailscale serve --bg localhost:{status.port}</code>{' '}
              once to activate the HTTPS link for the iPhone.
            </p>
          )}
          <label className="flex items-start justify-between gap-4 pt-1.5 cursor-pointer">
            <div>
              <span className="text-[12px] text-text">Allow terminal access</span>
              <p className="text-[11px] text-danger/90">
                Grants a shell on this Mac to anyone with the link. Only enable on a trusted
                private network.
              </p>
            </div>
            <input
              type="checkbox"
              checked={settings.remoteTerminal}
              onChange={(e) => save({ remoteTerminal: e.target.checked })}
              className="accent-danger w-4 h-4 shrink-0 mt-0.5"
            />
          </label>
        </div>
      )}
    </div>
  )
}

function RemoteHttpsRow({ url }: { url: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="space-y-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
        iphone (https)
      </span>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate font-mono text-[11px] text-muted bg-raised border border-border rounded px-2 py-1">
          {url}
        </code>
        <Button variant="ghost" onClick={copy}>
          {copied ? 'copied' : 'copy link'}
        </Button>
      </div>
    </div>
  )
}
