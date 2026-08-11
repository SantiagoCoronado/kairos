import { describe, it, expect } from 'vitest'
import { parseMarkdown, parseInline, splitBareUrls } from './markdown-lite'

describe('splitBareUrls', () => {
  it('splits text around bare URLs', () => {
    expect(splitBareUrls('see https://a.io/x and http://b.co')).toEqual([
      { text: 'see ', url: false },
      { text: 'https://a.io/x', url: true },
      { text: ' and ', url: false },
      { text: 'http://b.co', url: true }
    ])
  })

  it('returns one literal segment when there is no URL', () => {
    expect(splitBareUrls('no links here')).toEqual([{ text: 'no links here', url: false }])
  })

  it('leaves trailing prose punctuation out of the URL', () => {
    expect(splitBareUrls('read https://a.io/doc.')).toEqual([
      { text: 'read ', url: false },
      { text: 'https://a.io/doc', url: true },
      { text: '.', url: false }
    ])
    expect(splitBareUrls('(see https://a.io/doc)')).toEqual([
      { text: '(see ', url: false },
      { text: 'https://a.io/doc', url: true },
      { text: ')', url: false }
    ])
  })

  it('keeps balanced parens inside Wikipedia-style URLs', () => {
    expect(splitBareUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      { text: 'https://en.wikipedia.org/wiki/Foo_(bar)', url: true }
    ])
  })

  it('keeps angle brackets out of the URL', () => {
    expect(splitBareUrls('see <https://a.io/x> for details')).toEqual([
      { text: 'see <', url: false },
      { text: 'https://a.io/x', url: true },
      { text: '> for details', url: false }
    ])
  })

  it('does not linkify other schemes', () => {
    expect(splitBareUrls('run javascript:alert(1) now')).toEqual([
      { text: 'run javascript:alert(1) now', url: false }
    ])
  })
})

describe('markdown-lite inline', () => {
  it('autolinks bare URLs in plain text', () => {
    expect(parseInline('docs at https://a.io/x, then **https://b.co** too')).toEqual([
      { kind: 'text', text: 'docs at ' },
      { kind: 'link', href: 'https://a.io/x', children: [{ kind: 'text', text: 'https://a.io/x' }] },
      { kind: 'text', text: ', then ' },
      {
        kind: 'bold',
        children: [
          { kind: 'link', href: 'https://b.co', children: [{ kind: 'text', text: 'https://b.co' }] }
        ]
      },
      { kind: 'text', text: ' too' }
    ])
  })

  it('does not autolink inside markdown-link text (no nested anchors)', () => {
    expect(parseInline('[https://a.io/x](https://b.io/y)')).toEqual([
      { kind: 'link', href: 'https://b.io/y', children: [{ kind: 'text', text: 'https://a.io/x' }] }
    ])
    // bold inside link text stays autolink-free too
    expect(parseInline('[**https://a.io**](https://b.io)')).toEqual([
      {
        kind: 'link',
        href: 'https://b.io',
        children: [{ kind: 'bold', children: [{ kind: 'text', text: 'https://a.io' }] }]
      }
    ])
  })

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

  it('keeps blank-line-separated numbered steps as one list', () => {
    const blocks = parseMarkdown('Steps:\n\n1. First\n\n2. Second\n\n3. Third')
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: true, start: 1 })
    expect((blocks[1] as { items: unknown[] }).items).toHaveLength(3)
  })

  it('a blank line with no item after it still ends the list', () => {
    const blocks = parseMarkdown('- one\n- two\n\nplain text')
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'paragraph'])
  })

  it('an ordered list keeps its starting number', () => {
    const blocks = parseMarkdown('3. third\n4. fourth')
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true, start: 3 })
  })

  it('records indent levels so sublists can nest', () => {
    const blocks = parseMarkdown('- parent\n  - child\n\t- tab child\n- parent2')
    const items = (blocks[0] as { items: { indent: number }[] }).items
    expect(items.map((it) => it.indent)).toEqual([0, 1, 1, 0])
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
