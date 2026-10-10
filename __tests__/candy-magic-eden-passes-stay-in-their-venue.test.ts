// Since 2026-10-10 three Candy tables have TWO writers — Magic Eden and OpenSea:
//   candy_listings (venue), candy_offers (venue), sales (marketplace).
// Each Magic Eden pass below reads or retires on evidence that is about Magic
// Eden ONLY. Unscoped, each one silently corrupts the OpenSea side:
//   · candy-offers' absence retirement ("the ME sweep did not see it") would
//     kill every OpenSea bid on every tick;
//   · candy-sales' high-water read would let a newer OpenSea sale jump the
//     Magic Eden cursor past trades it has not read;
//   · candy-listings' delist/fill retirement would end OpenSea asks on a Magic
//     Eden delist of the same mint.
// And both Magic Eden writers must PIN venue, because an upsert that omits the
// column keeps whatever venue the conflicting row already had.
//
// The route harness records update/select ROWS but not their FILTERS, so this is
// a source pin: comments stripped, each chain located by its distinctive call
// and asserted to carry the venue filter. Each assertion was proven by deleting
// the filter and watching it fail.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const src = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8")) as string

/** The `await (supabaseAdmin as any)...` chain that contains `anchor`. */
function chainAround(code: string, anchor: string): string {
  const at = code.indexOf(anchor)
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1)
  const start = code.lastIndexOf("await (supabaseAdmin as any)", at)
  expect(start).toBeGreaterThan(-1)
  const end = code.indexOf("\n\n", at)
  return code.slice(start, end === -1 ? undefined : end)
}

describe("Magic Eden Candy passes stay in their venue", () => {
  it("candy-offers: the bidder read, the book count and the ABSENCE retirement are venue='magic_eden'", () => {
    const code = src("app/api/ingest/candy-offers/route.ts")
    expect(chainAround(code, '.select("buyer, last_seen_at")')).toContain('.eq("venue", "magic_eden")')
    expect(chainAround(code, '.select("pda_address", { count: "exact", head: true })')).toContain('.eq("venue", "magic_eden")')
    // The absence pass is the update filtered on last_seen_at < start WITHOUT an expiry filter.
    const absence = chainAround(code, '.lt("last_seen_at", startedAtIso)')
    expect(absence).toContain(".update({ is_active: false })")
    expect(absence).toContain('.eq("venue", "magic_eden")')
  })

  it("candy-offers and candy-listings writers pin venue: 'magic_eden' on every row", () => {
    expect(src("app/api/ingest/candy-offers/route.ts")).toMatch(/is_active: true,\s*venue: "magic_eden"/)
    expect(src("app/api/candy-listings-indexer/route.ts")).toMatch(/is_active: true,\s*venue: "magic_eden"/)
  })

  it("candy-sales: the high-water cursor read is marketplace='magic_eden'", () => {
    const code = src("app/api/candy-sales-indexer/route.ts")
    const hw = chainAround(code, '.select("sold_at")')
    expect(hw).toContain('.eq("marketplace", "magic_eden")')
  })

  it("candy-listings: the delist/fill retirement is venue='magic_eden'", () => {
    const code = src("app/api/candy-listings-indexer/route.ts")
    const ended = chainAround(code, '.in("token_mint", slice)')
    expect(ended).toContain('.eq("venue", "magic_eden")')
  })
})
