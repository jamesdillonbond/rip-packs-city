import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/pinnacle-set-progress — the Disney Pinnacle Set Tracker backend.
 *
 * The arms that matter here are the ones stated as the ABSENCE of a false
 * claim, per CLAUDE.md: a truncated catalog read must not surface as a set
 * that looks finished, a truncated holdings read must not surface as a set
 * that looks unstarted, and a stale floor map must not surface as a cost to
 * finish. Each of those failures produces a perfectly well-formed number, so
 * a test that only checks the happy path cannot see any of them.
 */

type Row = Record<string, any>

// What each table answers, page by page. `catalogPages`/`ownedPages` are
// consumed in order; the last page repeats if the route asks for more.
const state: {
  catalogPages: Array<{ data: Row[] | null; error: any }>
  ownedPages: Array<{ data: Row[] | null; error: any }>
} = { catalogPages: [], ownedPages: [] }

const calls: { catalog: number; owned: number } = { catalog: 0, owned: 0 }

vi.mock("@/lib/supabase", () => {
  function builder(table: string) {
    const b: any = {
      select: () => b,
      eq: () => b,
      not: () => b,
      order: () => b,
      range: () => b,
      then: (resolve: any) => {
        if (table === "pinnacle_catalog") {
          const i = Math.min(calls.catalog, state.catalogPages.length - 1)
          calls.catalog++
          return resolve(state.catalogPages[i] ?? { data: [], error: null })
        }
        const i = Math.min(calls.owned, state.ownedPages.length - 1)
        calls.owned++
        return resolve(state.ownedPages[i] ?? { data: [], error: null })
      },
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { GET, PINNACLE_FLOOR_MAP_STALE_HOURS } from "@/app/api/pinnacle-set-progress/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const FRESH = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const STALE = new Date(
  Date.now() - (PINNACLE_FLOOR_MAP_STALE_HOURS + 6) * 3_600_000,
).toISOString()

function render(renderId: string, over: Row = {}): Row {
  return {
    render_id: renderId,
    set_render_id: "OEV1-TOYS",
    set_name: "Pixar Animation Studios • Toy Story Vol.1",
    character_name: renderId,
    variant: "Standard",
    total_minted: 100,
    thumbnail_url: null,
    floor_ask: 10,
    floor_ask_updated_at: FRESH,
    fmv_usd: 9,
    fmv_confidence: "MEDIUM",
    series_name: "2023",
    ...over,
  }
}

function page(rows: Row[]) {
  return { data: rows, error: null }
}

/** A full 1,000-row page — what a truncating read looks like from here. */
function fullPage() {
  return page(Array.from({ length: 1000 }, (_, i) => render(`R${i}`)))
}

beforeEach(() => {
  calls.catalog = 0
  calls.owned = 0
  state.catalogPages = [page([])]
  state.ownedPages = [page([])]
})

describe("GET /api/pinnacle-set-progress", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/pinnacle-set-progress"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("counts owned / missing per set and prices the remainder from the floor map", async () => {
    state.catalogPages = [page([render("A"), render("B"), render("C", { floor_ask: 25 })])]
    state.ownedPages = [page([{ id: "1", render_id: "A", serial_number: 7, is_locked: false }])]

    const res = await GET(req("https://t/api/pinnacle-set-progress?wallet=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.resolvedAddress).toBe("0xabc")
    expect(body.totalSets).toBe(1)
    const s = body.sets[0]
    expect(s.setId).toBe("OEV1-TOYS")
    expect(s.totalEditions).toBe(3)
    expect(s.ownedCount).toBe(1)
    expect(s.missingCount).toBe(2)
    expect(s.completionPct).toBe(33)
    expect(s.totalMissingCost).toBe(35)
    expect(s.lowestSingleAsk).toBe(10)
    expect(s.asksEnriched).toBe(true)
    // Every missing piece carries an ask, so the bill is the whole bill.
    expect(s.costConfidence).toBe("high")
  })

  it("keys sets on set_render_id, not on set_name — whitespace must not split a set", async () => {
    state.catalogPages = [
      page([
        render("A", { set_name: " Toy Story Vol.1" }),
        render("B", { set_name: "Toy Story Vol.1 " }),
      ]),
    ]
    const body = await (await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))).json()
    expect(body.totalSets).toBe(1)
    expect(body.sets[0].totalEditions).toBe(2)
    // The label is trimmed, so the two spellings cannot render as two names.
    expect(body.sets[0].setName).toBe("Toy Story Vol.1")
  })

  it("reports a fully-owned set as complete", async () => {
    state.catalogPages = [page([render("A"), render("B")])]
    state.ownedPages = [
      page([
        { id: "1", render_id: "A", serial_number: 1, is_locked: false },
        { id: "2", render_id: "B", serial_number: 2, is_locked: true },
      ]),
    ]
    const body = await (await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))).json()
    const s = body.sets[0]
    expect(s.completionPct).toBe(100)
    expect(s.tier).toBe("complete")
    expect(body.completeSets).toBe(1)
    expect(s.lockedOwnedCount).toBe(1)
    expect(s.tradeableOwnedCount).toBe(1)
  })

  // ── The three arms stated as the absence of a false claim ────────────────

  it("REFUSES rather than shipping an inflated completion when the catalog read truncates", async () => {
    // 10 full pages = maxPages hit = a checklist we know is short. A short
    // checklist makes every set look MORE complete than it is.
    state.catalogPages = [fullPage()]
    state.ownedPages = [page([])]

    const res = await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.sets).toBeUndefined()
    expect(body.retryable).toBe(true)
  })

  it("REFUSES rather than under-counting holdings when the wallet read truncates", async () => {
    state.catalogPages = [page([render("A")])]
    state.ownedPages = [
      page(Array.from({ length: 1000 }, (_, i) => ({ id: `w${i}`, render_id: "A", serial_number: i, is_locked: false }))),
    ]

    const res = await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))
    expect(res.status).toBe(503)
    expect((await res.json()).sets).toBeUndefined()
  })

  it("quotes NO cost when the floor map is past its own staleness window", async () => {
    state.catalogPages = [page([render("A", { floor_ask_updated_at: STALE }), render("B", { floor_ask_updated_at: STALE })])]
    state.ownedPages = [page([{ id: "1", render_id: "A", serial_number: 1, is_locked: false }])]

    const body = await (await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))).json()
    const s = body.sets[0]
    expect(s.asksEnriched).toBe(false)
    expect(s.totalMissingCost).toBeNull()
    expect(s.lowestSingleAsk).toBeNull()
    expect(s.costConfidence).toBe("low")
    // …and the tier must say so rather than claiming a reachable set.
    expect(s.tier).toBe("unpriced")
    // The stamp is still reported, so a reader can see WHY.
    expect(body.asksAsOf).toBe(STALE)
  })

  it("treats a missing ask as unknown, never as free", async () => {
    state.catalogPages = [page([render("A"), render("B", { floor_ask: null })])]
    state.ownedPages = [page([])]
    const s = (await (await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))).json()).sets[0]
    expect(s.missingCount).toBe(2)
    expect(s.listedCount).toBe(1)
    expect(s.totalMissingCost).toBe(10) // the one real ask, not 10 + 0
    expect(s.costConfidence).toBe("mixed")
  })

  it("never publishes a driver message on a read error", async () => {
    state.catalogPages = [{ data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }]
    const res = await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toMatch(/canceling statement/i)
    expect(body.retryable).toBe(true)
  })

  // 🔄 RE-PINNED 2026-09-20 when the Pinnacle edition page moved into the
  // collection namespace. The property is unchanged — link to the CANONICAL
  // URL, never to one that redirects — only the canonical moved.
  it("links a piece to the canonical edition page, not the retired redirecting URL", async () => {
    state.catalogPages = [page([render("OEV1-TOYS-BUZZ-S4B")])]
    state.ownedPages = [page([])]
    const s = (await (await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))).json()).sets[0]
    expect(s.missing[0].topshotUrl).toBe("/disney-pinnacle/edition/OEV1-TOYS-BUZZ-S4B")
    expect(s.missing[0].topshotUrl).not.toMatch(/^\/pinnacle\/moment\//)
  })

  it("puts the Pinnacle VARIANT in the tier slot (Pinnacle has no tiers)", async () => {
    state.catalogPages = [page([render("A", { variant: "Luxe Marble" })])]
    state.ownedPages = [page([])]
    const s = (await (await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))).json()).sets[0]
    expect(s.missing[0].tier).toBe("LUXE MARBLE")
  })

  it("never renders the word Unknown for a pin with no character name", async () => {
    state.catalogPages = [page([render("A", { character_name: null })])]
    state.ownedPages = [page([])]
    const s = (await (await GET(req("https://t/api/pinnacle-set-progress?wallet=0xabc"))).json()).sets[0]
    expect(s.missing[0].playerName).not.toMatch(/unknown/i)
  })
})
