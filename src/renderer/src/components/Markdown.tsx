// Renders markdown-lite blocks (agent output: automation results, summaries).
// External links go through the window-open handler → default browser.
import { useMemo } from 'react'
import { parseMarkdown, type MdBlock, type MdInline, type MdListItem } from '../../../core/markdown-lite'
// (MdBlock is also the fallback shape when parsing throws)
import { cn } from './ui'

function Inline({ nodes }: { nodes: MdInline[] }): React.JSX.Element {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case 'text':
            return <span key={i}>{n.text}</span>
          case 'code':
            return (
              <code key={i} className="px-1 py-0.5 rounded bg-raised font-mono text-[0.9em]">
                {n.text}
              </code>
            )
          case 'bold':
            return (
              <strong key={i} className="font-semibold text-text">
                <Inline nodes={n.children} />
              </strong>
            )
          case 'italic':
            return (
              <em key={i}>
                <Inline nodes={n.children} />
              </em>
            )
          case 'link':
            return (
              <a
                key={i}
                href={n.href}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline break-all"
              >
                <Inline nodes={n.children} />
              </a>
            )
        }
      })}
    </>
  )
}

/** Items arrive flat with an indent level; runs of deeper indent become a
 *  sublist inside the preceding item, so `- a / (2sp) - b` actually nests. */
function List({
  items,
  ordered,
  start
}: {
  items: MdListItem[]
  ordered: boolean
  start?: number
}): React.JSX.Element {
  const base = items[0]?.indent ?? 0
  const lis: React.JSX.Element[] = []
  let k = 0
  while (k < items.length) {
    let j = k + 1
    while (j < items.length && items[j].indent > base) j++
    lis.push(
      <li key={k}>
        <Inline nodes={items[k].children} />
        {j > k + 1 && <List items={items.slice(k + 1, j)} ordered={ordered} />}
      </li>
    )
    k = j
  }
  return ordered ? (
    <ol start={start} className="list-decimal pl-5 space-y-0.5">
      {lis}
    </ol>
  ) : (
    <ul className="list-disc pl-5 space-y-0.5">{lis}</ul>
  )
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[15px] font-semibold text-text',
  2: 'text-[14px] font-semibold text-text',
  3: 'text-[13px] font-semibold text-text'
}

function Block({ block }: { block: MdBlock }): React.JSX.Element {
  switch (block.kind) {
    case 'heading':
      return (
        <p className={HEADING_CLASS[Math.min(block.level, 3)]}>
          <Inline nodes={block.children} />
        </p>
      )
    case 'paragraph':
      return (
        <p className="whitespace-pre-wrap">
          <Inline nodes={block.children} />
        </p>
      )
    case 'code':
      return (
        <pre className="px-2.5 py-2 rounded-md bg-raised border border-border overflow-x-auto font-mono text-[11.5px] leading-relaxed">
          {block.text}
        </pre>
      )
    case 'list':
      return <List items={block.items} ordered={block.ordered} start={block.start} />
    case 'quote':
      return (
        <blockquote className="border-l-2 border-border-strong pl-2.5 text-faint">
          <Inline nodes={block.children} />
        </blockquote>
      )
    case 'rule':
      return <hr className="border-border" />
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="text-left border-collapse">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} className="border border-border px-2 py-1 font-semibold bg-raised/60">
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="border border-border px-2 py-1">
                      <Inline nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

export function Markdown({ text, className }: { text: string; className?: string }): React.JSX.Element {
  // one malformed result must degrade to plain text, not white-screen the app
  const blocks = useMemo<MdBlock[]>(() => {
    try {
      return parseMarkdown(text)
    } catch {
      return [{ kind: 'paragraph', children: [{ kind: 'text', text }] }]
    }
  }, [text])
  return (
    <div className={cn('space-y-2', className)}>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  )
}
