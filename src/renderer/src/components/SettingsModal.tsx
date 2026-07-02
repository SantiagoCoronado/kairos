import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { AppSettings, AuthStatus, ChatEffort } from '../../../shared/ipc-contract'
import { api } from '../lib/api'
import { applyTranslucency } from '../lib/translucency'
import { Input, Button, Chip, Select } from '../components/ui'

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
        className="w-[480px] bg-panel border border-border-strong rounded-xl shadow-2xl p-5 space-y-5"
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
