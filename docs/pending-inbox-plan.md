# Pending Inbox — plan

A unified triage queue of everything Kairos knows needs Santiago's attention. New
top-level **Pending** view (sidebar + badge + shortcut), backed by live-computed
items plus a small persisted overlay for snooze/dismiss/seen state.

Decisions made 2026-08-06:

- **Architecture: hybrid.** Items are computed live from each source domain
  (never stale, no sync jobs). A single new `pending_overlay` table stores
  per-item snooze/dismiss/seen state keyed by a stable item key.
- **Sources in scope:** overdue/due-today tasks, followups due, note reminders
  due, unread/action-needed comms threads, failed/queued outbox sends, errored
  meetings, unseen finished agent runs, calendar invites needing RSVP.
- **Surface:** new `Pending` view. Today stays the calm daily briefing.
- **No notification history.** The inbox shows current pending state only;
  resolved items disappear. Existing notification call sites keep firing as today.

Each phase is its own branch off fresh main and its own PR, merged before the
next starts.

---

## Data model

### `PendingItem` (computed, `src/core/types.ts`)

```ts
interface PendingItem {
  key: string          // stable identity, e.g. 'task:<id>', 'thread:<id>', 'outbox:<id>'
  kind: 'task' | 'followup' | 'reminder' | 'thread' | 'outbox' | 'meeting' | 'agent_run' | 'invite'
  title: string
  subtitle?: string    // metadata line (who/when/why)
  tone: 'accent' | 'danger' | 'muted'   // danger = failure states
  at: string | null    // the timestamp that makes it pending (due date, failed_at, finished_at)
  fingerprint: string  // changes when the underlying condition renews (see dismissal semantics)
  nav: { view: NavView; id?: string }   // deep link target
}
```

### `pending_overlay` (migration 023, `src/core/migrations.ts`)

```sql
CREATE TABLE pending_overlay (
  item_key      TEXT PRIMARY KEY,
  fingerprint   TEXT NOT NULL,
  snoozed_until TEXT,        -- ISO; hide until then
  dismissed_at  TEXT,        -- hide while fingerprint matches
  seen_at       TEXT,        -- for badge math, not hiding
  updated_at    TEXT NOT NULL
)
```

**Semantics — the load-bearing rules:**

- **Snooze and dismiss are inbox-local.** They never mutate the source domain.
  A snoozed task keeps its due date; the row just hides from Pending. Domain
  actions (complete task, retry send, snooze followup via `people.snoozed_until`)
  are offered as row actions and remain the "real" resolution path.
- **Dismissal is fingerprint-scoped, not permanent.** A dismissed item stays
  hidden while its fingerprint is unchanged; if the condition renews (thread
  gets a new inbound message, task due date pushed and missed again), the
  fingerprint differs and the item resurfaces. Fingerprints per kind:
  - task → `${status}:${due_date}` · followup → last interaction date
  - reminder → `remind_at` · thread → latest inbound message id
  - outbox → `${status}:${attempts}` · meeting → `status`
  - agent_run → run id (immutable → dismiss is effectively permanent, correct for runs)
  - invite → event `updated` timestamp
- **Garbage collection:** overlay rows whose item no longer appears in the
  computed set and whose snooze has lapsed are deleted by the triage write
  paths (phase 2) — reads stay pure, since the badge, the view, and the MCP
  tool all share the read path.
- **Delivery is not resolution.** A note reminder whose OS notification
  already fired (`reminder_fired_at` set) is still pending — the scheduler's
  watermark silences the notification, not the triage item. Pending queries
  due reminders regardless of the fired flag; `notes:dueCount` keeps the
  scheduler's predicate (they answer different questions).
- **Follow-up dismissals are stronger than the other kinds** (documented,
  intentional): the fingerprint is the last interaction, and nothing can renew
  it while the person is still due — so dismissing means "quiet until we
  actually talk". Tasks/threads/reminders all have renewal signals that expire
  a dismissal; follow-ups resolve the domain way (log an interaction).

### Aggregator (`src/core/repo/pending.ts`)

