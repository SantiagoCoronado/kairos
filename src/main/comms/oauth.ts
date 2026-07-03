// Loopback OAuth for installed apps: spin up a localhost HTTP listener, open
// the provider's consent page in the default browser, capture the redirect.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'

export interface LoopbackFlowOptions {
  /** given the redirect URI + params, return the full consent-page URL */
  buildAuthUrl: (p: { redirectUri: string; state: string; codeChallenge?: string }) => string
  /** some providers (Slack) require an exactly-registered redirect URL */
  fixedPort?: number
  /** Google supports PKCE; Slack does not */
  usePkce?: boolean
  timeoutMs?: number
}

export interface LoopbackFlowResult {
  code: string
  redirectUri: string
  codeVerifier?: string
}

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Kairos</title>
<body style="font-family:system-ui;background:#111;color:#ddd;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>Connected to Kairos</h2><p>You can close this tab and return to the app.</p></div>`

export function runLoopbackFlow(opts: LoopbackFlowOptions): Promise<LoopbackFlowResult> {
  const state = b64url(randomBytes(24))
  const codeVerifier = opts.usePkce ? b64url(randomBytes(48)) : undefined
  const codeChallenge = codeVerifier
    ? b64url(createHash('sha256').update(codeVerifier).digest())
    : undefined

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, result?: LoopbackFlowResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve(result!)
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.endsWith('/callback')) {
        res.writeHead(404).end()
        return
      }
      const err = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const gotState = url.searchParams.get('state')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE)
      if (err) return finish(new Error(`authorization refused: ${err}`))
      if (gotState !== state) return finish(new Error('OAuth state mismatch'))
      if (!code) return finish(new Error('no authorization code in callback'))
      finish(null, { code, redirectUri, codeVerifier })
    })

    server.on('error', (err) =>
      finish(
        new Error(
          opts.fixedPort
            ? `could not listen on port ${opts.fixedPort} (already in use?): ${err.message}`
            : `loopback listener failed: ${err.message}`
        )
      )
    )

    const timer = setTimeout(
      () => finish(new Error('sign-in timed out — no browser callback within 5 minutes')),
      opts.timeoutMs ?? 5 * 60 * 1000
    )

    let redirectUri = ''
    server.listen(opts.fixedPort ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      // Slack requires the registered "localhost" spelling; Google accepts any loopback form.
      const host = opts.fixedPort ? 'localhost' : '127.0.0.1'
      redirectUri = `http://${host}:${port}/callback`
      void shell.openExternal(opts.buildAuthUrl({ redirectUri, state, codeChallenge }))
    })
  })
}
