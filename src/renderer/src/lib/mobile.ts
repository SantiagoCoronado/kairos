import { useEffect, useState } from 'react'

/** true when running in a plain browser over remote access (no preload bridge) */
export const IS_REMOTE = !window.api

const MQ = '(max-width: 767px)'

/** phone-sized viewport → the app renders the mobile shell (bottom tab bar) */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MQ).matches)
  useEffect(() => {
    const mq = window.matchMedia(MQ)
    const onChange = (): void => setMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}

/** height in px the on-screen keyboard covers (0 when closed). iOS shrinks
 *  only the *visual* viewport for the keyboard; fixed/bottom chrome would
 *  otherwise hide behind it. If a platform resizes the layout viewport
 *  instead, innerHeight shrinks in step and this stays 0 — harmless. */
export function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    const vv = window.visualViewport
    if (!vv) return undefined
    const update = (): void =>
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [enabled])
  return enabled ? inset : 0
}
