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

export type MdListItem = { indent: number; children: MdInline[] }

export type MdBlock =
  | { kind: 'heading'; level: number; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { kind: 'quote'; children: MdInline[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: MdInline[][]; rows: MdInline[][][] }

// one alternation, first match wins: `code` | **bold** | *italic* | _italic_ | [text](url)
// bold content may hold nested * emphasis; the (?!\*) after the closer makes
// '**a *b***' close on the LAST star pair instead of stranding one. The link
// URL tolerates one level of balanced parens (Wikipedia-style URLs).
const INLINE_RE =
  /(`+)([^`]+?)\1|\*\*(.+?)\*\*(?!\*)|\*([^*\n]+?)\*|(?<![\w])_([^_\n]+?)_(?![\w])|\[([^\]]+?)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/

/** emphasis nests via recursion; degenerate marker runs ('****…') would
 *  otherwise recurse once per ~2 chars and blow the stack */
const MAX_INLINE_DEPTH = 8

/** only schemes safe to hand to shell.openExternal render as links */
const SAFE_HREF_RE = /^(https?:|mailto:)/i

// exclude <> so angle-bracket autolinks (`<https://a.io>`) keep their brackets
const BARE_URL_RE = /https?:\/\/[^\s<>]+/g

/** Split text into literal and bare-URL segments. Trailing punctuation is
 *  almost always prose, not URL; a ')' only stays while parens are balanced
 *  (Wikipedia-style URLs). */
export function splitBareUrls(text: string): { text: string; url: boolean }[] {
  const out: { text: string; url: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(BARE_URL_RE)) {
    let url = m[0]
    for (;;) {
      const ch = url[url.length - 1]
      if ('.,;:!?\'"'.includes(ch)) url = url.slice(0, -1)
      else if (
        ch === ')' &&
        (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)
      )
        url = url.slice(0, -1)
      else break
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index), url: false })
    out.push({ text: url, url: true })
    last = m.index + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last), url: false })
  return out
}

/** push literal text, autolinking bare URLs unless already inside a link
 *  (`[https://a](https://b)` must not nest an anchor in an anchor) */
function pushText(out: MdInline[], text: string, autolink: boolean): void {
  if (!autolink) {
    out.push({ kind: 'text', text })
    return
  }
  for (const seg of splitBareUrls(text)) {
    if (seg.url)
      out.push({ kind: 'link', href: seg.text, children: [{ kind: 'text', text: seg.text }] })
    else out.push({ kind: 'text', text: seg.text })
  }
}

export function parseInline(text: string, depth = 0, autolink = true): MdInline[] {
  if (depth >= MAX_INLINE_DEPTH) return [{ kind: 'text', text }]
  const out: MdInline[] = []
  let rest = text
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest)
    if (!m) {
      pushText(out, rest, autolink)
      break
    }
    if (m.index > 0) pushText(out, rest.slice(0, m.index), autolink)
    if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] })
    else if (m[3] !== undefined)
      out.push({ kind: 'bold', children: parseInline(m[3], depth + 1, autolink) })
    else if (m[4] !== undefined)
      out.push({ kind: 'italic', children: parseInline(m[4], depth + 1, autolink) })
    else if (m[5] !== undefined)
      out.push({ kind: 'italic', children: parseInline(m[5], depth + 1, autolink) })
    else if (SAFE_HREF_RE.test(m[7])) {
      out.push({ kind: 'link', href: m[7], children: parseInline(m[6], depth + 1, false) })
    } else {
      // javascript:/file:/custom schemes stay visible, inert text
      out.push({ kind: 'text', text: m[0] })
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

const UL_RE = /^(\s*)[-*+]\s+(.*)$/
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/

/** nesting level from leading whitespace — models indent sublists by 2 (or 4)
 *  spaces or a tab; anything deeper than 5 levels is noise, not structure */
function indentLevel(ws: string): number {
  let cols = 0
  for (const ch of ws) cols += ch === '\t' ? 2 : 1
  return Math.min(Math.floor(cols / 2), 5)
}
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
      const start = ordered ? parseInt(OL_RE.exec(line)![2], 10) : 1
      const items: MdListItem[] = []
      while (i < lines.length) {
        const m = re.exec(lines[i])
        if (!m) {
          // a single blank line continues the list when another item follows —
          // models routinely put blank lines between numbered steps, and
          // splitting there restarts every fragment at "1."
          if (/^\s*$/.test(lines[i]) && i + 1 < lines.length && re.test(lines[i + 1])) {
            i++
            continue
          }
          break
        }
        items.push({ indent: indentLevel(m[1]), children: parseInline(m[ordered ? 3 : 2]) })
        i++
      }
      blocks.push({ kind: 'list', ordered, start, items })
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
