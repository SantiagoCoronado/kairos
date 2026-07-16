// Local embedding model: multilingual-e5-small (int8 ONNX) via Transformers.js.
// Chosen after benchmarking on this Mac: ~530 docs/s batch, ~4ms single,
// strongest ES+EN cross-lingual retrieval at this size. The 113MB model is
// downloaded once into ~/Kairos/models and everything runs on-device — no
// text ever leaves the machine.
//
// e5 models are trained with role prefixes: documents embed as "passage: …",
// queries as "query: …". Both sides are handled here so callers never see it.
import { join } from 'node:path'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'

const MODEL_ID = 'Xenova/multilingual-e5-small'

export type EmbedderState = 'idle' | 'loading' | 'ready' | 'error'

type FeaturePipeline = (
  texts: string | string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>

let pipe: FeaturePipeline | null = null
let loading: Promise<FeaturePipeline> | null = null
let state: EmbedderState = 'idle'
let lastError: string | null = null

export function embedderState(): { state: EmbedderState; error: string | null } {
  return { state, error: lastError }
}

/** lazy-load; concurrent callers share one download/compile */
async function getPipeline(): Promise<FeaturePipeline> {
  if (pipe) return pipe
  if (loading) return loading
  state = 'loading'
  loading = (async () => {
    // dynamic import keeps the 40MB dependency out of app boot entirely
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = join(DATA_DIR, 'models')
    const started = Date.now()
    const p = (await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8'
    })) as unknown as FeaturePipeline
    logLine('info', 'semantic', `embedder ready in ${Date.now() - started}ms (${MODEL_ID})`)
    pipe = p
    state = 'ready'
    lastError = null
    return p
  })()
  try {
    return await loading
  } catch (err) {
    state = 'error'
    lastError = err instanceof Error ? err.message : String(err)
    logLine('warn', 'semantic', `embedder failed to load: ${lastError}`)
    throw err
  } finally {
    loading = null
  }
}

/** split one flat output tensor back into per-text vectors */
function splitRows(data: Float32Array, rows: number, dims: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < rows; i++) out.push(data.slice(i * dims, (i + 1) * dims))
  return out
}

export async function embedPassages(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const p = await getPipeline()
  const res = await p(texts.map((t) => `passage: ${t}`), { pooling: 'mean', normalize: true })
  return splitRows(res.data, texts.length, res.dims[1])
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const p = await getPipeline()
  const res = await p(`query: ${text}`, { pooling: 'mean', normalize: true })
  return res.data.slice(0, res.dims[1])
}
