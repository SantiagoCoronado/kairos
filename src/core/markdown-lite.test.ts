import { describe, it, expect } from 'vitest'
import { parseMarkdown, parseInline } from './markdown-lite'

describe('markdown-lite inline', () => {
  it('parses code, bold, italic, links, and plain text runs', () => {
    expect(parseInline('run `npm test` **now** or *later*, see [docs](https://x.y/z)')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' ' },
      { kind: 'bold', children: [{ kind: 'text', text: 'now' }] },
      { kind: 'text', text: ' or ' },
      { kind: 'italic', children: [{ kind: 'text', text: 'later' }] },
      { kind: 'text', text: ', see ' },
      { kind: 'link', href: 'https://x.y/z', children: [{ kind: 'text', text: 'docs' }] }
    ])
  })

  it('does not treat snake_case identifiers as emphasis', () => {
    expect(parseInline('the person_id column')).toEqual([
      { kind: 'text', text: 'the person_id column' }
    ])
  })

  it('caps emphasis recursion instead of blowing the stack', () => {
    // a flat run of thousands of ** markers must parse (as junk), not throw
    expect(() => parseInline('**'.repeat(14000))).not.toThrow()
  })

  it('renders unsafe link schemes as inert text', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[click](javascript:alert(1))' }
    ])
    expect(parseInline('[f](file:///etc/passwd)')).toEqual([
      { kind: 'text', text: '[f](file:///etc/passwd)' }
    ])
  })

  it('keeps balanced parens inside link URLs', () => {
    expect(parseInline('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      {
        kind: 'link',
        href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
        children: [{ kind: 'text', text: 'wiki' }]
      }
    ])
  })

  it('nests emphasis inside bold', () => {
    expect(parseInline('**really *sure***')).toEqual([
      {
        kind: 'bold',
        children: [
          { kind: 'text', text: 'really ' },
          { kind: 'italic', children: [{ kind: 'text', text: 'sure' }] }
        ]
      }
    ])
  })
})

describe('markdown-lite blocks', () => {
  it('parses headings, paragraphs, and rules', () => {
    const blocks = parseMarkdown('## Summary\n\nAll done.\n\n---\n')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'rule'])
    expect(blocks[0]).toMatchObject({ level: 2 })
  })

  it('parses fenced code without touching inline markers inside', () => {
    const blocks = parseMarkdown('```ts\nconst a = "**not bold**"\n```')
    expect(blocks).toEqual([{ kind: 'code', lang: 'ts', text: 'const a = "**not bold**"' }])
  })

  it('parses unordered and ordered lists', () => {
    const blocks = parseMarkdown('- one\n- two\n\n1. first\n2. second')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false })
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true })
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2)
  })

  it('parses quotes and pipe tables', () => {
    const blocks = parseMarkdown('> heads up\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(blocks[0]).toMatchObject({ kind: 'quote' })
    expect(blocks[1]).toMatchObject({ kind: 'table' })
    const table = blocks[1] as { header: unknown[]; rows: unknown[] }
    expect(table.header).toHaveLength(2)
    expect(table.rows).toHaveLength(1)
  })

  it('a pipe line without a separator row is a plain paragraph', () => {
    const blocks = parseMarkdown('| just text |')
    expect(blocks[0].kind).toBe('paragraph')
  })

  it('unterminated fence swallows to EOF without crashing', () => {
    const blocks = parseMarkdown('```\nno closing fence')
    expect(blocks).toEqual([{ kind: 'code', lang: '', text: 'no closing fence' }])
  })

  it('keeps unrecognized text as paragraphs with hard line breaks', () => {
    const blocks = parseMarkdown('line one\nline two')
    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        children: [{ kind: 'text', text: 'line one\nline two' }]
      }
    ])
  })
})
