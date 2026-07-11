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
