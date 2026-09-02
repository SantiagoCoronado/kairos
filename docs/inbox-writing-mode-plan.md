# Inbox writing mode — plan

Writing a long email in the Inbox is cramped: the reply box is a fixed two-row
textarea, the new-email body is a fixed ten-row textarea, and the thread list,
account rail and app sidebar take width the message pane needs. The fix is a
**writing mode** that folds the columns away while keeping the thread you are
replying to on screen, plus composers that grow with what you type. On top of
that, starting a new email is only possible today when a single Gmail account
is selected in the rail — from "All inboxes" there is no Compose button at all.

Decisions made 2026-09-02:

- **Keep the thread visible.** Writing mode reclaims *width* (list, rail,
  sidebar), never the thread above the composer. A full-pane composer that hides
  the message being answered was rejected.
- **Manual trigger first.** Writing mode is entered from a button in the
  composer row and a shortcut; it is not entered on focus. Auto-entry once the
  body passes a couple of lines is a later experiment, not a v1 behaviour.
- **Applies to both composers.** The reply composer at the bottom of a thread
  and the new-email pane share the mode and the toggle.
- **Motion follows transitions.dev.** Fold and composer growth use the
  "card resize" and "plus → menu morph" recipes with their tokens, guarded by
  `prefers-reduced-motion`. Cross-column morphs (Compose button → pane) are out
  of scope for v1.

Each phase is its own branch off fresh main and its own PR, merged before the
next starts.

---

## Phase 1 — Compose anywhere

Branch `feat/inbox-compose-anywhere`.

Today `Compose` and the `c` shortcut only exist when `selectedAccount` is a
Gmail account. On "All inboxes", "All email", or a Slack/WhatsApp account there
is no way to start an email.

- **Compose is available whenever any Gmail account is connected**, regardless
  of what the rail has selected. Same for the `c` shortcut.
- **From picker.** The new-email pane's header line becomes a `From` select
  listing the connected Gmail accounts when there is more than one; with a
  single account it stays the static `new email · <name>` line.
- **Default From** (`src/renderer/src/lib/compose-from.ts`, unit-tested):
  1. the account selected in the rail, if it is Gmail;
  2. else the account of the open thread, if it is Gmail;
  3. else the first Gmail account.
- **Undo restore keeps the From.** `ComposeDraft` gains `accountId` so an
  undone send reopens the pane on the same account.
- Send goes through the existing `comms:send` with the chosen account id.

Out of scope: mobile compose (compose stays a desktop mode), CC/BCC.

## Phase 2 — Composers that grow

Branch `feat/inbox-composer-autogrow`.

- **Reply textarea auto-grows** from two rows to a cap of roughly 45% of the
  thread pane height, then scrolls internally. Height is set explicitly in
  pixels from `scrollHeight` (this is also what makes the phase-4 height tween
  possible).
- **New-email body fills the pane**: the ten fixed rows become `flex-1` inside
  a full-height column; the `max-w-2xl` cap on the pane is widened so a long
  email gets the width the pane has.
- **⌘↩ sends in both composers** (today only the reply box has it).
- The thread pane keeps the latest message in view as the composer grows, using
  the existing scroll-anchoring in `thread-scroll.ts`.

## Phase 3 — Writing mode

Branch `feat/inbox-writing-mode`.

- **Toggle** in the composer row (icon next to the AI button) and a shortcut,
  `⌘⇧E`. `⌘B` remains the plain sidebar toggle.
- **Enter** folds the thread list and the account rail to zero width and hides
  the app sidebar. The pane header shows a back chevron (as the mobile layout
  does) so another thread can still be opened without leaving the mode. The
  composer takes the taller cap from phase 2.
- **Remembered state.** Entering records which of the three columns were open;
  exit restores exactly that, so a sidebar the user had hidden with `⌘B` stays
  hidden.
- **Exit** on send, on the toggle, or on `Escape` when the body is empty.
  Switching views (`⌘1–⌘9`) exits too.
- **Both composers.** The new-email pane uses the same toggle and shortcut.
- **Persistence.** `kairos.inbox.writingMode` remembers the choice for the
  session so reopening a thread lands in the same mode; a fresh launch starts
  unfolded.
- The sidebar-hidden state today lives in `App.tsx`; Inbox needs a way to ask
  for it (a small context or a prop pair), which is the one cross-view change.

## Phase 4 — Motion

Branch `feat/inbox-writing-motion`.

- **Tokens.** Add the transitions.dev `:root` block (durations, eases,
  distances, scales, blur) to `styles.css` so motion has names.
- **Fold** (card resize): list, rail and sidebar tween `width` to zero over
  `--resize-dur` with `--ease-smooth-out`; contents fade + blur out on the X
  axis so text is never crushed mid-tween. The sidebar must stay mounted at
  width zero for the duration rather than unmounting.
- **Composer morph** (plus → menu morph): the textarea box grows into the
  writing surface with the bouncy open ease (`350ms`, `cubic-bezier(0.34, 1.25,
  0.64, 1)`) and its radius relaxes 6px → 12px; close runs `250ms` with the
  smooth-out ease.
- **Toolbar cross-fade**: the mic / AI / send row slides into its writing-mode
  position with the recipe's fade + 0.97 scale + 2px blur.
- **Reduced motion**: every transition is zeroed under
  `prefers-reduced-motion: reduce`.

## Phase 5 — Follow-ups (not scheduled)

- Auto-enter writing mode once the body passes ~2 lines; exit on send only.
- View Transitions API morph from the Compose button into the new-email pane.
- Run `transitions refine` over the app's existing `160ms` / `220ms` motion so
  it reads as one system with the new tokens.
- Mobile compose.
