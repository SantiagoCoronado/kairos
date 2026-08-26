// getDisplayMedia resolution for meeting capture. The renderer only wants
// system audio, but Chromium refuses video:false on getDisplayMedia, so every
// request carries a throwaway video track (meeting-store stops it on
// arrival). Source that track from the requesting frame itself — tab
// capture — rather than the primary screen: desktopCapturer.getSources
// rejects with "Failed to get sources." whenever the Screen Recording grant
// is missing (every ad-hoc rebuild resets it), and a rejection in the old
// async handler skipped the callback entirely, so getDisplayMedia hung
// forever while the already-open mic rig kept streaming — the
// "only my side got recorded" bug (2026-08-25). Electron also refuses a
// video request answered without a video source (AbortError: Invalid
// capture constraints), so audio-only isn't an escape hatch. Pure and
// synchronous so the mapping is testable and the callback can never be
// skipped — ipc.ts binds it to session.setDisplayMediaRequestHandler.

export interface DisplayMediaRequestLike<Frame> {
  /** null once the requesting frame navigated or was destroyed */
  frame: Frame | null
  videoRequested: boolean
  audioRequested: boolean
}

export interface DisplayMediaResponse<Frame> {
  video?: Frame
  audio?: 'loopback'
}

export function resolveDisplayMedia<Frame>(
  request: DisplayMediaRequestLike<Frame>
): DisplayMediaResponse<Frame> {
  const audio = request.audioRequested ? { audio: 'loopback' as const } : {}
  if (!request.videoRequested) return audio
  // nothing can satisfy the mandatory video track — deny cleanly (the
  // renderer sees a prompt rejection, not a hang)
  if (!request.frame) return {}
  return { video: request.frame, ...audio }
}

export interface DisplayMediaHandlerDeps {
  /** null off macOS — the grant only exists there */
  screenPermission(): string | null
  log(message: string): void
}

/** the bound handler shape: synchronous, and the callback runs on every
 *  path — the exact property whose absence caused the bug */
export function makeDisplayMediaHandler<Frame>(
  deps: DisplayMediaHandlerDeps
): (
  request: DisplayMediaRequestLike<Frame>,
  callback: (streams: DisplayMediaResponse<Frame>) => void
) => void {
  return (request, callback) => {
    // SCK loopback needs the Screen Recording grant — surface its state
    // next to any "system audio missing" report
    const status = deps.screenPermission()
    if (status !== null) deps.log(`display-media request (screen permission: ${status})`)
    callback(resolveDisplayMedia(request))
  }
}
