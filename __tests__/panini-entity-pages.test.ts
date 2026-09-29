import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Panini entity pages (opened 2026-09-27). Panini has ZERO rows in `sales`,
 * `wallet_moments_cache`, `edition_offers` and `pack_distributions`, so every
 * shared section that reads one of those would answer "none" about a market that
 * exists. These pins hold the Panini arms that replace them, stated as the
 * ABSENCE of the false claim, each with a control.
 */

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import {
  fetchPaniniEditionAsk,
  fetchPaniniEditionSerials,
  fetchPaniniEditionSales,
  serialOfSku,
  coverageOf,
  paniniEditionUrl,
  toSerialRow,
} from "@/lib/panini/edition-market"
import { paniniSubjectIsPlayer } from "@/lib/panini/subjects"
import { fetchPaniniPlayerSales } from "@/lib/panini/player-sales"

type Res = { data: unknown; error: unknown }
function fakeDb(byTable: Record<string, Res | Res[]>) {
  const calls: Record<string, number> = {}
  return {
    from(table: string) {
      const i = (calls[table] = (calls[table] ?? 0) + 1) - 1
      const entry = byTable[table]
      const res = Array.isArray(entry) ? entry[i] ?? entry[entry.length - 1] : entry
      const b: any = {
        select: () => b, eq: () => b, gt: () => b, gte: () => b, not: () => b, order: () => b, limit: () => b, in: () => b,
        then: (resolve: any) => resolve(res ?? { data: [], error: null }),
      }
      return b
    },
  }
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

describe("paniniSubjectIsPlayer — the bridge's own player rule", () => {
  it("dual-player cards and nation/poster sets have no player page", () => {
    expect(paniniSubjectIsPlayer("Lionel Messi | Angel Di Maria", "Color Blast Duals")).toBe(false)
    expect(paniniSubjectIsPlayer("Norway", "Team Badges")).toBe(false)
    expect(paniniSubjectIsPlayer("Norway", "Team Badges Prizms Gold")).toBe(false)
    expect(paniniSubjectIsPlayer("Dallas", "World Cup Posters Prizms Black")).toBe(false)
    expect(paniniSubjectIsPlayer(null, "Base Prizms Blue")).toBe(false)
    expect(paniniSubjectIsPlayer("  ", "Base Prizms Blue")).toBe(false)
  })
  it("control: a single named player in a base or insert set is a player", () => {
    expect(paniniSubjectIsPlayer("Lionel Messi", "Base Prizms Blue")).toBe(true)
    expect(paniniSubjectIsPlayer("Kylian Mbappe", "Color Blast")).toBe(true)
  })
})

describe("paniniEditionUrl", () => {
  it("builds the marketplace page for a psku, and nothing for anything else", () => {
    expect(paniniEditionUrl("packcard-2332_486953_12679075_10")).toBe(
      "https://nft.paniniamerica.net/marketplace-details/packcard-2332_486953_12679075_10.html",
    )
    for (const bad of [null, undefined, "", "lionel-messi", "packcard-x/../y", "https://evil.example"]) {
      expect(paniniEditionUrl(bad as string | null | undefined)).toBeNull()
    }
  })
})

describe("fetchPaniniEditionAsk — three states", () => {
  it("rows → the ask with its confirmation time", async () => {
    const db = fakeDb({ panini_market_board: { data: [{ low_ask_usd: "12.5", listed_count: 3, ask_confirmed_at: "2026-09-27T10:00:00Z" }], error: null } })
    expect(await fetchPaniniEditionAsk("packcard-1", db)).toEqual({
      ask: { lowAskUsd: 12.5, listedCount: 3, askConfirmedAt: "2026-09-27T10:00:00Z" },
      ok: true,
    })
  })
  it("no row → ok with no ask (the edition genuinely has no confirmed listing)", async () => {
    expect(await fetchPaniniEditionAsk("packcard-1", fakeDb({ panini_market_board: { data: [], error: null } }))).toEqual({ ask: null, ok: true })
  })
  it("a failed read is ok:false — never 'no ask'", async () => {
    expect(await fetchPaniniEditionAsk("packcard-1", fakeDb({ panini_market_board: { data: null, error: { message: "timeout" } } }))).toEqual({ ask: null, ok: false })
  })
})

describe("fetchPaniniEditionSales — history + measured coverage", () => {
  it("parses serial/cap/flags from the sku and reads coverage as all / since / unread", async () => {
    expect(serialOfSku("packcard-1__1_10")).toEqual({ serial: 1, mintCap: 10 })
    expect(serialOfSku("odd")).toEqual({ serial: null, mintCap: null })
    expect(coverageOf({ complete_since: "-infinity", last_recent_read_at: "t" })).toEqual({ kind: "all", lastReadAt: "t" })
    expect(coverageOf({ complete_since: "2026-09-01T00:00:00+00:00", last_recent_read_at: null })).toEqual({ kind: "since", since: "2026-09-01T00:00:00+00:00", lastReadAt: null })
    expect(coverageOf(undefined)).toEqual({ kind: "unread" })
  })
  it("rows map newest-first with #1 / perfect flags; a failed coverage read is null, never 'complete'", async () => {
    const db = fakeDb({
      panini_sales: [
        { data: [{ sku: "p__10_10", sold_at: "2026-09-28T00:00:00Z", amount_usd: "50" }, { sku: "p__1_10", sold_at: "2026-09-27T00:00:00Z", amount_usd: 900 }], error: null },
        { data: null, error: null },
      ],
      panini_sales_reads: { data: null, error: { message: "boom" } },
      panini_card_serials: { data: [{ sku: "p__1_10" }], error: null },
    })
    const out = await fetchPaniniEditionSales("p", db)
    expect(out.sales?.map((x) => [x.serial, x.amountUsd, x.flags])).toEqual([[10, 50, ["last_mint"]], [1, 900, ["#1", "jersey"]]])
    expect(out.coverage).toBeNull()
  })
  it("a failed sales read is null — never 'no sales'", async () => {
    const out = await fetchPaniniEditionSales("p", fakeDb({ panini_sales: { data: null, error: { message: "x" } }, panini_sales_reads: { data: [], error: null } }))
    expect(out.sales).toBeNull()
    expect(out.coverage).toEqual({ kind: "unread" })
  })
})

describe("fetchPaniniPlayerSales — a player's sales across editions", () => {
  it("maps top + recent sales to their edition's parallel, and counts fully-covered editions", async () => {
    const db = fakeDb({
      editions: { data: [{ external_id: "e1", set_name: "Base Prizms Gold" }, { external_id: "e2", set_name: "Base" }], error: null },
      panini_sales: [
        { data: [{ sku: "e1__1_10", edition_external_id: "e1", sold_at: "2026-09-20T00:00:00Z", amount_usd: 900 }], error: null },
        { data: [{ sku: "e2__7_99", edition_external_id: "e2", sold_at: "2026-09-28T00:00:00Z", amount_usd: "12" }], error: null },
      ],
      panini_sales_reads: { data: null, error: null, count: 1 } as never,
    })
    const out = await fetchPaniniPlayerSales("p1", db)
    expect(out.top).toEqual([{ editionKey: "e1", setName: "Base Prizms Gold", serial: 1, mintCap: 10, amountUsd: 900, soldAt: "2026-09-20T00:00:00Z" }])
    expect(out.recent?.[0]).toMatchObject({ editionKey: "e2", amountUsd: 12, serial: 7 })
    expect(out).toMatchObject({ editions: 2, editionsRead: 1 })
  })
  it("a failed editions read fails everything to null — never 'no sales'", async () => {
    const out = await fetchPaniniPlayerSales("p1", fakeDb({ editions: { data: null, error: { message: "x" } } }))
    expect(out).toEqual({ top: null, recent: null, editions: null, editionsRead: null })
  })
  it("a failed sales read is null for that list only", async () => {
    const db = fakeDb({
      editions: { data: [{ external_id: "e1", set_name: null }], error: null },
      panini_sales: [{ data: null, error: { message: "boom" } }, { data: [], error: null }],
      panini_sales_reads: { data: null, error: { message: "boom" } },
    })
    const out = await fetchPaniniPlayerSales("p1", db)
    expect(out.top).toBeNull()
    expect(out.recent).toEqual([])
    expect(out.editionsRead).toBeNull()
  })
})

describe("fetchPaniniEditionSerials — a failed list is null, an empty list is []", () => {
  it("failed reads are null, per list", async () => {
    const db = fakeDb({ panini_card_serials: [{ data: null, error: { message: "boom" } }, { data: [], error: null }] })
    expect(await fetchPaniniEditionSerials("packcard-1", db)).toEqual({ listed: null, sales: [] })
  })
  it("control: rows map, flags named in the shared vocabulary", async () => {
    const row = { serial_number: 1, mint_cap: 10, price_usd: "99", captured_at: "2026-09-27T00:00:00Z", last_sale_usd: null, last_sale_at: null, is_number_one: true, is_jersey_mint: false, is_perfect_mint: true }
    const db = fakeDb({ panini_card_serials: [{ data: [row], error: null }, { data: [], error: null }] })
    const out = await fetchPaniniEditionSerials("packcard-1", db)
    expect(out.listed?.[0]).toMatchObject({ serial: 1, mintCap: 10, askUsd: 99, flags: ["#1", "last_mint"] })
    expect(out.sales).toEqual([])
  })
  it("a missing number is null, never 0", () => {
    expect(toSerialRow({ serial_number: null, price_usd: "", last_sale_usd: undefined })).toMatchObject({ serial: null, askUsd: null, lastSaleUsd: null })
  })
})

describe("the edition page's Panini arms (source facts)", () => {
  const src = read("app/(collections)/[collection]/edition/[slug]/page.tsx")
  it("never renders a 30-day sale count for Panini", () => {
    expect(src).toMatch(/\{!isPanini && \(\s*<StatCell\s+label="30d Sales"/)
  })
  it("reads Panini's ask from its own board, not the shared ask tables", () => {
    expect(src).toContain("fetchPaniniEditionAsk(detail.external_id)")
    expect(src).toContain("? (paniniAsk?.lowAskUsd ?? null)")
  })
  it("replaces Activity (\"No sales yet.\") and Special Serials with the Panini market section", () => {
    expect(src).toContain("<PaniniEditionMarketSection")
    expect(src).toContain("{!isPinnacle && !isPanini && (")
    // …and the Panini section never says "No sales yet."
    const section = src.slice(src.indexOf("function PaniniEditionMarketSection"), src.indexOf("function EditionUnavailable"))
    expect(section).not.toContain("No sales yet")
    // 2026-09-28: the section reads panini_sales and states its MEASURED completeness — all,
    // since a date, or not yet read — instead of a blanket "not a complete history".
    expect(section).toContain("Every sale of this edition is on record")
    expect(section).toContain("anything earlier shown here is partial")
    expect(section).toContain("fills in when the walk next reads it")
    // an empty list only says "no recorded sale" when the whole history was read
    expect(section).toMatch(/coverage\?\.kind === "all"\s*\?\s*"This edition has no recorded sale/)
  })
  it("offers no FMV/ask alert on Panini (the dispatcher cannot see Panini asks)", () => {
    expect(src).toContain("{!isPinnacle && !isPanini && detail.external_id && (")
  })
  it("hides the sale-print chart ranges on Panini", () => {
    expect(src).toContain("salesTracked={!isPanini}")
  })
})

describe("the player and set pages' Panini arms (source facts)", () => {
  const player = read("app/(collections)/[collection]/player/[slug]/page.tsx")
  const set = read("app/(collections)/[collection]/set/[slug]/page.tsx")
  it("player: no 'No recorded sales yet' and no FMV-restated Recent-Low on Panini", () => {
    expect(player).toContain("{!isPanini && <StatCell label={RECENT_LOW_TOTAL_LABEL}")
    expect(player).toMatch(/\{isPanini \? \(\s*<Section title="Sales">/)
  })
  it("player: Top Collectors (a Top Shot index keyed by NAME alone) renders on Top Shot only", () => {
    expect(player).toContain('{collection === "nba-top-shot" && (\n        <Suspense fallback={null}>\n          <TopCollectorsSection')
  })
  it("set: no sales read and no FMV-restated Recent-Low on Panini", () => {
    expect(set).toContain("const wantsActivity = !isPinnacleUrlSlug(collection) && !isPanini")
    expect(set).toContain("{!isPanini && <StatCell label={RECENT_LOW_TOTAL_LABEL}")
  })
})
