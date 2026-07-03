import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
  ClaudeLimitBucket,
  ClaudeLimits,
  ClaudeUsageModel,
  ClaudeUsageStats,
  ClaudeUsageToday
} from '../shared/ipc-contract'
import { DATA_DIR } from './db'

/**
 * Today's Claude Code usage, computed from the session transcripts Claude
 * Code writes to ~/.claude/projects/<project>/<session>.jsonl. Every
 * assistant message carries a `usage` block with exact token counts, so this
 * needs no network and no credentials — same approach as ccusage.
 */

// $/MTok: input, output, 5-minute cache write, 1-hour cache write, cache read.
// Models without an entry (e.g. fable/mythos) report costUsd: null.
const PRICES: [match: string, rates: [number, number, number, number, number]][] = [
  ['opus', [15, 75, 18.75, 30, 1.5]],
  ['sonnet', [3, 15, 3.75, 6, 0.3]],
  ['haiku-4', [1, 5, 1.25, 2, 0.1]],
  ['haiku-3-5', [0.8, 4, 1, 1.6, 0.08]],
  ['haiku', [0.25, 1.25, 0.3, 0.5, 0.03]]
]

function ratesFor(model: string): [number, number, number, number, number] | null {
  for (const [match, rates] of PRICES) if (model.includes(match)) return rates
  return null
}

interface ModelAcc {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

interface UsageLine {
  type?: string
  timestamp?: string
  requestId?: string
  sessionId?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
    }
  }
}

let cache: { key: string; at: number; result: ClaudeUsageToday } | null = null
const CACHE_TTL_MS = 60_000

export async function getClaudeUsageToday(): Promise<ClaudeUsageToday> {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const key = dayStart.toDateString()
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.result

  const models = new Map<string, ModelAcc>()
  const seen = new Set<string>()
  const sessions = new Set<string>()
  const from = dayStart.getTime()
  const to = from + 24 * 3600_000

  const projectsDir = join(homedir(), '.claude', 'projects')
  let dirs: string[] = []
  try {
    dirs = await readdir(projectsDir)
  } catch {
    // no Claude Code installation — empty report
  }
  for (const dir of dirs) {
    let files: string[] = []
    try {
      files = await readdir(join(projectsDir, dir))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(projectsDir, dir, file)
      try {
        // a file last written before today can't contain today's messages
        if ((await stat(path)).mtimeMs < from) continue
        await scanFile(path, from, to, models, seen, sessions)
      } catch {
        continue
      }
    }
  }

  const byModel: ClaudeUsageModel[] = [...models.entries()]
    .map(([model, a]) => {
      const rates = ratesFor(model)
      const cacheCreation = a.cacheWrite5m + a.cacheWrite1h
      return {
        model,
        inputTokens: a.input,
        outputTokens: a.output,
        cacheReadTokens: a.cacheRead,
        cacheCreationTokens: cacheCreation,
        totalTokens: a.input + a.output + a.cacheRead + cacheCreation,
        costUsd: rates
          ? (a.input * rates[0] +
              a.output * rates[1] +
              a.cacheWrite5m * rates[2] +
              a.cacheWrite1h * rates[3] +
              a.cacheRead * rates[4]) /
            1e6
          : null
      }
    })
    .sort((x, y) => y.totalTokens - x.totalTokens)

  const result: ClaudeUsageToday = {
    messages: seen.size,
    sessions: sessions.size,
    totalTokens: byModel.reduce((s, m) => s + m.totalTokens, 0),
    costUsd: byModel.reduce((s, m) => s + (m.costUsd ?? 0), 0),
    costIsPartial: byModel.some((m) => m.costUsd === null),
    byModel
  }
  cache = { key, at: Date.now(), result }
  return result
}

// ---------------------------------------------------------------------------
// Rate limits (how much usage is left). Same source Claude Code's /usage
// screen uses: the OAuth usage endpoint, authenticated with the user's own
// Claude Code token. Read-only — the token is never refreshed or mutated
// here, so Claude Code's own session is untouched.

const LIMIT_LABELS: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'week · all models',
  seven_day_opus: 'week · opus',
  seven_day_sonnet: 'week · sonnet',
  seven_day_fable: 'week · fable'
}
const LIMIT_ORDER = Object.keys(LIMIT_LABELS)

let limitsCache: { at: number; result: ClaudeLimits | null } | null = null
const LIMITS_TTL_MS = 2 * 60_000

async function readClaudeOAuthToken(): Promise<string | null> {
  // macOS: Claude Code stores credentials in the login keychain
  const fromKeychain = await new Promise<string | null>((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5_000 },
      (err, stdout) => resolve(err ? null : stdout.trim())
    )
  })
  let raw = fromKeychain
  if (!raw) {
    try {
      raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    } catch {
      return null
    }
  }
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }
    const oauth = j.claudeAiOauth
    if (!oauth?.accessToken) return null
    // a stale token would 401 anyway; skip the request when clearly expired
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) return null
    return oauth.accessToken
  } catch {
    return null
  }
}

