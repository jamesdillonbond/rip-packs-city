// @vitest-environment jsdom
// The "What Candy covers" / "What Panini covers" grids are server components: an async wrapper reads the
// board and hands rows to a pure view. The views are pinned in candy-properties / panini-properties; these
// pin the WRAPPERS, which is where a failed read could be published as "nothing is covered":
//   · a failed read (error, or a wrong shape) renders NOTHING — no section, no heading, no empty grid;
//   · a good read renders the tiles, and Candy's "not placed under a brand yet" count comes from the board.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import type React from "react"

type Res = { data: unknown; error: { message: string } | null }
const rpcState: Record<string, Res> = {}
const rpcCalls: string[] = []

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string; "data-testid"?: string }) => (
    <a href={href} data-testid={rest["data-testid"]}>{children}</a>
  ),
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      rpcCalls.push(name)
      return rpcState[name] ?? { data: null, error: { message: "no fixture" } }
    },
  },
}))

import CandyPropertyGrid from "@/components/collection/CandyPropertyGrid"
import PaniniPropertyGrid from "@/components/collection/PaniniPropertyGrid"

const CANDY_BOARD = {
  computed_at: "2026-11-26T20:16:00Z",
  unplaced_collections: 2,
  properties: [
    { slug: "mlb", name: "MLB", heading: "leagues", category: "Baseball", subject_word: "player", team_league: "mlb", sort_order: 10, collections: 88, cards: 926176, editions: 13625, priced_editions: 2097, listed_editions: 1250, sales_90d: 4100, sales_90d_volume_usd: 51000, first_season: "2021", last_season: "2026" },
    { slug: "dc", name: "DC", heading: "entertainment", category: "Comics", subject_word: "character", team_league: null, sort_order: 110, collections: 281, cards: 449854, editions: 6410, priced_editions: 976, listed_editions: 557, sales_90d: 0, sales_90d_volume_usd: null, first_season: null, last_season: null },
  ],
  set_property: { "batman-1940-2011-1": "dc" },
}

const PANINI_BOARD = {
  computed_at: "2026-11-26T18:06:00Z",
  unplaced_products: 1,
  properties: [
    { slug: "nba", name: "NBA", heading: "leagues", category: "Basketball", team_league: "nba", sort_order: 20, products: 2, editions: 900, fmv_total_usd: "5000.5", listed_editions: 10, sales_30d: 40, sales_30d_volume_usd: 700, first_season: "2021", last_season: "2025" },
    { slug: "bad-eggs", name: "Bad Eggs", heading: "entertainment", category: "Entertainment", team_league: null, sort_order: 210, products: 1, editions: 7, fmv_total_usd: 10, listed_editions: 1, sales_30d: 3, sales_30d_volume_usd: null, first_season: null, last_season: null },
  ],
  product_property: { b1: "nba", e1: "bad-eggs" },
}

beforeEach(() => {
  for (const k of Object.keys(rpcState)) delete rpcState[k]
  rpcCalls.length = 0
})
afterEach(cleanup)

describe("CandyPropertyGrid (server wrapper)", () => {
  it("a failed read renders nothing — never an empty 'What Candy covers'", async () => {
    rpcState.get_candy_property_board = { data: null, error: { message: "canceling statement due to statement timeout" } }
    expect(await CandyPropertyGrid({ collection: "candy-mlb" })).toBeNull()
    expect(rpcCalls).toEqual(["get_candy_property_board"])
  })
  it("a wrong-shaped answer is a failed read too", async () => {
    rpcState.get_candy_property_board = { data: { properties: "nope" }, error: null }
    expect(await CandyPropertyGrid({ collection: "candy-mlb" })).toBeNull()
  })
  it("a good read renders the tiles under both headings and the board's unplaced count", async () => {
    rpcState.get_candy_property_board = { data: CANDY_BOARD, error: null }
    const el = await CandyPropertyGrid({ collection: "candy-mlb" })
    expect(el).not.toBeNull()
    const c = render(el as React.ReactElement).container
    expect(c.querySelector('[data-testid="candy-property-mlb"]')!.getAttribute("href")).toBe("/candy-mlb/property/mlb")
    expect(c.querySelector('[data-testid="candy-property-group-entertainment"]')!.textContent).toContain("DC")
    expect(c.querySelector('[data-testid="candy-property-dc"]')!.textContent).toContain("no sale on record in 90 days")
    expect(c.querySelector('[data-testid="candy-property-unplaced"]')!.textContent).toContain("2 more collections are not placed")
    expect(c.textContent).not.toMatch(/propert/i)
  })
})

describe("PaniniPropertyGrid (server wrapper)", () => {
  it("a failed read renders nothing — never an empty 'What Panini covers'", async () => {
    rpcState.get_panini_property_board = { data: null, error: { message: "boom" } }
    expect(await PaniniPropertyGrid({ collection: "panini-blockchain" })).toBeNull()
    expect(rpcCalls).toEqual(["get_panini_property_board"])
  })
  it("a good read renders a tile per league and brand", async () => {
    rpcState.get_panini_property_board = { data: PANINI_BOARD, error: null }
    const el = await PaniniPropertyGrid({ collection: "panini-blockchain" })
    expect(el).not.toBeNull()
    const text = render(el as React.ReactElement).container.textContent ?? ""
    expect(text).toContain("NBA")
    expect(text).toContain("Bad Eggs")
    expect(text).not.toMatch(/propert/i)
  })
})
