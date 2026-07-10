// Minimal markdown parser for agent-produced text (automation results, chat).
// Deliberately small — headings, emphasis, inline/fenced code, lists, quotes,
// links, rules, and pipe tables cover what models actually emit. Anything it
// doesn't recognize stays a plain paragraph, so worst case equals the old
// raw-text rendering. Pure data out (no React) so it unit-tests in vitest.

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; children: MdInline[] }
  | { kind: 'italic'; children: MdInline[] }
  | { kind: 'link'; href: string; children: MdInline[] }

export type MdBlock =
  | { kind: 'heading'; level: number; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'quote'; children: MdInline[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: MdInline[][]; rows: MdInline[][][] }

// one alternation, first match wins: `code` | **bold** | *italic* | _italic_ | [text](url)
// bold content may hold nested * emphasis; the (?!\*) after the closer makes
// '**a *b***' close on the LAST star pair instead of stranding one
const INLINE_RE =
  /(`+)([^`]+?)\1|\*\*(.+?)\*\*(?!\*)|\*([^*\n]+?)\*|(?<![\w])_([^_\n]+?)_(?![\w])|\[([^\]]+?)\]\(([^)\s]+?)\)/

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = []
  let rest = text
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest)
    if (!m) {
      out.push({ kind: 'text', text: rest })
      break
    }
    if (m.index > 0) out.push({ kind: 'text', text: rest.slice(0, m.index) })
    if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] })
    else if (m[3] !== undefined) out.push({ kind: 'bold', children: parseInline(m[3]) })
    else if (m[4] !== undefined) out.push({ kind: 'italic', children: parseInline(m[4]) })
    else if (m[5] !== undefined) out.push({ kind: 'italic', children: parseInline(m[5]) })
    else out.push({ kind: 'link', href: m[7], children: parseInline(m[6]) })
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

const UL_RE = /^\s*[-*+]\s+(.*)$/
const OL_RE = /^\s*\d+[.)]\s+(.*)$/
const BLOCK_START_RE = /^(#{1,6}\s|```|\s*[-*+]\s+\S|\s*\d+[.)]\s|\s*>)/
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/

function parseTableRow(line: string): MdInline[][] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => parseInline(cell.trim()))
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // closing fence (or EOF)
      blocks.push({ kind: 'code', lang: fence[1], text: buf.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, children: parseInline(heading[2]) })
      i++
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line)
      const re = ordered ? OL_RE : UL_RE
      const items: MdInline[][] = []
      while (i < lines.length) {
        const m = re.exec(lines[i])
        if (!m) break
        items.push(parseInline(m[1]))
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', children: parseInline(buf.join(' ')) })
      continue
    }

    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = parseTableRow(line)
      i += 2
      const rows: MdInline[][][] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]) ) {
        rows.push(parseTableRow(lines[i]))
        i++
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    // paragraph: consume until a blank line or the start of another block
    const buf = [line]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !BLOCK_START_RE.test(lines[i])) {
      buf.push(lines[i])
      i++
    }
    blocks.push({ kind: 'paragraph', children: parseInline(buf.join('\n')) })
  }
  return blocks
}