Pure function `pendingItems(db, now = new Date()): { items: PendingItem[]; counts: … }`,
following `today.ts` shape. Composes existing repo functions, applies overlay
filtering, sorts danger-tone first, then by `at`. Fully unit-testable with the
in-memory driver + injected `now` (house pattern).

---

## Phase 1 — Foundation: aggregator + view, core four sources (read-only)

Branch `feat/pending-inbox-core`. No triage actions yet; items deep-link to
their home views where existing actions live.

### Stories

**1.1 — Migration + item model.** Migration 023 (`pending_overlay`), `PendingItem`
type, new `DbEntity` member `'pending'`.

**1.2 — Aggregator with core four sources.** `src/core/repo/pending.ts`:
- Tasks: overdue + due today (reuse `today.ts` queries).
- Followups: `followupsDue()` (already respects `people.snoozed_until`).
- Note reminders: due (`remind_at <= now`), unarchived, regardless of the
  scheduler's fired watermark (see "delivery is not resolution" above).
- Comms: unread, non-archived, `sync_enabled` threads. Threads labeled
  `action-needed` get elevated placement; since `autoLabel` defaults off,
  plain unread is the baseline signal. Cap at ~15 with an "open Inbox" tail row
  so Pending doesn't become a second mail client.
- Overlay filtering per the semantics above (table exists; writes and GC come
  in Phase 2). For threads the overlay predicate lives in SQL (one copy,
  shared by fetch and count): the display LIMIT applies to *visible* rows, so
  large mailboxes never fully materialize and the list can never be empty
  while the count is non-zero.
- Co-located `pending.test.ts`: every source, ordering, cap, fingerprint values.

**1.3 — IPC + MCP surface.** A single `pending:list` channel in
`ipc-contract.ts` + `ipc.ts` (registered via `handle()` so remote/mobile gets
it free); the sidebar badge derives from `.total` of the same payload so badge
and view can never disagree. MCP tool `pending_inbox` appended to
`tooldefs.ts` (read-only, sync handler, calls the repo directly) — this is
what lets Claude answer "what's pending?".

**1.4 — Pending view + navigation.** `views/Pending.tsx` modeled on Today's
section-card layout (`Section` / `Chip` / right-aligned mono actions,
`text-[13px]` body conventions). Pending sits second in the sidebar but is
*appended* to `VIEW_ORDER` — the existing ⌘2–⌘9 muscle memory keeps its
slots, and Pending has no ⌘ shortcut (sidebar/palette reach it). Touch
points: `Sidebar.tsx` (`ViewId`, `NAV`, badge from `pending:list.total`,
`VIEW_ORDER` now lives here), `App.tsx` (render),
`CommandPalette.tsx`, `NavView` union in `ipc-contract.ts`. **Not** in
`MobileTabBar` (5 tabs is the fit limit) — mobile reachability deferred to
Phase 5 decision. Rows navigate via the same mechanism as `nav:goto`.
Empty state: `EmptyState` ("Nothing needs you"). Badge style matches existing
(`bg-accent/20`; danger variant arrives with failure sources in Phase 3).

**Acceptance:** view shows live items from all four sources; badge counts
non-snoozed/non-dismissed items; MCP `pending_inbox` returns the same list;
`npm test` + `npm run typecheck` green.

---

## Phase 2 — Triage: snooze, dismiss, seen

Branch `feat/pending-inbox-triage`.

### Stories

**2.1 — Overlay writes.** `pending:snooze {key, until}`, `pending:dismiss {key}`,
`pending:setViewActive` (stamps `seen_at` for visible items — the badge then
counts only unseen, same idea as `agentTasks:setViewActive`). All broadcast
`db:changed {entity:'pending'}`. The write paths also own overlay garbage
collection (rows whose item resolved and snooze lapsed). Repo functions with
tests covering fingerprint-resurfacing (dismiss → renew condition → item
returns).

