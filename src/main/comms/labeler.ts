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
// watermark, not labels), separate daily budget, fail-open on model outage.
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
 *  labeling (or vice versa), and each batch is a tiny haiku call anyway */
const MAX_TRIAGE_BATCHES_PER_DAY = 20
/** triage context: the last few inbound messages of a thread */
const TRIAGE_CONTEXT_MESSAGES = 3

export class CommsLabeler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private lastRunAt = 0
  private stopped = false
  private budgetDay = ''
  private batchesToday = 0
  private triageBatchesToday = 0

  constructor(
    private db: DbDriver,
    private onChanged: () => void,
    /** fired with the thread ids classified in a sweep (notification hook) */
    private onLabeled?: (threadIds: string[]) => void,
    /** fired with whatsapp thread ids the triage deemed notification-worthy */
    private onImportant?: (threadIds: string[]) => void
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
      this.triageBatchesToday = 0
    }
  }

  private modelBudgetLeft(): boolean {
    this.rollBudgetDay()
    return this.batchesToday < MAX_MODEL_BATCHES_PER_DAY
  }

  private triageBudgetLeft(): boolean {
    this.rollBudgetDay()
    return this.triageBatchesToday < MAX_TRIAGE_BATCHES_PER_DAY
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

    // pass 2: haiku verdict. Fail-OPEN when the model is unavailable (no
    // binary / budget gone / call fails, e.g. expired Claude login): the
    // complaint behind this feature is noise, but silently dropping a
    // genuinely urgent message would be worse — degrade to the old
    // notify-everything behavior instead.
    let modeled = 0
    const bin = resolveClaudeBinary()
    if (needModel.length > 0) {
      let failOpen: string | null = bin ? (this.triageBudgetLeft() ? null : 'budget') : 'no claude binary'
      if (!failOpen) {
        this.triageBatchesToday++
        const candidates: MessageTriageCandidate[] = needModel.map(({ thread, messages }) => ({
          id: thread.id,
          sender: thread.sender,
          messages
        }))
        try {
          const text = await this.classify(buildMessageTriagePrompt(candidates), bin!, 'message')
          const verdicts = parseTriageResponse(text, candidates)
          for (const { thread } of needModel) {
            const v = verdicts.get(thread.id)
            if (!v) continue // skipped by the model: retry next sweep while fresh
            repo.setThreadNotifyEval(this.db, thread.id, thread.last_message_at!)
            if (v === 'important') important.push(thread.id)
            modeled++
          }
        } catch (err) {
          failOpen = err instanceof Error ? err.message : String(err)
        }
      }
      if (failOpen) {
        for (const { thread } of needModel) {
          repo.setThreadNotifyEval(this.db, thread.id, thread.last_message_at!)
          if (!important.includes(thread.id)) important.push(thread.id)
        }
        logLine('warn', 'comms', `whatsapp triage unavailable (${failOpen}) — notifying ${needModel.length} unfiltered`)
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
