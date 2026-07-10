/// <reference types="vite/client" />
import type { RendererApi } from '../../shared/ipc-contract'

declare global {
  interface Window {
    /** present only inside Electron (preload bridge); remote browsers get the WS shim */
    api?: RendererApi
  }
}

export {}
