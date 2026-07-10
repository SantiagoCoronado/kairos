---
name: verify
description: Run an isolated Kairos instance with seeded data and drive it over CDP to verify UI/main-process changes while the production app keeps running.
---

# Verifying Kairos changes

The user's production Kairos.app is usually running with live accounts (a
real WhatsApp/Baileys session — never let a second instance touch its auth
state). Verify against an isolated instance instead:

## 1. Build + launch isolated

```bash
npx electron-vite build
```

Electron's `userData` on macOS ignores `$HOME`, so the single-instance lock
collides with the installed app unless you re-point userData in a wrapper
main before the lock is requested:

```js
// test-main.js
const { app } = require('electron')
const path = require('path')
app.setPath('userData', path.join(process.env.KAIROS_TEST_BASE, 'userData'))
require('/abs/path/to/kairos-app/out/main/index.js')
```

```bash
HOME=$SCRATCH/vhome KAIROS_TEST_BASE=$SCRATCH/vhome \
  npx electron $SCRATCH/test-main.js --remote-debugging-port=9223
```

`DATA_DIR` (src/main/db.ts) is `join(homedir(), 'Kairos')` and Node's
`homedir()` respects `$HOME`, so the DB lands in `$SCRATCH/vhome/Kairos/data.db`.

The contacts/calendar helpers resolve via `app.getAppPath()` = the dir of
test-main.js, so `contacts:search` returns `helper-missing` unless you
`ln -sfn /abs/path/kairos-app/resources $SCRATCH/resources`. Also launch
the app OUTSIDE the sandbox (TCC-gated helpers fail inside it).

## 2. Seed

The DB is created on first boot (migrations run automatically). Seed with the
`sqlite3` CLI afterwards, then reload the window. Key tables:
`comms_accounts` (status `needs_auth` keeps the sync manager inert — no
network attempts), `comms_threads`, `comms_messages`, `people`. Timestamps
are ISO strings. Thread list orders by `last_message_at DESC` and hides
threads with NULL `last_message_at`.

## 3. Drive over CDP

`npm i playwright-core` in a scratch dir (no browser download needed):

```js
const browser = await chromium.connectOverCDP('http://localhost:9223')
// two pages exist: capture.html (hidden quick-capture) and index.html (main)
const page = pages.find((p) => p.url().includes('index.html'))
```

Gotchas that will burn you:
- **Real key presses get eaten** (Electron menu accelerators / focus). Use
  in-page dispatch: `page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true })))`.
  Cmd+1..N maps to `VIEW_ORDER` in App.tsx (2 = inbox).
- **The frameless-window drag strip** (`.drag-region`, top 24px) swallows
  synthetic pointer clicks even with `force: true` — anything near the top
  (sidebar header, first rail row) needs a programmatic DOM `.click()` via
  `page.evaluate`.
- `page.setViewportSize` works for shrinking the content to force scroll
  states.
- To test `browser-window-focus` behavior, focus must *transition*: blur via
  `osascript -e 'tell application "Finder" to activate'`, then focus the
  `Electron` process via System Events.

## 4. Cleanup

`pkill -f test-main.js`. The scratch vhome is disposable.
