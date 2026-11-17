import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { hydrateAllDayEditions, resetAllDayCache } from "@/lib/editions-hydrate"

// 2026-11-02: the All Day catalog walk was memoized for the process lifetime no
// matter how it ended — a page error cached a PARTIAL map and a thrown fetch cached
// a REJECTED promise, so a warm instance kept missing (or throwing) until a cold
// start. Only a walk that reached the catalog's end may be memoized.

const node = (set: string, play: string, name: string) => ({
  node: { id: `${set}-${play}`, set: { id: set, name: "S" }, play: { id: play, playerName: name }, tier: "COMMON" },
})
const page = (edges: unknown[], hasNextPage: boolean, endCursor: string | null = "c1") => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { allEditions: { edges, pageInfo: { hasNextPage, endCursor } } } }),
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetAllDayCache()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetAllDayCache()
})

describe("All Day catalog walk memoization", () => {
  it("a walk that failed on page 2 is NOT memoized: the next call walks again and resolves page-2 editions", async () => {
    fetchMock
      .mockResolvedValueOnce(page([node("1", "1", "A")], true))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    const first = await hydrateAllDayEditions(["1:1", "2:2"])
    expect(first.find((r) => r.external_id === "2:2")?.ok).toBe(false)

    fetchMock
      .mockResolvedValueOnce(page([node("1", "1", "A")], true))
      .mockResolvedValueOnce(page([node("2", "2", "B")], false))
    const second = await hydrateAllDayEditions(["2:2"])
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(second[0].ok).toBe(true)
  })

  it("a THROWN walk is not memoized as a rejection: the next call succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"))
    await expect(hydrateAllDayEditions(["1:1"])).rejects.toThrow("timeout")
    fetchMock.mockResolvedValueOnce(page([node("1", "1", "A")], false))
    const rows = await hydrateAllDayEditions(["1:1"])
    expect(rows[0].ok).toBe(true)
  })

  it("no-change control: a COMPLETE walk is memoized (second call fetches nothing)", async () => {
    fetchMock.mockResolvedValueOnce(page([node("1", "1", "A")], false))
    await hydrateAllDayEditions(["1:1"])
    await hydrateAllDayEditions(["1:1"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
