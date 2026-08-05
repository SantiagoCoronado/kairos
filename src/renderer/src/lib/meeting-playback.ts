// Dual-channel meeting playback. The mic + system archives were recorded
// simultaneously on the same clock, so they play as one recording: both
// elements are driven together and whichever exists is the master clock.
// Drift over a single listen is tolerable (docs/meetings-plan.md).
//
// One instance per meeting row — the row play button and the transcript
// modal must share it (two instances would double-play the same audio).

import { useEffect, useRef, useState } from 'react'
import type { Meeting } from '../../../core/types'
import { api } from './api'

export type MeetingPlayback = {
  playing: boolean
  loading: boolean
  error: string | null
  t: number
  toggle: () => Promise<void>
  seekTo: (seconds: number) => Promise<void>
}

export function useMeetingPlayback(meeting: Meeting): MeetingPlayback {
  const micRef = useRef<HTMLAudioElement | null>(null)
  const sysRef = useRef<HTMLAudioElement | null>(null)
  // in-flight load — a second click while bytes stream must not build a
  // second Audio pair (the first would keep playing with no way to stop it)
  const pendingRef = useRef<Promise<HTMLAudioElement | null> | null>(null)
  // guards the awaits: unmounting mid-fetch must not let the continuation
  // start audio reachable only from a dead closure
  const aliveRef = useRef(true)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      micRef.current?.pause()
      sysRef.current?.pause()
    }
  }, [])

  const ensureAudio = (): Promise<HTMLAudioElement | null> => {
    if (micRef.current || sysRef.current)
      return Promise.resolve(micRef.current ?? sysRef.current)
    if (pendingRef.current) return pendingRef.current
    setError(null)
    setLoading(true)
    const job = (async (): Promise<HTMLAudioElement | null> => {
      try {
        const load = async (channel: 'mic' | 'system'): Promise<HTMLAudioElement | null> => {
          const res = await api.invoke('meetings:audioData', meeting.id, channel)
          return res.ok ? new Audio(res.dataUrl) : null
        }
        const [mic, sys] = await Promise.all([
          meeting.mic_path ? load('mic') : null,
          meeting.system_path ? load('system') : null
        ])
        if (!aliveRef.current) return null
        if (!mic && !sys) {
          setError('Audio unavailable.')
          return null
        }
        micRef.current = mic
        sysRef.current = sys
        const master = mic ?? sys!
        master.addEventListener('timeupdate', () => setT(master.currentTime))
        master.addEventListener('ended', () => setPlaying(false))
        return master
      } finally {
        pendingRef.current = null
        if (aliveRef.current) setLoading(false)
      }
    })()
    pendingRef.current = job
    return job
  }

  const each = (fn: (a: HTMLAudioElement) => void): void => {
    for (const a of [micRef.current, sysRef.current]) if (a) fn(a)
  }

  const startAll = (): void => {
    setError(null)
    each((a) =>
      void a.play().catch((err) => {
        // pausing while play() is still pending rejects with AbortError —
        // that's the user's own pause, not a failure
        if ((err as DOMException)?.name === 'AbortError') return
        // a decode/play failure on either channel stops the pair — one
        // channel alone would silently drop half the conversation
        each((b) => b.pause())
        setError('Playback failed.')
        setPlaying(false)
      })
    )
    setPlaying(true)
  }

  const toggle = async (): Promise<void> => {
    if (playing) {
      each((a) => a.pause())
      setPlaying(false)
      return
    }
    const master = await ensureAudio()
    if (!master || !aliveRef.current) return
    startAll()
  }

  const seekTo = async (seconds: number): Promise<void> => {
    const master = await ensureAudio()
    if (!master || !aliveRef.current) return
    each((a) => {
      a.currentTime = seconds
    })
    setT(seconds)
    startAll()
  }

  return { playing, loading, error, t, toggle, seekTo }
}