**2.2 — Row actions in the view.** Hover/swipe actions per row: Snooze
(popover with 1h / this evening / tomorrow / next week — **`bg-overlay`**, the
opacity guard test will catch `bg-panel`), Dismiss, plus one domain-native
quick action per kind (task → complete via `tasks:update`; followup → domain
snooze via existing `followups:snooze`; reminder → mark fired; thread → open
in Inbox). Dismiss/snooze route through `lib/undo.ts` (6s window, ⌘Z — its doc
comment already anticipates inbox actions).

**2.3 — MCP triage tools.** `pending_snooze` and `pending_dismiss` in
`tooldefs.ts` with `ctx.onMutate('pending')` — so "snooze that for tomorrow"
works from chat. Note MCP-twin writes reach the UI via the existing 4s
`data_version` poll; acceptable latency, no new plumbing.

**Acceptance:** snoozed items vanish and return on schedule; dismissed items
stay gone until the condition renews; ⌘Z restores; badge = unseen actionable
count.

---

## Phase 3 — Failure states: outbox, meetings, agent runs

Branch `feat/pending-inbox-failures`. The highest-value phase: failed outbox
sends are currently **invisible after a reload** (only recoverable from a
still-open composer).

### Stories

**3.1 — Outbox items.** New repo accessor `listOutboxPending()` (`failed` +
stuck `queued`/`sending` rows past a 10-minute grace) — none existed. Failed
rows are danger-tone with the error as subtitle; destination falls back
thread title → to_json → provider. Row actions: Retry — `comms:retryOutbox`
already re-drives purely from the DB row, but it is only offered for
WhatsApp, mirroring the composer's gate (per-unit delivery tracking makes it
duplicate-safe there; a gmail ambiguous accept would re-send) — and Discard
(`comms:discardOutbox`, hard delete via commit-style undo; sent rows refuse).
This closes a real data-loss hole independent of the inbox feature.

**3.2 — Meeting errors.** `meetings` with `status='error'` (danger tone) and
`ready` with `summarized_at NULL` past a 15-minute grace (muted tone — a
summarize failure leaves no other trace than this predicate) → deep-link
focuses the meeting's day in Calendar; unsummarized rows get an inline
`summarize` action (`meetings:summarize`).

**3.3 — Agent runs needing review.** Finished runs surface as items for a
48-hour review window (then age out — they never accumulate), error runs
danger, results accent, stopped muted. The unseen watermark is the overlay
(`seen_at` per run key); the `automationsSeenAt` settings cursor is retired
and `agentTasks:activity` computes `unseenFinished` from the same overlay, so
the two badges can't disagree. Both views' `setViewActive` stamp scoped seen
(`markAllSeen(db, now, 'agent_run')` for Automations — it must not touch
other kinds' watermarks) and cross-notify the other badge only when something
was actually stamped, so the broadcasts terminate. The Automations flag gets
the same 90s TTL self-heal as Pending's. (Terminal's in-memory "unseen" stays
as-is — ephemeral by nature.)

**3.4 — Danger badge.** Sidebar badge switches to the `bg-danger/20` variant
when any danger-tone item is pending, matching the terminal badge precedent.

**Acceptance:** kill the app mid-send → relaunch → failed send appears in
Pending and Retry delivers it (verify-skill E2E); automations badge and
Pending agree on unseen runs.

---

## Phase 4 — Calendar invites + RSVP

Branch `feat/pending-inbox-rsvp`. Greenfield: nothing detected
"needs my response" before this, and RSVP was read-only everywhere.

### Stories

**4.1 — Detection.** The self-attendee is found by Google's `self` flag
first, account-email match as fallback — the same `selfAttendee()` rule the
write path uses, so detect and respond can never disagree about who "we"
are. Surface events where self is `needsAction` and `end_at > now` (an
invite for a meeting in progress is still answerable; all-day date-only
strings compare correctly against ISO now, same trick as the range query).
A recurring series collapses to its earliest upcoming instance — one
question, not N expanded rows; when that occurrence passes the key rolls
forward and any dismissal expires with it, the repeating-reminder
renewed-nag semantics. Fingerprint = `etag`, not Google's `updated` (never
stored locally); etag changes on every remote modification, so a dismissal
survives exactly until the invite changes. Deep-link focuses the event's day
in Calendar.

