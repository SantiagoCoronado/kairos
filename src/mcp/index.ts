// Standalone stdio MCP server for terminal agents (Claude Code, Codex, …).
// Runs on plain Node >=22.5 (node:sqlite — no native rebuilds), sharing the
// same WAL database the app has open. stdout carries ONLY protocol frames;
// all logging goes to stderr.
//
// Register (or just `npm run mcp:install` for Claude Code):
//   claude mcp add --scope user kairos -- node <repo>/dist-mcp/index.mjs
//   codex mcp add kairos -- node <repo>/dist-mcp/index.mjs

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openNodeSqliteDb } from '../core/drivers/node-sqlite'
import { migrate } from '../core/migrations'
import { stderrLogger } from '../core/logger'
import { buildToolDefs } from '../core/tooldefs'

const dataDir = process.env['KAIROS_DIR'] ?? join(homedir(), 'Kairos')
mkdirSync(dataDir, { recursive: true })

const db = openNodeSqliteDb(join(dataDir, 'data.db'))
migrate(db, stderrLogger)

const server = new McpServer({ name: 'kairos', version: '0.1.0' })

for (const tool of buildToolDefs(db, { dataDir, onMutate: () => {} })) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      try {
        const result = tool.handler(args)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }] }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }]
        }
      }
    }
  )
}

await server.connect(new StdioServerTransport())
stderrLogger.info(`kairos MCP server ready (db: ${join(dataDir, 'data.db')})`)
