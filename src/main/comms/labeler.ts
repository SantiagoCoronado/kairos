// Background email classifier (Notion-mail-style auto-labels), built to be
// stingy with tokens:
//   1. a zero-token heuristic pass (gmail's own CATEGORY_* labelIds + subject
//      keyword rules) classifies the bulk — promos, social, forums, receipts,
//      travel — without any model call;
//   2. only the residue (personal-ish / ambiguous mail) goes to the model, in
//      batches of 25 with subject+sender+snippet only, always on Haiku;
//   3. scope is bounded: inbox threads from the last 60 days, and a hard cap
//      of model batches per day, so a huge backlog can never melt a quota.
//
// OFF unless Settings → auto-label email is enabled; heuristics and model
// alike are idempotent — only threads with labels = '' are ever picked, and
// every classified thread ends with ≥1 label so nothing loops. Auth rides
// the user's Claude Code login (same as the chat panel and reply drafts).
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { DbDriver } from '../../core/driver'
import * as repo from '../../core/repo/comms'
import {
  buildLabelPrompt,
  parseLabelResponse,
  heuristicLabels,
  labelIdsFromRawJson,
  type LabelCandidate
} from '../../core/labels'
import { resolveClaudeBinary } from '../chat/agent'
import { buildChildEnv } from '../child-env'
import { getSettings } from '../settings'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'

/** classification is bulk triage — always the cheap model, never the chat model */
const LABEL_MODEL = 'haiku'
const SWEEP_INTERVAL_MS = 5 * 60_000
/** min gap between sweeps when new-mail nudges arrive in bursts */
const NUDGE_MIN_GAP_MS = 60_000
const BATCH_SIZE = 25
/** don't bother labeling threads older than this — label on demand instead */
const WINDOW_DAYS = 60
/** worst-case model spend: 20 batches ≈ 500 threads ≈ ~40k haiku tokens/day */
const MAX_MODEL_BATCHES_PER_DAY = 20

export class CommsLabeler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private lastRunAt = 0
  private stopped = false
  private budgetDay = ''
  private batchesToday = 0

  constructor(
    private db: DbDriver,
    private onChanged: () => void
  ) {}

  start(): void {
    // small delay so app boot and the first sync settle before any model call
    setTimeout(() => void this.sweep(), 30_000)
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  /** new inbound mail landed — classify soon instead of waiting out the interval */
  nudge(): void {
    if (Date.now() - this.lastRunAt < NUDGE_MIN_GAP_MS) return
    void this.sweep()
  }

  private modelBudgetLeft(): boolean {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.budgetDay) {
      this.budgetDay = today
      this.batchesToday = 0
    }
    return this.batchesToday < MAX_MODEL_BATCHES_PER_DAY
  }

  private async sweep(): Promise<void> {
    if (this.running || this.stopped) return
    if (!getSettings().autoLabel) return
    const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const threads = repo.listUnlabeledEmailThreads(this.db, sinceIso, BATCH_SIZE)
    if (threads.length === 0) return

    this.running = true
    this.lastRunAt = Date.now()
    try {
      // pass 1: free — gmail categories + keyword rules
      const needModel: typeof threads = []
      let heuristic = 0
      for (const t of threads) {
        const quick = heuristicLabels(labelIdsFromRawJson(t.newest_raw), t.title, t.snippet)
        if (quick) {
          repo.setThreadLabels(this.db, t.id, quick)
          heuristic++
        } else {
          needModel.push(t)
        }
      }

      // pass 2: the residue, one haiku batch, budget permitting
      let modeled = 0
      const bin = resolveClaudeBinary()
      if (needModel.length > 0 && bin && this.modelBudgetLeft()) {
        this.batchesToday++
        const candidates: LabelCandidate[] = needModel.map((t) => ({
          id: t.id,
          sender: t.sender,
          subject: t.title,
          snippet: t.snippet
        }))
        const text = await this.classify(buildLabelPrompt(candidates), bin)
        const result = parseLabelResponse(text, candidates)
        for (const [threadId, labels] of result) repo.setThreadLabels(this.db, threadId, labels)
        modeled = result.size
      }

      if (heuristic + modeled > 0) {
        this.onChanged()
        logLine('info', 'comms', `auto-labeled ${heuristic + modeled} threads (${heuristic} heuristic, ${modeled} model)`)
      }
    } catch (err) {
      // never surface as an account error — labels are a nice-to-have layer
      logLine('warn', 'comms', `auto-label sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.running = false
    }
  }

  /** One-shot, tool-less model call; the reply is the raw classification text. */
  private async classify(prompt: string, bin: string): Promise<string> {
    const q = query({
      prompt,
      options: {
        permissionMode: 'default',
        settingSources: [],
        strictMcpConfig: true,
        systemPrompt:
          'You are an email triage classifier. You output only the requested JSON object, nothing else.',
        model: LABEL_MODEL,
        maxTurns: 1,
        cwd: DATA_DIR,
        env: buildChildEnv() as Record<string, string>,
        pathToClaudeCodeExecutable: bin
      }
    })
    let text = ''
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text
        }
      } else if (msg.type === 'result' && msg.subtype !== 'success') {
        throw new Error(`classifier run ended: ${msg.subtype}`)
      }
    }
    return text
  }
}
