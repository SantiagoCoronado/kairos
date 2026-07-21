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
// OFF unless Settings → auto-label email is enabled — with one exception:
// notifyInbox 'important' routes email pings through the action-needed label,
// so it needs classification even when auto-label is off. That mode sweeps
// only mail fresh enough to still produce a banner (the notifier's recency
// window), so its token spend stays a fraction of a full sweep's.
// Heuristics and model alike are idempotent — only threads with labels = ''
// are ever picked, and every classified thread ends with ≥1 label so nothing
// loops. Auth rides the user's Claude Code login (same as the chat panel and
// reply drafts).
//
// The sweep also runs the WhatsApp notification triage (sweepWhatsapp):
// notifyInbox 'important' pings for a WhatsApp DM only when Haiku deems the
// fresh messages notification-worthy. Separate queue (notify_eval_at
// watermark, not labels), separate daily budget counted in threads.
// Fail-open (notify unfiltered) only on model OUTAGE; budget exhaustion
// defers quietly with at most one digest banner per day.
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { DbDriver } from '../../core/driver'
import * as repo from '../../core/repo/comms'
import {
  buildLabelPrompt,
  parseLabelResponse,
  heuristicLabels,
  labelIdsFromRawJson,
  buildMessageTriagePrompt,
  parseTriageResponse,
  heuristicMessageTriage,
  splitTriageBudget,
  type LabelCandidate,
  type MessageTriageCandidate
} from '../../core/labels'
import { resolveClaudeBinary } from '../chat/agent'
import { buildChildEnv } from '../child-env'
import { RECENT_WINDOW_MS } from './notifier'
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
/** whatsapp triage has its own budget — a chatty day must not starve email
 *  labeling (or vice versa). Counted in THREADS sent to the model, not
 *  sweeps: event-driven sweeps usually carry a single fresh thread, so a
 *  per-sweep cap burned out by mid-afternoon on chatty days. Worst case
 *  ~150 tiny haiku calls (sender + 3 short messages each) ≈ ~40k tokens/day,
 *  the same ballpark the email cap was approved at. */
const MAX_TRIAGE_THREADS_PER_DAY = 150
/** triage context: the last few inbound messages of a thread */
const TRIAGE_CONTEXT_MESSAGES = 3

