// Filename budget shared by every place that writes a user-named file under
// DATA_DIR (attachment cache, chat uploads). Most filesystems cap a name at
// 255 bytes; a ULID prefix takes 27 of them, and viewers may append a
// `.download`-style suffix, so the user-supplied part gets a fixed budget.
export const FILE_NAME_BUDGET_BYTES = 200

/** Trim a name to `max` UTF-8 bytes, keeping its extension and never
 *  splitting a code point. Reads the extension only when it's short. */
export function capFileNameBytes(name: string, max = FILE_NAME_BUDGET_BYTES): string {
  if (Buffer.byteLength(name) <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
  const stem = ext ? name.slice(0, dot) : name
  const budget = max - Buffer.byteLength(ext)
  let out = ''
  let used = 0
  for (const ch of stem) {
    const n = Buffer.byteLength(ch)
    if (used + n > budget) break
    out += ch
    used += n
  }
  return (out || 'file') + ext
}
