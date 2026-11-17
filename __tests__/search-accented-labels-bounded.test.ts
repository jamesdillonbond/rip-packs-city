import { describe, it, expect, vi, afterEach } from "vitest"

// 2026-11-14 (fresh-eyes review of search): loadAccentedLabels awaited an UNBOUNDED rpc and did not
// remember a failure, so under DB slowness a search whose main query had answered still hung on this
// optional extra, and every request paid the failure again.
afterEach(() => { vi.useRealTimers(); vi.resetModules() })

describe("loadAccentedLabels", () => {
  it("gives up on a hung read within its budget and answers [] (an optional extra, not the answer)", async () => {
    vi.useFakeTimers()
    const { loadAccentedLabels } = await import("@/lib/search/accented-labels")
    const db = { rpc: vi.fn(() => new Promise<never>(() => {})) }
    const p = loadAccentedLabels(db as never)
    await vi.advanceTimersByTimeAsync(2_500)
    await expect(p).resolves.toEqual([])
  })

  it("does not re-ask a failing read on the very next search", async () => {
    const { loadAccentedLabels } = await import("@/lib/search/accented-labels")
    const db = { rpc: vi.fn(async () => ({ data: null, error: { message: "timeout" } })) }
    expect(await loadAccentedLabels(db as never)).toEqual([])
    expect(await loadAccentedLabels(db as never)).toEqual([])
    expect(db.rpc).toHaveBeenCalledTimes(1)
  })
})
