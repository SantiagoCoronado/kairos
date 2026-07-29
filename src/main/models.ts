// Whisper model downloads — lazy pull on first use, verified by byte size,
// atomic .part → rename (speaches pattern: no model-manager UI, models
// just arrive when needed). Files land in ~/Kairos/models/.

import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'

export type MeetingModel = 'large-v3-turbo' | 'base' | 'tiny'

export interface ModelFile {
  file: string
  url: string
  bytes: number
  label: string
}

// sizes verified against HF content-length 2026-07-28 — the byte count is
// the integrity check, keep in sync when bumping model versions
export const WHISPER_MODELS: Record<MeetingModel, ModelFile> = {
  'large-v3-turbo': {
    file: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    bytes: 1_624_555_275,
    label: 'Large v3 turbo (1.6 GB) — best quality'
  },
  base: {
    file: 'ggml-base.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    bytes: 147_951_465,
    label: 'Base (148 MB) — fast, rougher'
  },
  tiny: {
    file: 'ggml-tiny.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
    bytes: 77_691_713,
    label: 'Tiny (78 MB) — quick tests'
  }
}

/** Silero VAD — gates Whisper's silence hallucination on both channels */
export const VAD_MODEL: ModelFile = {
  file: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  bytes: 885_098,
  label: 'Silero VAD (0.9 MB)'
}

export type ModelProgress = (received: number, total: number) => void

export async function isModelPresent(dir: string, info: ModelFile): Promise<boolean> {
  try {
    return (await stat(join(dir, info.file))).size === info.bytes
  } catch {
    return false
  }
}

/** Download (or confirm) a model file; resolves to its absolute path. */
export async function ensureModelFile(
  dir: string,
  info: ModelFile,
  onProgress?: ModelProgress,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const path = join(dir, info.file)
  if (await isModelPresent(dir, info)) return path

  await mkdir(dir, { recursive: true })
  const res = await fetchFn(info.url)
  if (!res.ok || !res.body) throw new Error(`model download failed (${res.status}): ${info.file}`)

  const part = `${path}.part`
  const ws = createWriteStream(part)
  let received = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length
      onProgress?.(received, info.bytes)
      if (!ws.write(chunk)) await once(ws, 'drain')
    }
    await new Promise<void>((resolve, reject) => ws.end((err?: Error) => (err ? reject(err) : resolve())))
    const size = (await stat(part)).size
    if (size !== info.bytes)
      throw new Error(`model download truncated: ${info.file} (${size}/${info.bytes} bytes)`)
    await rename(part, path)
    return path
  } catch (err) {
    ws.destroy()
    await rm(part, { force: true })
    throw err
  }
}
