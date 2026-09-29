import { describe, it, expect, vi } from "vitest"

// fetchPaniniSalesAnalytics — a failed or hung read is null (the tab says "couldn't load"),
// never a payload of zeros.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
import { fetchPaniniSalesAnalytics } from "@/lib/panini/sales-analytics-read"

const good = {
  generated_at: "2026-09-29T00:00:00Z", days: 30,
  coverage: { active_editions: 1, editions_read: 0, editions_whole_history: 0, editions_with_gaps: 0, first_read_at: null, last_read_at: null, sales_held: 1, sales_from_full_records: 0 },
  daily: [], window: { sales: 0, volume_usd: 0, median_usd: null, editions_traded: 0, cards_traded: 0 },
  top_sales_window: [], top_sales_all_time: [], most_traded: [], by_tier: [], by_parallel: [], by_player: [], serial_premium: [],
}

describe("fetchPaniniSalesAnalytics", () => {
  it("parses a good answer and asks for 30 days", async () => {
    const calls: unknown[] = []
    const db = { rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return { data: good, error: null } } }
    expect((await fetchPaniniSalesAnalytics(db))?.coverage.sales_held).toBe(1)
    expect(calls).toEqual([["panini_sales_analytics", { p_days: 30 }]])
  })
  it("an RPC error or a malformed answer is null", async () => {
    expect(await fetchPaniniSalesAnalytics({ rpc: async () => ({ data: null, error: { message: "57014" } }) })).toBeNull()
    expect(await fetchPaniniSalesAnalytics({ rpc: async () => ({ data: { coverage: {} }, error: null }) })).toBeNull()
    expect(await fetchPaniniSalesAnalytics({ rpc: () => { throw new Error("boom") } })).toBeNull()
  })
  it("a hung read times out to null", async () => {
    vi.useFakeTimers()
    const p = fetchPaniniSalesAnalytics({ rpc: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await p).toBeNull()
    vi.useRealTimers()
  })
})