export class CommsLabeler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private lastRunAt = 0
  private stopped = false
  private budgetDay = ''
  private batchesToday = 0
  private triageThreadsToday = 0
  /** day a triage-deferred digest already went out — at most one per day */
  private digestDay = ''

  constructor(
    private db: DbDriver,
    private onChanged: () => void,
    /** fired with the thread ids classified in a sweep (notification hook) */
    private onLabeled?: (threadIds: string[]) => void,
    /** fired with whatsapp thread ids the triage deemed notification-worthy */
    private onImportant?: (threadIds: string[]) => void,
    /** fired once per day when the triage budget ran out with threads unchecked */
    private onDeferred?: (count: number) => void
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

  /** new inbound mail/messages landed — classify soon instead of waiting out the interval */
  nudge(): void {
    if (Date.now() - this.lastRunAt < NUDGE_MIN_GAP_MS) return
    void this.sweep()
  }

  private rollBudgetDay(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.budgetDay) {
      this.budgetDay = today
      this.batchesToday = 0
      this.triageThreadsToday = 0
    }
  }

  private modelBudgetLeft(): boolean {
    this.rollBudgetDay()
    return this.batchesToday < MAX_MODEL_BATCHES_PER_DAY
  }

  private async sweep(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    this.lastRunAt = Date.now()
    try {
      await this.sweepEmail()
    } catch (err) {
      // never surface as an account error — labels are a nice-to-have layer
      logLine('warn', 'comms', `auto-label sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await this.sweepWhatsapp()
    } catch (err) {
      logLine('warn', 'comms', `whatsapp triage sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.running = false
  }

  private async sweepEmail(): Promise<void> {
    const settings = getSettings()
    // notification-only mode: important-email pings hinge on the
    // action-needed label, so classify fresh mail even with auto-label off —
    // but ONLY fresh mail (anything older can't produce a banner anyway)
    const notifyOnly = !settings.autoLabel && settings.notifyInbox === 'important'
    if (!settings.autoLabel && !notifyOnly) return
    const windowMs = notifyOnly ? RECENT_WINDOW_MS : WINDOW_DAYS * 24 * 60 * 60 * 1000
    const sinceIso = new Date(Date.now() - windowMs).toISOString()
    const threads = repo.listUnlabeledEmailThreads(this.db, sinceIso, BATCH_SIZE)
    if (threads.length === 0) return

    // pass 1: free — gmail categories + keyword rules
    const needModel: typeof threads = []
    const labeledIds: string[] = []
    let heuristic = 0
    for (const t of threads) {
      const quick = heuristicLabels(labelIdsFromRawJson(t.newest_raw), t.title, t.snippet)
      if (quick) {
        repo.setThreadLabels(this.db, t.id, quick)
        labeledIds.push(t.id)
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
      const text = await this.classify(buildLabelPrompt(candidates), bin, 'email')
      const result = parseLabelResponse(text, candidates)
      for (const [threadId, labels] of result) {
        repo.setThreadLabels(this.db, threadId, labels)
        labeledIds.push(threadId)
      }
      modeled = result.size
    }

    if (heuristic + modeled > 0) {
      this.onChanged()
      this.onLabeled?.(labeledIds)
      logLine('info', 'comms', `auto-labeled ${heuristic + modeled} threads (${heuristic} heuristic, ${modeled} model)`)
    }
  }

  /** Importance triage for fresh unread WhatsApp DMs — purely a notification
   *  feature (notifyInbox 'important'), so the window is the notifier's and
   *  no labels are written; the notify_eval_at watermark is the queue. */
  private async sweepWhatsapp(): Promise<void> {
    if (getSettings().notifyInbox !== 'important') return
    const sinceIso = new Date(Date.now() - RECENT_WINDOW_MS).toISOString()
    const threads = repo.listWhatsappTriageCandidates(this.db, sinceIso, BATCH_SIZE)
    if (threads.length === 0) return

    // pass 1: free — threads whose recent messages are all throwaway chatter
    const important: string[] = []
    const needModel: { thread: (typeof threads)[number]; messages: string[] }[] = []
    let heuristic = 0
    for (const t of threads) {
      const messages = repo.recentInboundBodies(this.db, t.id, TRIAGE_CONTEXT_MESSAGES)
      if (heuristicMessageTriage(messages) === 'routine') {
        repo.setThreadNotifyEval(this.db, t.id, t.last_message_at!)
        heuristic++
      } else {
        needModel.push({ thread: t, messages })
      }
    }

    // pass 2: haiku verdict. Two distinct failure modes, handled differently:
    //   OUTAGE (no binary / call fails, e.g. expired Claude login) — fail
    //   OPEN: silently dropping a genuinely urgent message would be worse
    //   than noise, so degrade to the old notify-everything behavior.
    //   BUDGET exhausted — fail QUIET: budget runs out precisely on the
    //   chattiest days, so notifying unfiltered would recreate the exact
    //   noise this feature exists to kill. Deferred threads stay unstamped
    //   (they retry while fresh and age out of the recency window) and a
    //   single digest banner per day says triage is paused.
    let modeled = 0
    let deferred = 0
    const bin = resolveClaudeBinary()
    if (needModel.length > 0) {
      if (!bin) {
        this.failOpen(needModel, important, 'no claude binary')
      } else {
        this.rollBudgetDay()
        const split = splitTriageBudget(needModel, MAX_TRIAGE_THREADS_PER_DAY - this.triageThreadsToday)
        deferred = split.deferred.length
        if (split.toModel.length > 0) {
          this.triageThreadsToday += split.toModel.length
          const candidates: MessageTriageCandidate[] = split.toModel.map(({ thread, messages }) => ({
            id: thread.id,
            sender: thread.sender,
            messages
          }))
          try {
            const text = await this.classify(buildMessageTriagePrompt(candidates), bin, 'message')
            const verdicts = parseTriageResponse(text, candidates)
            for (const { thread } of split.toModel) {
              const v = verdicts.get(thread.id)
              if (!v) continue // skipped by the model: retry next sweep while fresh
              repo.setThreadNotifyEval(this.db, thread.id, thread.last_message_at!)
              if (v === 'important') important.push(thread.id)
              modeled++
            }
          } catch (err) {
            this.failOpen(split.toModel, important, err instanceof Error ? err.message : String(err))
          }
        }
        if (deferred > 0) {
          logLine('warn', 'comms', `whatsapp triage budget exhausted — ${deferred} thread(s) deferred`)
          if (this.digestDay !== this.budgetDay) {
            this.digestDay = this.budgetDay
            this.onDeferred?.(deferred)
          }
        }
      }
    }

    if (heuristic + modeled > 0) {
      logLine(
        'info',
        'comms',
        `whatsapp triage: ${heuristic + modeled} threads (${heuristic} heuristic, ${modeled} model), ${important.length} important`
      )
    }
    if (important.length > 0) this.onImportant?.(important)
  }

  /** model OUTAGE path: stamp + notify unfiltered rather than risk silence */
  private failOpen(
    items: { thread: { id: string; last_message_at: string | null } }[],
    important: string[],
    reason: string
  ): void {
    for (const { thread } of items) {
      repo.setThreadNotifyEval(this.db, thread.id, thread.last_message_at!)
      if (!important.includes(thread.id)) important.push(thread.id)
    }
    logLine('warn', 'comms', `whatsapp triage unavailable (${reason}) — notifying ${items.length} unfiltered`)
  }

  /** One-shot, tool-less model call; the reply is the raw classification text. */
  private async classify(prompt: string, bin: string, kind: 'email' | 'message'): Promise<string> {
    const q = query({
      prompt,
      options: {
        permissionMode: 'default',
        settingSources: [],
        strictMcpConfig: true,
        systemPrompt: `You are ${kind === 'email' ? 'an email' : 'a chat-message'} triage classifier. You output only the requested JSON object, nothing else.`,
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
