import { describe, it, expect } from "vitest"
import { fetchCandyAsks, CANDY_ASK_CONFIRMED_HOURS } from "@/lib/moment-detail/fetchers"

/**
 * fetchCandyAsks — Candy MLB (Solana) moment pages read their floor and this
 * card's own ask from Candy's native listings. Until 2026-09-25 both cells read
 * "—" on every Candy card, because the generic cell reads only Flow sources.
 * Stated as the absence of the false claim: an ask not seen in the confirmation
 * window is not quoted as live, the mint is matched VERBATIM, and a failed read
 * is ok:false (the page's "Live ask" degraded notice), never an absence.
 */

type Filter = [string, string, unknown]
function makeDb(fixtures: Record<string, { data: unknown; error: unknown }>) {
  const filters: Filter[] = []
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "order", "limit"]) b[m] = () => b
    for (const m of ["eq", "gt"]) b[m] = (col: string, v: unknown) => { filters.push([table, `${m}:${col}`, v]); return b }
    b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
      Promise.resolve(fixtures[table] ?? { data: [], error: null }).then(f, r)
    return b
  }
  return { db: { from: (t: string) => builder(t) }, filters }
}

const MINT = "7TCqbQKkw5tmyVP4MF5h4dx8MXnwoLx66WSpoJjWX3jw"
const NOW = Date.parse("2026-09-26T04:00:00Z")

describe("fetchCandyAsks", () => {
  it("returns the confirmed floor and this mint's own ask", async () => {
    const { db } = makeDb({
      candy_listing_floor: { data: [{ confirmed_floor_usd: "4.84" }], error: null },
      candy_listings: { data: [{ price_usd: 6.1 }], error: null },
    })
    expect(await fetchCandyAsks("ed-1", MINT, db, NOW)).toEqual({ data: { floorUsd: 4.84, serialAskUsd: 6.1 }, ok: true })
  })

  it("matches the mint VERBATIM and only asks SEEN inside the confirmation window", async () => {
    const { db, filters } = makeDb({})
    await fetchCandyAsks("ed-1", MINT, db, NOW)
    const mint = filters.find(([t, k]) => t === "candy_listings" && k === "eq:token_mint")?.[2]
    expect(mint).toBe(MINT)
    expect(mint).not.toBe(MINT.toLowerCase())
    const since = filters.find(([t, k]) => t === "candy_listings" && k === "gt:last_seen_at")?.[2]
    expect(since).toBe(new Date(NOW - CANDY_ASK_CONFIRMED_HOURS * 3_600_000).toISOString())
    expect(filters.some(([t, k, v]) => t === "candy_listings" && k === "eq:is_active" && v === true)).toBe(true)
  })

  it("an edition with no confirmed ask is an absence (null), not a zero", async () => {
    const { db } = makeDb({ candy_listing_floor: { data: [{ confirmed_floor_usd: null }], error: null } })
    expect(await fetchCandyAsks("ed-1", MINT, db, NOW)).toEqual({ data: { floorUsd: null, serialAskUsd: null }, ok: true })
  })

  it("an edition-level page (no mint) never queries a serial ask", async () => {
    const { db, filters } = makeDb({ candy_listing_floor: { data: [{ confirmed_floor_usd: 2 }], error: null } })
    expect(await fetchCandyAsks("ed-1", null, db, NOW)).toEqual({ data: { floorUsd: 2, serialAskUsd: null }, ok: true })
    expect(filters.some(([t]) => t === "candy_listings")).toBe(false)
  })

  it("a FAILED read is ok:false — never rendered as 'no ask'", async () => {
    const { db } = makeDb({ candy_listings: { data: null, error: { message: "canceling statement due to statement timeout" } } })
    expect(await fetchCandyAsks("ed-1", MINT, db, NOW)).toEqual({ data: null, ok: false })
    const throwing = { from: () => { throw new Error("socket hang up") } }
    expect(await fetchCandyAsks("ed-1", MINT, throwing, NOW)).toEqual({ data: null, ok: false })
  })
})
