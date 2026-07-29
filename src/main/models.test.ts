import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureModelFile, isModelPresent, type ModelFile } from './models'

let dir: string

const INFO: ModelFile = { file: 'ggml-test.bin', url: 'https://models.test/x', bytes: 6, label: 't' }

const okFetch = (body: Uint8Array = new Uint8Array([1, 2, 3, 4, 5, 6])): typeof fetch =>
  (async () => new Response(new Blob([body as BlobPart]).stream(), { status: 200 })) as typeof fetch

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kairos-models-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

describe('ensureModelFile', () => {
  it('downloads, reports progress, verifies size, renames atomically', async () => {
    const seen: [number, number][] = []
    const path = await ensureModelFile(dir, INFO, (r, t) => seen.push([r, t]), okFetch())
    expect(path).toBe(join(dir, 'ggml-test.bin'))
    expect([...(await readFile(path))]).toEqual([1, 2, 3, 4, 5, 6])
    expect(seen.at(-1)![0]).toBe(6)
    expect(seen.at(-1)![1]).toBe(6)
    expect(await readdir(dir)).toEqual(['ggml-test.bin']) // no .part left
  })

  it('skips the download when the file is already present at the right size', async () => {
    await writeFile(join(dir, INFO.file), new Uint8Array(6))
    let fetched = false
    await ensureModelFile(dir, INFO, undefined, (async () => {
      fetched = true
      return new Response('x')
    }) as typeof fetch)
    expect(fetched).toBe(false)
  })

  it('re-downloads when the existing file has the wrong size', async () => {
    await writeFile(join(dir, INFO.file), new Uint8Array(3)) // truncated
    expect(await isModelPresent(dir, INFO)).toBe(false)
    await ensureModelFile(dir, INFO, undefined, okFetch())
    expect(await isModelPresent(dir, INFO)).toBe(true)
  })

  it('rejects and cleans up a truncated download', async () => {
    await expect(
      ensureModelFile(dir, INFO, undefined, okFetch(new Uint8Array([1, 2])))
    ).rejects.toThrow(/truncated/)
    expect(await readdir(dir)).toEqual([]) // .part removed, nothing staged
  })

  it('rejects on HTTP errors', async () => {
    const fetch404 = (async () => new Response('nope', { status: 404 })) as typeof fetch
    await expect(ensureModelFile(dir, INFO, undefined, fetch404)).rejects.toThrow(/404/)
  })
})
