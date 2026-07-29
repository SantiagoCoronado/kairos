// getDisplayMedia resolution for meeting capture (Notion's shape): an
// audio-only request gets pure system-audio loopback; a video request gets
// the primary screen plus loopback. Pure so the mapping is testable —
// ipc.ts binds it to session.setDisplayMediaRequestHandler.

export interface DisplayMediaRequestLike {
  videoRequested: boolean
  audioRequested: boolean
}

export interface DisplayMediaResponse<Source> {
  video?: Source
  audio?: 'loopback'
}

export async function resolveDisplayMedia<Source>(
  request: DisplayMediaRequestLike,
  getScreenSources: () => Promise<Source[]>
): Promise<DisplayMediaResponse<Source>> {
  if (!request.videoRequested) return { audio: 'loopback' }
  const sources = await getScreenSources()
  if (!sources[0]) return {}
  return { video: sources[0], ...(request.audioRequested ? { audio: 'loopback' as const } : {}) }
}
