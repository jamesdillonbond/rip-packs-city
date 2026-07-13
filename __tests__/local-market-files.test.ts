import { describe, it, expect, vi, beforeEach } from "vitest"

// loadLocalJsonFeed reads public/<filename> as JSON via getOrSetCache. It returns
// []: on a read/parse failure (catch), or when the parsed JSON is not an array;
// otherwise the parsed array. We mock fs.readFile and use a unique filename per
// test so the module-level cache never serves a stale hit across cases.

const readFile = vi.fn()
vi.mock("fs", () => ({ promises: { readFile: (...a: any[]) => readFile(...a) } }))

import { loadLocalJsonFeed } from "@/lib/local-market-files"

beforeEach(() => {
  readFile.mockReset()
})

let n = 0
const uniq = () => `feed-${n++}.json`

describe("loadLocalJsonFeed", () => {
  it("returns the parsed array on a valid JSON array", async () => {
    readFile.mockResolvedValueOnce('[{"a":1},{"a":2}]')
    const rows = await loadLocalJsonFeed<{ a: number }>(uniq())
    expect(rows).toEqual([{ a: 1 }, { a: 2 }])
  })

  it("returns [] when the JSON is not an array", async () => {
    readFile.mockResolvedValueOnce('{"not":"an array"}')
    expect(await loadLocalJsonFeed(uniq())).toEqual([])
  })

  it("returns [] when the file read rejects", async () => {
    readFile.mockRejectedValueOnce(new Error("ENOENT"))
    expect(await loadLocalJsonFeed(uniq())).toEqual([])
  })

  it("returns [] on invalid JSON (parse throws)", async () => {
    readFile.mockResolvedValueOnce("{not json")
    expect(await loadLocalJsonFeed(uniq())).toEqual([])
  })

  it("caches the result: a second call with the same filename does not re-read", async () => {
    const name = uniq()
    readFile.mockResolvedValueOnce("[1,2,3]")
    const first = await loadLocalJsonFeed<number>(name)
    const second = await loadLocalJsonFeed<number>(name)
    expect(first).toEqual([1, 2, 3])
    expect(second).toEqual([1, 2, 3])
    expect(readFile).toHaveBeenCalledTimes(1)
  })
})
