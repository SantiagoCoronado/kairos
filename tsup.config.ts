import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/mcp/index.ts' },
  outDir: 'dist-mcp',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // single self-contained file: `node dist-mcp/index.mjs` must work with no
  // node_modules next to it. Inline the real deps; node: builtins stay external.
  noExternal: ['zod', '@modelcontextprotocol/sdk', 'ulid'],
  external: ['node:sqlite'],
  clean: true
})
