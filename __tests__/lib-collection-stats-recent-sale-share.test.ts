import { describe, it, expect } from "vitest"
import { readRecentSaleShare, RECENT_SALE_MAX_AGE_MS } from "@/lib/collection-stats/read"

/**
 * known-issues #205 (Trevor 2026-10-21, "make it a real sales stat"): the overview's
 * "Priced from Recent Sales" tile reads mv_collection_recent_sale_share. Stated as absences:
 * a failed read, a missing row and a row older than the refresh can sustain all publish NO
 * number, never a stale one and never a substitute.
 */

const NOW = Date.parse("2026-10-21T19:40:00Z")

function db(res: { data?: unknown; error?: unknown } | (() => never)) {
  const calls: string[] = []
  const client = {
    from(table: string) {
      calls.push(`from:${table}`)
      const b: any = {
        select: (c: string) => (calls.push(`select:${c}`), b),
        eq: (c: string, v: unknown) => (calls.push(`eq:${c}=${String(v)}`), b),
        limit: () => b,
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
          if (typeof res === "function") return Promise.reject(new Error("boom")).then(ok, bad)
          return Promise.resolve({ data: res.data ?? null, error: res.error ?? null }).then(ok, bad)
        },
      }
      return b
    },
  }
  return { client: client as any, calls }
}

describe("readRecentSaleShare", () => {
  it("publishes a fresh row, keyed on the RPC's own slug", async () => {
    const { client, calls } = db({ data: [{ editions: 575, editions_sold_30d: 84, recent_sale_pct: "14.6", computed_at: "2026-10-21T19:31:00Z" }] })
    const r = await readRecentSaleShare(client, "laliga_golazos", "t", NOW)
    expect(r).toEqual({ recent_sale_pct: 14.6, recent_sale_count: 84, recent_sale_editions: 575, recent_sale_as_of: "2026-10-21T19:31:00Z", recent_sale_failed: false })
    expect(calls).toContain("from:mv_collection_recent_sale_share")
    expect(calls).toContain("eq:slug=laliga_golazos")
  })

  it("keeps a genuine zero as 0, not null", async () => {
    const { client } = db({ data: [{ editions: 617, editions_sold_30d: 0, recent_sale_pct: "0.0", computed_at: "2026-10-21T19:31:00Z" }] })
    const r = await readRecentSaleShare(client, "ufc_strike", "t", NOW)
    expect(r.recent_sale_pct).toBe(0)
    expect(r.recent_sale_failed).toBe(false)
  })

  it("withholds a row older than the refresh can sustain", async () => {
    const old = new Date(NOW - RECENT_SALE_MAX_AGE_MS - 60_000).toISOString()
    const { client } = db({ data: [{ editions: 575, editions_sold_30d: 84, recent_sale_pct: "14.6", computed_at: old }] })
    const r = await readRecentSaleShare(client, "laliga_golazos", "t", NOW)
    expect(r.recent_sale_pct).toBeNull()
    expect(r.recent_sale_count).toBeNull()
    expect(r.recent_sale_failed).toBe(true)
    expect(r.recent_sale_as_of).toBe(old)
  })

  it("a failed read, a missing row and a thrown read all publish no number", async () => {
    for (const res of [{ error: { message: "timeout" } }, { data: [] }, () => { throw new Error("x") }] as const) {
      const { client } = db(res as any)
      const r = await readRecentSaleShare(client, "nba_top_shot", "t", NOW)
      expect(r.recent_sale_pct).toBeNull()
      expect(r.recent_sale_failed).toBe(true)
    }
  })
})
