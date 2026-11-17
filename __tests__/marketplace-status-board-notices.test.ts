import { describe, it, expect, vi } from "vitest"

// nonHealthyMarketNotices (2026-10-27): a cross-collection board (Below FMV) names every collection whose marketplace
// is down, grouped by the note they share; healthy collections and FAILED reads add nothing.

vi.mock("next/cache", () => ({ unstable_cache: (fn: any) => fn }))

const NOTE = "Dapper is down for maintenance."
const rows: Record<string, { data: any; error: any }> = {
  nba_top_shot: { data: { slug: "nba_top_shot", status: "degraded", notes: NOTE }, error: null },
  nfl_all_day: { data: { slug: "nfl_all_day", status: "degraded", notes: NOTE }, error: null },
  candy_mlb: { data: { slug: "candy_mlb", status: "healthy", notes: "fine" }, error: null },
  disney_pinnacle: { data: null, error: { message: "boom" } },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    let slug = ""
    const b: any = { select: () => b, eq: (_c: string, v: string) => { slug = v; return b }, maybeSingle: async () => rows[slug] ?? { data: null, error: null } }
    return b
  }
  const client: any = { from: () => build() }
  return { supabase: client, supabaseAdmin: client }
})

import { nonHealthyMarketNotices } from "@/lib/marketplace-status"

describe("nonHealthyMarketNotices", () => {
  it("groups collections sharing a note; skips healthy and failed reads", async () => {
    const out = await nonHealthyMarketNotices(["nba-top-shot", "nfl-all-day", "candy-mlb", "disney-pinnacle"], (s) => s.toUpperCase())
    expect(out).toEqual([{ collections: ["NBA-TOP-SHOT", "NFL-ALL-DAY"], notes: NOTE }])
  })
  it("CONTROL: all healthy → no notice", async () => {
    expect(await nonHealthyMarketNotices(["candy-mlb"], (s) => s)).toEqual([])
  })
})