export async function getClaudeLimits(): Promise<ClaudeLimits | null> {
  if (limitsCache && Date.now() - limitsCache.at < LIMITS_TTL_MS) return limitsCache.result
  let result: ClaudeLimits | null = null
  try {
    const token = await readClaudeOAuthToken()
    if (token) {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(10_000)
      })
      if (res.ok) {
        const body = (await res.json()) as Record<
          string,
          { utilization?: number; resets_at?: string | null } | unknown
        >
        const buckets: ClaudeLimitBucket[] = []
        for (const [key, val] of Object.entries(body)) {
          if (!val || typeof val !== 'object') continue
          const { utilization, resets_at } = val as { utilization?: number; resets_at?: string | null }
          if (typeof utilization !== 'number') continue
          // known windows always show; unknown extras only once they have usage
          if (!(key in LIMIT_LABELS) && utilization === 0) continue
          buckets.push({
            key,
            label: LIMIT_LABELS[key] ?? key.replace(/_/g, ' '),
            utilization,
            resetsAt: resets_at ?? null
          })
        }
        buckets.sort((a, b) => {
          const ia = LIMIT_ORDER.indexOf(a.key)
          const ib = LIMIT_ORDER.indexOf(b.key)
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
        })
        if (buckets.length) result = { fetchedAt: new Date().toISOString(), buckets }
      }
    }
  } catch {
    result = null
  }
  limitsCache = { at: Date.now(), result }
  return result
}

// ---------------------------------------------------------------------------
// All-time stats (heatmap + streaks). A full pass over every transcript is a
// few hundred MB, so per-file aggregates are cached on disk keyed by
// (size, mtime) — after the first scan only the live session file re-reads.

interface FileAgg {
  size: number
  mtimeMs: number
  /** local YYYY-MM-DD → counts */
  days: Record<string, { tokens: number; messages: number }>
  /** messages per local hour 0–23 */
  hours: number[]
  /** model → total tokens */
  models: Record<string, number>
  sessions: string[]
}

const STATS_CACHE_FILE = join(DATA_DIR, 'claude-usage-cache.json')
let statsCache: { at: number; result: ClaudeUsageStats } | null = null
const STATS_TTL_MS = 5 * 60_000

function localDateKey(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function getClaudeUsageStats(): Promise<ClaudeUsageStats> {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.result

  let fileCache: Record<string, FileAgg> = {}
  try {
    fileCache = JSON.parse(await readFile(STATS_CACHE_FILE, 'utf8')) as Record<string, FileAgg>
  } catch {
    // first run
  }

  const fresh: Record<string, FileAgg> = {}
  let cacheDirty = false
  const projectsDir = join(homedir(), '.claude', 'projects')
  let dirs: string[] = []
  try {
    dirs = await readdir(projectsDir)
  } catch {
    // no Claude Code installation
  }
  for (const dir of dirs) {
    let files: string[] = []
    try {
      files = await readdir(join(projectsDir, dir))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(projectsDir, dir, file)
      try {
        const st = await stat(path)
        const hit = fileCache[path]
        if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
          fresh[path] = hit
        } else {
          fresh[path] = await scanFileAgg(path, st.size, st.mtimeMs)
          cacheDirty = true
        }
      } catch {
        continue
      }
    }
  }
  if (cacheDirty || Object.keys(fileCache).length !== Object.keys(fresh).length) {
    writeFile(STATS_CACHE_FILE, JSON.stringify(fresh)).catch(() => {})
  }

  // merge
  const days = new Map<string, { tokens: number; messages: number }>()
  const hours = new Array<number>(24).fill(0)
  const models = new Map<string, number>()
  const sessions = new Set<string>()
  for (const agg of Object.values(fresh)) {
    for (const [k, v] of Object.entries(agg.days)) {
      const d = days.get(k) ?? { tokens: 0, messages: 0 }
      d.tokens += v.tokens
      d.messages += v.messages
      days.set(k, d)
    }
    agg.hours.forEach((n, h) => (hours[h] += n))
    for (const [m, t] of Object.entries(agg.models)) models.set(m, (models.get(m) ?? 0) + t)
    agg.sessions.forEach((s) => sessions.add(s))
  }

  // streaks over sorted active days
  const active = [...days.keys()].sort()
  let longest = 0
  let run = 0
  let prev = ''
  for (const k of active) {
    run = prev && nextDay(prev) === k ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = k
  }
  const today = localDateKey(Date.now())
  let current = 0
  // streak may end today or (if today is quiet so far) yesterday
  let cursor = days.has(today) ? today : prevDay(today)
  while (days.has(cursor)) {
    current++
    cursor = prevDay(cursor)
  }

  const peak = hours.some((n) => n > 0) ? hours.indexOf(Math.max(...hours)) : null
  const favorite =
    [...models.entries()].filter(([m]) => m !== 'unknown').sort((a, b) => b[1] - a[1])[0]?.[0] ??
    null

  // heatmap window: from the Monday 25 weeks before this week's Monday, to today
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 25 * 7)
  const heatDays: { date: string; tokens: number }[] = []
  for (let d = new Date(start); localDateKey(d.getTime()) <= today; d.setDate(d.getDate() + 1)) {
    const k = localDateKey(d.getTime())
    heatDays.push({ date: k, tokens: days.get(k)?.tokens ?? 0 })
  }

  const result: ClaudeUsageStats = {
    sessions: sessions.size,
    messages: [...days.values()].reduce((s, d) => s + d.messages, 0),
    totalTokens: [...days.values()].reduce((s, d) => s + d.tokens, 0),
    activeDays: days.size,
    currentStreak: current,
    longestStreak: longest,
    peakHour: peak,
    favoriteModel: favorite,
    days: heatDays
  }
  statsCache = { at: Date.now(), result }
  return result
}

