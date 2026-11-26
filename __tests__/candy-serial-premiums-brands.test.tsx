import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

// 2026-11-26: /insights/candy-serial-premiums lists sales from more than one brand (MLB and DC). Each row names
// its brand from the card's own set. Pins: a failed brand lookup names NO brand (never a guessed one) and still
// shows every sale; one brand gets no "In this list" line; the URL word never reaches the page.

type Res = { data: unknown; error: unknown }
let rpcResult: Res
let tables: Record<string, () => Res>
vi.mock("@/lib/supabase", () => {
  const chain = (name: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ["select", "eq", "in", "not", "order", "limit", "neq"]) q[m] = () => q
    q.then = (ok: (r: Res) => unknown, bad: (e: unknown) => unknown) => {
      try { return Promise.resolve(tables[name]()).then(ok, bad) } catch (e) { return Promise.reject(e).then(ok, bad) }
    }
    return q
  }
  const admin = { rpc: async () => rpcResult, from: (name: string) => chain(name) }
  return { supabaseAdmin: admin, supabase: admin }
})

import SerialPage from "@/app/insights/candy-serial-premiums/page"
import { readCandyEditionBrands } from "@/lib/candy/properties"

const row = (external_id: string, name: string, set_name: string) => ({
  external_id, name, set_name, tier: "COMMON", circulation_count: 225, serial_number: 1, band: "first", price_usd: 20,
  sold_at: "2026-11-23T20:18:43Z", n_comps: 6, comp_median_usd: 2, multiplier: 10,
})
const ROWS = [row("judge", "Aaron Judge", "2026 MLB Base Series ICONs"), row("ohtani", "Shohei Ohtani", "2026 MLB Base Series ICONs"), row("batman-1", "Absolute Batman #1", "Absolute Batman (2024-) #1")]

beforeEach(() => {
  rpcResult = { data: { stats: [], rows: ROWS }, error: null }
  tables = {
    candy_collections: () => ({ data: [{ set_id: "set-mlb", property_slug: "mlb" }, { set_id: "set-dc", property_slug: "dc" }], error: null }),
    publisher_properties: () => ({ data: [{ slug: "mlb", name: "MLB", sort_order: 1 }, { slug: "dc", name: "DC", sort_order: 2 }], error: null }),
    editions: () => ({ data: [{ external_id: "judge", set_id: "set-mlb" }, { external_id: "ohtani", set_id: "set-mlb" }, { external_id: "batman-1", set_id: "set-dc" }], error: null }),
  }
})

describe("Candy serial premiums — each sale names its brand", () => {
  it("names the brand on every row and counts the brands in the list, linking each brand's page", async () => {
    const html = renderToStaticMarkup(await SerialPage())
    expect(html).toContain("2026 MLB Base Series ICONs · MLB")
    expect(html).toContain("Absolute Batman (2024-) #1 · DC")
    expect(html).toContain('data-testid="candy-serial-brands"')
    expect(html).toMatch(/href="\/candy-mlb\/property\/mlb"[^>]*>MLB<\/a> 2/)
    expect(html).toMatch(/href="\/candy-mlb\/property\/dc"[^>]*>DC<\/a> 1/)
    // "property" is a URL word only: strip tags (hrefs) and it must be gone.
    expect(html.replace(/<[^>]+>/g, " ").toLowerCase()).not.toContain("property")
  })

  it("a failed brand lookup names no brand, keeps every sale, and shows no brand line", async () => {
    tables.editions = () => ({ data: null, error: { message: "down" } })
    const html = renderToStaticMarkup(await SerialPage())
    expect(html).toContain("Aaron Judge")
    expect(html).toContain("Absolute Batman #1")
    expect(html).not.toContain("· MLB")
    expect(html).not.toContain("· DC")
    expect(html).not.toContain("candy-serial-brands")
  })

  it("one brand in the list gets its name on the rows but no 'In this list' line", async () => {
    rpcResult = { data: { stats: [], rows: ROWS.slice(0, 2) }, error: null }
    const html = renderToStaticMarkup(await SerialPage())
    expect(html).toContain("· MLB")
    expect(html).not.toContain("candy-serial-brands")
  })

  it("the lookup: unplaced keys are absent, a failed index is null, no keys asks nothing", async () => {
    tables.editions = () => ({ data: [{ external_id: "judge", set_id: "set-mlb" }, { external_id: "x", set_id: "set-unknown" }], error: null })
    expect(await readCandyEditionBrands(["judge", "x", "x", ""])).toEqual({ judge: { slug: "mlb", name: "MLB" } })
    tables.candy_collections = () => ({ data: null, error: { message: "down" } })
    expect(await readCandyEditionBrands(["judge"])).toBeNull()
    tables.candy_collections = () => { throw new Error("must not be read") }
    expect(await readCandyEditionBrands([])).toEqual({})
  })
})
