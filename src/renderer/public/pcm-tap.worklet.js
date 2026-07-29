// PCM tap for meeting capture: forwards each 128-frame input block to the
// main thread (meeting-store batches ~1s before shipping over IPC). Served
// as a static asset — the renderer CSP blocks blob:-URL worklet modules.
registerProcessor(
  'kairos-pcm-tap',
  class extends AudioWorkletProcessor {
    process(inputs) {
      const ch = inputs[0]?.[0]
      if (ch && ch.length) this.port.postMessage(ch.slice(0))
      return true
    }
  }
)
