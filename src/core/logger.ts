// Injectable logger. Core code must NEVER write to stdout directly:
// the MCP server speaks its protocol over stdout, and one stray
// console.log corrupts the stream. Electron injects a console logger;
// the MCP entry injects a stderr logger.

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {}
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[core] ${m}`),
  warn: (m) => console.warn(`[core] ${m}`),
  error: (m) => console.error(`[core] ${m}`)
}

export const stderrLogger: Logger = {
  info: (m) => process.stderr.write(`[info] ${m}\n`),
  warn: (m) => process.stderr.write(`[warn] ${m}\n`),
  error: (m) => process.stderr.write(`[error] ${m}\n`)
}
