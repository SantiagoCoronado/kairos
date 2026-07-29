// Pure PCM/WAV helpers for meeting capture. The renderer's AudioWorklet tap
// produces Float32 frames; they cross IPC as 16-bit PCM and land in a WAV
// whose header is written as a placeholder at record start and patched with
// real sizes at stop (no rewrite of hour-long files).

export const WAV_HEADER_BYTES = 44

/** clamp to ±1 and quantize to little-endian int16 */
export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
  }
  return out
}

/** 44-byte PCM WAV header for `dataBytes` of sample data */
export function wavHeader(
  dataBytes: number,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16
): Uint8Array {
  const bytesPerSample = bitsPerSample / 8
  const buf = new ArrayBuffer(WAV_HEADER_BYTES)
  const view = new DataView(buf)
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt subchunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true) // byte rate
  view.setUint16(32, channels * bytesPerSample, true) // block align
  view.setUint16(34, bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return new Uint8Array(buf)
}
