import type { CaptureContext } from '../../../shared/ipc-contract'
import { api } from './api'
import { toast, updateToast } from './toast'

/** Fire-and-forget a spoken instruction: the palette can close immediately
 *  and the outcome lands as a toast wherever the user is. Success
 *  auto-dismisses; failure sticks until dismissed. */
export function runVoiceInstruction(text: string, context?: CaptureContext): void {
  const id = toast({ variant: 'working', text: 'Working on it…', detail: `“${text}”` })
  api.invoke('capture:instruct', text, context).then(
    (res) => {
      if (res.ok) updateToast(id, { variant: 'success', text: res.message })
      else updateToast(id, { variant: 'error', text: res.message, detail: `“${text}”` })
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      updateToast(id, { variant: 'error', text: message, detail: `“${text}”` })
    }
  )
}
