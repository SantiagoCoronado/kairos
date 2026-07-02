// Standalone stdio MCP server for terminal Claude Code.
// Runs on plain Node >=22.5 (node:sqlite — no native rebuilds), sharing the
// same WAL database the app has open. stdout carries ONLY protocol frames;
// all logging goes to stderr.
//
// Register: claude mcp add --scope user command-center -- node <repo>/dist-mcp/index.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openNodeSqliteDb } from '../core/drivers/node-sqlite'
import { migrate } from '../core/migrations'
import { stderrLogger } from '../core/logger'
import { buildToolDefs } from '../core/tooldefs'

const dataDir = process.env['COMMAND_CENTER_DIR'] ?? join(homedir(), 'CommandCenter')
mkdirSync(dataDir, { recursive: true })

const db = openNodeSqliteDb(join(dataDir, 'data.db'))
migrate(db, stderrLogger)

const server = new McpServer({ name: 'command-center', version: '0.1.0' })

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
stderrLogger.info(`command-center MCP server ready (db: ${join(dataDir, 'data.db')})`)
