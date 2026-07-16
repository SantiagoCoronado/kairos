import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from './ui'

type VoiceState = 'idle' | 'recording' | 'transcribing'

// Auto-stop tuning: stop SILENCE_MS after speech ends. Hysteresis between the
// speech/silence thresholds keeps breath noise from re-arming the timer, and
// nothing auto-stops before speech was actually heard (unlike Siri, take your
// time to start). Byte-domain RMS is used for iOS Safari compatibility.
const SPEECH_RMS = 0.02
const SILENCE_RMS = 0.012
const SILENCE_MS = 1800
const HARD_CAP_MS = 120_000
const POLL_MS = 100

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
    const stopWatching = watchForSilence(stream, () => {
      if (rec.state === 'recording') rec.stop()
    })
    rec.onstop = async (): Promise<void> => {
      stopWatching()
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
          ? 'Listening — stops when you pause (tap to stop now)'
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

/** poll mic level; fire onSilence once speech has been heard and then the
 *  level stays under the silence threshold for SILENCE_MS (or at the hard cap).
 *  Returns a cleanup that tears down the audio graph. */
export function watchForSilence(stream: MediaStream, onSilence: () => void): () => void {
  let ctx: AudioContext
  try {
    ctx = new AudioContext()
  } catch {
    return () => {} // no WebAudio → tap-to-stop still works
  }
  void ctx.resume() // iOS creates contexts suspended outside some gestures
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  ctx.createMediaStreamSource(stream).connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  let heardSpeech = false
  let silenceSince: number | null = null
  const startedAt = Date.now()

  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    if (rms > SPEECH_RMS) {
      heardSpeech = true
      silenceSince = null
    } else if (heardSpeech && rms < SILENCE_RMS) {
      silenceSince ??= Date.now()
      if (Date.now() - silenceSince >= SILENCE_MS) onSilence()
    }
    if (Date.now() - startedAt >= HARD_CAP_MS) onSilence()
  }, POLL_MS)

  return () => {
    clearInterval(timer)
    void ctx.close()
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
