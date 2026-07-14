// Minimal ElevenLabs REST client (TTS + voice list). Raw fetch like gcal/gmail —
// auth is a single xi-api-key header, so an SDK buys nothing.
const BASE = 'https://api.elevenlabs.io/v1'

// flash v2.5: lowest latency + half the per-character cost of multilingual v2
const MODEL_ID = 'eleven_flash_v2_5'
// 128 kbps mp3 is available on every plan (192 needs Creator+)
const OUTPUT_FORMAT = 'mp3_44100_128'

// premade "Sarah" — usable for TTS on every plan, including restricted free
// keys that lack voices_read (library voices 402 for free accounts, premades don't)
export const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'

export interface ElevenVoice {
  voiceId: string
  name: string
}

async function elevenFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'xi-api-key': apiKey, ...(init.headers ?? {}) }
    })
  } catch (err) {
    throw new Error(
      `ElevenLabs unreachable: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!res.ok) {
    const detail = await errorDetail(res)
    if (res.status === 401) throw new Error(`ElevenLabs rejected the API key — ${detail}`)
    throw new Error(`ElevenLabs error ${res.status}: ${detail}`)
  }
  return res
}

/** error bodies look like { detail: { message } } or { detail: string } */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: { message?: string } | string }
    if (typeof body.detail === 'string') return body.detail
    return body.detail?.message ?? res.statusText
  } catch {
    return res.statusText
  }
}

export async function listVoices(apiKey: string): Promise<ElevenVoice[]> {
  const res = await elevenFetch(apiKey, '/voices')
  const body = (await res.json()) as { voices?: { voice_id: string; name: string }[] }
  return (body.voices ?? []).map((v) => ({ voiceId: v.voice_id, name: v.name }))
}

/** Scribe speech-to-text: audio bytes in, transcript out */
export async function transcribe(apiKey: string, audio: Buffer, mime: string): Promise<string> {
  const form = new FormData()
  form.append('model_id', 'scribe_v1')
  const ext = mime.includes('mp4') ? 'mp4' : 'webm'
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `memo.${ext}`)
  const res = await elevenFetch(apiKey, '/speech-to-text', { method: 'POST', body: form })
  const body = (await res.json()) as { text?: string }
  return (body.text ?? '').trim()
}

export async function synthesize(apiKey: string, voiceId: string, text: string): Promise<Buffer> {
  const res = await elevenFetch(
    apiKey,
    `/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: MODEL_ID })
    }
  )
  return Buffer.from(await res.arrayBuffer())
}
