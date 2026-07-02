# Command Center

Local-first macOS command center: personal CRM, task management, and OKR-style
objectives for both personal life and work. Dark, keyboard-driven, one SQLite
file you own. Claude is an optional layer — the app is fully usable without it.

## What's inside

- **Today** — overdue + due-today tasks, follow-ups due, objective progress, today's calendar
- **People** — contacts with follow-up cadences ("ping every 21 days"), interaction log, snooze
- **Tasks** — projects, areas (personal/work), priorities, due dates
- **Objectives** — quarterly OKRs with key results, progress bars, linked tasks
- **⌘K** — command palette: navigate, create tasks/people, jump to a person, export
- **Alt+Space** — global quick capture from anywhere: `ship the deck @work !1 due:fri`, `p Anna had coffee`
- **Export** — one-way Markdown mirror at `~/CommandCenter/export/` (Obsidian/git friendly)

Data lives in `~/CommandCenter/data.db` (SQLite, WAL). Settings in
`~/CommandCenter/settings.json`.

## Claude integration (both optional)

1. **In-app chat** (Chat tab) — a Claude agent with tools over your data
   (log interactions, plan your week, review objectives). Uses your
   `claude login` subscription; never an API key.
2. **From terminal Claude Code** — an MCP server exposing the same 18 tools:

   ```sh
   npm run build:mcp
   claude mcp add --scope user command-center -- node <repo>/dist-mcp/index.mjs
   ```

   Then in any `claude` session: "what follow-ups are due?", "add a task to…".
   The app and the MCP server can be open simultaneously (WAL).

## Development

```sh
npm install           # also rebuilds better-sqlite3 for Electron + patches dev plist
npm run dev           # hot-reloading dev app
npm test              # core test suite (vitest)
npm run typecheck
```

## Release build

```sh
npm run dist          # builds calendar helper + app + .dmg into dist/
```

The app is ad-hoc signed (personal use). First launch of a packaged build asks
for Calendar access; TCC may re-prompt after rebuilds because the ad-hoc
signature changes.

## Architecture notes

- One repo layer (`src/core`) serves three consumers: the Electron main process
  (better-sqlite3, Electron ABI), the standalone MCP server (`node:sqlite`,
  plain Node ≥22.5, zero native rebuilds), and the in-app agent tools.
- `src/shared/ipc-contract.ts` is the single typed source of truth for
  renderer↔main IPC.
- `src/core/tooldefs.ts` defines the 18 Claude tools once for both surfaces.
- The calendar helper is Objective-C (EventKit) compiled with plain clang —
  swiftc is broken on some Command Line Tools installs.
