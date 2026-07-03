import { join } from 'node:path'
import { homedir } from 'node:os'

// Leaf module (no electron/db imports) so pty + SDK code and unit tests
// can all share it.

/** Child env for spawned processes: subscription auth (never API-key billing), Finder-safe PATH. */
export function buildChildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env['ANTHROPIC_API_KEY']
  // GUI apps launched from Finder don't inherit the shell PATH
  env['PATH'] = [env['PATH'], '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]
    .filter(Boolean)
    .join(':')
  return env
}
