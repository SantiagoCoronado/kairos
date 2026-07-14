import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from './ui'

type VoiceState = 'idle' | 'recording' | 'transcribing'

/** tap to record, tap again to stop → ElevenLabs Scribe → onTranscript(text).
 *  Used by the quick-capture overlay and the Today header. */
export function MicButton({
  onTranscript,
  onError,
  size = 15,
  className
}: {
  onTranscript: (text: string) => void
  onError: (message: string) => void
  size?: number
  className?: string
}): React.JSX.Element {
  const [state, setState] = useState<VoiceState>('idle')
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  useEffect(
    () => () => {
      recRef.current?.stream.getTracks().forEach((t) => t.stop())
    },
    []
  )

  const toggle = async (): Promise<void> => {
    if (state === 'transcribing') return
    if (state === 'recording') {
      recRef.current?.stop()
      return
    }
    // insecure remote contexts (plain-http LAN link) have no mediaDevices at all
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      onError('Voice capture needs the HTTPS link (or a newer browser).')
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      onError('Microphone unavailable — check the mic permission for Kairos.')
      return
    }
    // Chromium records webm/opus; Safari (remote PWA) falls back to its default (mp4)
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : undefined
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunksRef.current = []
    rec.ondataavailable = (e): void => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    rec.onstop = async (): Promise<void> => {
      stream.getTracks().forEach((t) => t.stop())
      setState('transcribing')
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
      const res = await api.invoke(
        'stt:transcribe',
        await blobToBase64(blob),
        blob.type.split(';')[0]
      )
      setState('idle')
      if (res.ok) onTranscript(res.text)
      else onError(res.message)
    }
    recRef.current = rec
    rec.start()
    setState('recording')
  }

  return (
    <button
      onClick={() => void toggle()}
      title={
        state === 'recording'
          ? 'Stop and transcribe'
          : state === 'transcribing'
            ? 'Transcribing…'
            : 'Voice capture'
      }
      className={cn(
        'p-1 shrink-0',
        state === 'recording' ? 'text-danger' : 'text-faint hover:text-text',
        className
      )}
    >
      {state === 'transcribing' ? (
        <Loader2 size={size} className="animate-spin" />
      ) : (
        <Mic size={size} className={state === 'recording' ? 'animate-pulse' : ''} />
      )}
    </button>
  )
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