function nextDay(key: string): string {
  const d = new Date(`${key}T12:00:00`)
  d.setDate(d.getDate() + 1)
  return localDateKey(d.getTime())
}

function prevDay(key: string): string {
  const d = new Date(`${key}T12:00:00`)
  d.setDate(d.getDate() - 1)
  return localDateKey(d.getTime())
}

async function scanFileAgg(path: string, size: number, mtimeMs: number): Promise<FileAgg> {
  const agg: FileAgg = { size, mtimeMs, days: {}, hours: new Array(24).fill(0), models: {}, sessions: [] }
  const seen = new Set<string>()
  const sessions = new Set<string>()
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let obj: UsageLine
    try {
      obj = JSON.parse(line) as UsageLine
    } catch {
      continue
    }
    const usage = obj.message?.usage
    if (obj.type !== 'assistant' || !usage || !obj.timestamp) continue
    const t = Date.parse(obj.timestamp)
    if (!Number.isFinite(t)) continue
    const model = obj.message?.model ?? 'unknown'
    if (model === '<synthetic>') continue
    const dedupe = `${obj.message?.id ?? line.length}:${obj.requestId ?? ''}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    if (obj.sessionId) sessions.add(obj.sessionId)

    const cc = usage.cache_creation
    const cacheWrite =
      cc && (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens)
        ? (cc.ephemeral_5m_input_tokens ?? 0) + (cc.ephemeral_1h_input_tokens ?? 0)
        : (usage.cache_creation_input_tokens ?? 0)
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      cacheWrite

    const key = localDateKey(t)
    const day = agg.days[key] ?? { tokens: 0, messages: 0 }
    day.tokens += tokens
    day.messages += 1
    agg.days[key] = day
    agg.hours[new Date(t).getHours()] += 1
    agg.models[model] = (agg.models[model] ?? 0) + tokens
  }
  agg.sessions = [...sessions]
  return agg
}

async function scanFile(
  path: string,
  from: number,
  to: number,
  models: Map<string, ModelAcc>,
  seen: Set<string>,
  sessions: Set<string>
): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    // cheap pre-filter: assistant messages are the only lines with usage
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let obj: UsageLine
    try {
      obj = JSON.parse(line) as UsageLine
    } catch {
      continue
    }
    const usage = obj.message?.usage
    if (obj.type !== 'assistant' || !usage || !obj.timestamp) continue
    const t = Date.parse(obj.timestamp)
    if (!(t >= from && t < to)) continue
    const model = obj.message?.model ?? 'unknown'
    if (model === '<synthetic>') continue
    // streaming writes one line per content block, all sharing the message id
    const dedupe = `${obj.message?.id ?? line.length}:${obj.requestId ?? ''}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    if (obj.sessionId) sessions.add(obj.sessionId)

    const acc = models.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
    acc.input += usage.input_tokens ?? 0
    acc.output += usage.output_tokens ?? 0
    acc.cacheRead += usage.cache_read_input_tokens ?? 0
    const cc = usage.cache_creation
    if (cc && (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens)) {
      acc.cacheWrite5m += cc.ephemeral_5m_input_tokens ?? 0
      acc.cacheWrite1h += cc.ephemeral_1h_input_tokens ?? 0
    } else {
      acc.cacheWrite5m += usage.cache_creation_input_tokens ?? 0
    }
    models.set(model, acc)
  }
}