**4.2 — RSVP actions.** `calendar:respond {eventId, response}` →
`CalendarSyncManager.respond()`: a direct get-then-patch (NOT the dirty-row
drain, which pushes full event bodies) — fetch the fresh remote copy, swap
only our `responseStatus` via `applyRsvp()` (a patch replaces the whole
attendees array, so everyone else is carried through current), patch with
the fresh etag and `sendUpdates` so the organizer is notified. A recurring
instance patches the **parent** event — answering the whole series, like
Google's own UI — then `applySelfResponseToSeries()` reflects it onto local
instances without dirtying them (etags cleared; next pull reconciles).
accept / maybe / decline on the pending row (no undo — outward-facing; the
answer is changeable any time), Accept / Maybe / Decline in `EventEditor`
(not gated by the recurring read-only banner). MCP `calendar_respond` runs
through a new optional `ToolCtx.respondInvite` hook wired only by Electron
main — in-app chat gets full RSVP; the stdio twin says plainly that it needs
the app (it has no Google session). Side fix: both tool-server wrappers now
`await` handlers, which async tool handlers needed.

**4.3 — InviteCard upgrade (stretch, cuttable).** Not built this phase.
Email `.ics` invite cards in comms would gain RSVP buttons reusing 4.2's
plumbing.

**Acceptance:** an unanswered Google Calendar invite appears in Pending;
accepting from the row updates Google and the item clears on next sync.

---

## Phase 5 — Polish + mobile decision

Branch `feat/pending-inbox-polish`.

- Mobile: **decided desktop-only for now** (Santiago, Aug 7 2026). The tab
  bar sits at 5 tabs (6 with Terminal) and remote IPC already serves the
  channels, so placement can be revisited any time without plumbing work.
- Notification deep links: the automation-finished notification lands on
  `pending` carrying the run's item key — the view scrolls to and pulses
  that row, so the link stays deep even though runs are the 7th section
  and errors sort above fresh successes. Reminder/comms/meeting
  notifications keep their specific targets; an item-focused landing beats
  the queue when the notification names one item. DECISION: landing on
  Pending stamps the whole visible queue seen, same as any other arrival —
  "visible = seen" is one rule, not two classes of viewing; danger keeps
  the badge lit and nothing is delisted.
- Briefing: speaks only what the agenda lines can't already say — a
  failure alarm ("Heads up: N failures need your attention") FIRST, before
  the calendar, and an invitations line after follow-ups. Silent at zero;
  either suppresses the "clear runway" stoic close. A raw pending total
  was rejected as double-counting the due/follow-up lines. No "check
  Pending" pointer in the alarm: the briefing plays on the phone, where
  Pending deliberately isn't. DECISION: an undismissed errored run repeats
  the alarm on consecutive mornings (runs sit in the 48h window) — dismiss
  IS the acknowledgement gesture; an alarm that self-silences unheard
  would be worse.
- Overlay GC hardening: `gcPendingOverlay()` boot sweep — the write-path GC
  only runs when the user triages, so rows for items that resolved during a
  quiet stretch would otherwise linger indefinitely.
- Verify-skill E2E over the whole flow: all 8 sections seeded and rendered,
  badge unseen→danger transition, overnight due-today→overdue fingerprint
  renewal, error-above-cap run ordering, snooze + undo, boot GC sweep.

---

## Risks / open questions

- **Double-badging:** comms unread counts appear in both the Inbox badge and
  Pending. Accepted for v1; revisit if it feels noisy (option: Pending counts
  only `action-needed` threads toward its badge).
- **Item-key stability** is the whole ballgame for the overlay. Keys use
  domain ids (task id, thread id, run id, event id) — all stable across sync.
- **Comms volume:** the unread-thread source is capped; Pending must never
  become a worse Inbox.
- **`autoLabel` off by default** means action-needed elevation is mostly
  dormant; the feature may motivate flipping that default later, separately.
