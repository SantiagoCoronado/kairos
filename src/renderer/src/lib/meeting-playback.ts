// Dual-channel meeting playback. The mic + system archives were recorded
// simultaneously on the same clock, so they play as one recording: both
// elements are driven together and whichever exists is the master clock.
// Drift over a single listen is tolerable (docs/meetings-plan.md).

import { useEffect, useRef, useState } from 'react'
import type { Meeting } from '../../../core/types'
import { api } from './api'

export function useMeetingPlayback(meeting: Meeting): {
  playing: boolean
  loading: boolean
  error: string | null
  t: number
  toggle: () => Promise<void>
  seekTo: (seconds: number) => Promise<void>
} {
  const micRef = useRef<HTMLAudioElement | null>(null)
  const sysRef = useRef<HTMLAudioElement | null>(null)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      micRef.current?.pause()
      sysRef.current?.pause()
    }
  }, [])

  const ensureAudio = async (): Promise<HTMLAudioElement | null> => {
    if (micRef.current || sysRef.current) return micRef.current ?? sysRef.current
    setLoading(true)
    try {
      const load = async (channel: 'mic' | 'system'): Promise<HTMLAudioElement | null> => {
        const res = await api.invoke('meetings:audioData', meeting.id, channel)
        return res.ok ? new Audio(res.dataUrl) : null
      }
      const [mic, sys] = await Promise.all([
        meeting.mic_path ? load('mic') : null,
        meeting.system_path ? load('system') : null
      ])
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
      setLoading(false)
    }
  }

  const each = (fn: (a: HTMLAudioElement) => void): void => {
    for (const a of [micRef.current, sysRef.current]) if (a) fn(a)
  }

  const toggle = async (): Promise<void> => {
    if (playing) {
      each((a) => a.pause())
      setPlaying(false)
      return
    }
    const master = await ensureAudio()
    if (!master) return
    each((a) => void a.play())
    setPlaying(true)
  }

  const seekTo = async (seconds: number): Promise<void> => {
    const master = await ensureAudio()
    if (!master) return
    each((a) => {
      a.currentTime = seconds
    })
    setT(seconds)
    each((a) => void a.play())
    setPlaying(true)
  }

  return { playing, loading, error, t, toggle, seekTo }
}
