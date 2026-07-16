// Embedding worker — runs in an Electron utilityProcess, NOT the main
// process. Two reasons, both learned the hard way (the v0.1.0 boot crash):
// onnxruntime inference stalls whatever thread hosts it (~3s per backfill
// sweep), and its BFC memory arena ballooned across variable-shape batches
// until a fatal allocation took the whole app down. Here a crash kills only
// this process — the parent restarts it and the sweep resumes where the
// per-batch upserts left off.
//
// Protocol (process.parentPort messages):
//   in : { id, kind: 'passages' | 'query', texts: string[], cacheDir }
//   out: { id, ok: true, dims, vecs: Float32Array[] } | { id, ok: false, error }
import type { FeatureExtractionPipeline } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/multilingual-e5-small'

let pipePromise: Promise<FeatureExtractionPipeline> | null = null

function getPipeline(cacheDir: string): Promise<FeatureExtractionPipeline> {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.cacheDir = cacheDir
      return pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        // no BFC arena: it never shrinks and grows per input shape — with
        // hundreds of distinct (batch × seqlen) shapes in a backfill it OOMs.
        // Plain allocation is marginally slower and stays flat.
        session_options: { enableCpuMemArena: false }
      })
    })()
    pipePromise.catch(() => {
      pipePromise = null // a failed load (offline) retries on the next request
    })
  }
  return pipePromise
}

interface EmbedRequest {
  id: number
  kind: 'passages' | 'query'
  texts: string[]
  cacheDir: string
}

/** project count×dims vectors to 2D. Heavy (tens of seconds at 12k points,
 *  umap-js is pure JS) — exactly why it lives in this process, not main. */
interface UmapRequest {
  id: number
  kind: 'umap'
  vectors: Float32Array
  count: number
  dims: number
}

process.parentPort.on('message', (e: Electron.MessageEvent) => {
  const req = e.data as EmbedRequest | UmapRequest
  if (req.kind === 'umap') void handleUmap(req)
  else void handle(req)
})

async function handle(req: EmbedRequest): Promise<void> {
  try {
    const pipe = await getPipeline(req.cacheDir)
    const prefixed = req.texts.map((t) => (req.kind === 'query' ? `query: ${t}` : `passage: ${t}`))
    const res = await pipe(prefixed, { pooling: 'mean', normalize: true })
    const dims = res.dims[1]
    const data = res.data as Float32Array
    const vecs: Float32Array[] = []
    for (let i = 0; i < req.texts.length; i++) vecs.push(data.slice(i * dims, (i + 1) * dims))
    process.parentPort.postMessage({ id: req.id, ok: true, dims, vecs })
  } catch (err) {
    process.parentPort.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

async function handleUmap(req: UmapRequest): Promise<void> {
  try {
    const { UMAP } = await import('umap-js')
    const rows: number[][] = []
    for (let i = 0; i < req.count; i++)
      rows.push(Array.from(req.vectors.subarray(i * req.dims, (i + 1) * req.dims)))
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: 15,
      minDist: 0.1,
      // vectors are L2-normalized, so cosine ranking ≈ euclidean here — the
      // default metric keeps umap-js on its fast path
      random: mulberry32(42) // deterministic layout across refits
    })
    const nEpochs = umap.initializeFit(rows)
    // step() so the process stays responsive to a kill during long fits
    for (let e = 0; e < nEpochs; e++) {
      umap.step()
      if (e % 50 === 0) await new Promise((r) => setImmediate(r))
    }
    const out = umap.getEmbedding()
    const coords = new Float32Array(req.count * 2)
    for (let i = 0; i < req.count; i++) {
      coords[i * 2] = out[i][0]
      coords[i * 2 + 1] = out[i][1]
    }
    process.parentPort.postMessage({ id: req.id, ok: true, coords })
  } catch (err) {
    process.parentPort.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** small deterministic PRNG for reproducible layouts */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
