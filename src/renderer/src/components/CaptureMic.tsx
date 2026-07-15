import { useEffect, useRef, useState } from 'react'
import { api, useInvoke } from '../lib/api'
import { MicButton } from './MicButton'

/** Mic that dictates straight into a task or note (capture:smart with a
 *  forced kind). Renders nothing without an ElevenLabs key — same gate as
 *  the chat composer mic. */
export function CaptureMic({ kind }: { kind: 'task' | 'note' }): React.JSX.Element | null {
  const { data: settings } = useInvoke('settings:get', [], ['settings'])
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = (f: { ok: boolean; message: string } | null, ms = 4000): void => {
    if (timer.current) clearTimeout(timer.current)
    setFlash(f)
    if (f) timer.current = setTimeout(() => setFlash(null), ms)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  if (!settings?.elevenLabsApiKey) return null
  return (
    <>
      {flash && (
        <span
          className={`font-mono text-[11px] shrink-0 max-w-[220px] truncate ${
            flash.ok ? 'text-ok' : 'text-danger'
          }`}
          title={flash.message}
        >
          {flash.message}
        </span>
      )}
      <MicButton
        onTranscript={(t) => {
          // the haiku parse can take a few seconds — hold a pending note
          show({ ok: true, message: `creating ${kind}…` }, 30_000)
          void api
            .invoke('capture:smart', t, kind)
            .then((res) => show(res))
            .catch((err) =>
              show({ ok: false, message: err instanceof Error ? err.message : String(err) })
            )
        }}
        onError={(message) => show({ ok: false, message })}
      />
    </>
  )
}
