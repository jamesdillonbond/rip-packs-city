import { describe, it, expect, beforeEach, vi } from "vitest"

// The `part=bio` arm of /api/entity/edition — the three player-bio facts that
// unlock `classifySerial`'s jersey_match / birthday_match / draft_year_match
// quirks in MomentDetailModal.
//
// Two properties carry the weight:
//
//  1. It is keyed on `editionKey` (= `editions.external_id`), NOT the route
//     slug every other part uses. `get_edition_detail` returns `route_slug` and
//     `external_id` as SEPARATE fields, so reusing the slug param here would
//     silently miss on any edition whose two forms differ.
//  2. An absent row and a failed read must not look the same. Absent is a real
//     answer (Pinnacle lives in `pinnacle_editions`; only Top Shot has a bio
//     source at all) and is a 200 with nulls; a failed read is an error, because
//     the caller renders both as "fewer chips" and could never tell them apart.

const table: { rows: Record<string, unknown> | null; error: { message: string } | null } = {
  rows: null,
  error: null,
}
const from: Array<{ table: string; select: string; eq: Array<[string, unknown]> }> = []

vi.mock("@/lib/supabase", () => {
  const builder = (t: string) => ({
    select(select: string) {
      const rec = { table: t, select, eq: [] as Array<[string, unknown]> }
      from.push(rec)
      const chain: any = {
        eq(col: string, val: unknown) {
          rec.eq.push([col, val])
          return chain
        },
        maybeSingle: async () => ({ data: table.rows, error: table.error }),
      }
      return chain
    },
  })
  return {
    supabaseAdmin: { from: builder, rpc: async () => ({ data: [], error: null }) },
    supabase: { from: builder, rpc: async () => ({ data: [], error: null }) },
  }
})

import { GET } from "@/app/api/entity/edition/route"

const req = (qs: string) => new Request("https://t/api/entity/edition?" + qs)
const BASE = "collection=nba-top-shot&part=bio"

beforeEach(() => {
  from.length = 0
  table.rows = null
  table.error = null
})

describe("GET /api/entity/edition?part=bio", () => {
  it("reads the three bio columns off `editions`, scoped by collection AND edition key", async () => {
    table.rows = { jersey_number: 0, player_birthdate: null, player_draft_year: null }
    const res = await GET(req(BASE + "&editionKey=5%3A145"))
    expect(res.status).toBe(200)

    expect(from[0].table).toBe("editions")
    expect(from[0].select).toContain("jersey_number")
    expect(from[0].select).toContain("player_birthdate")
    expect(from[0].select).toContain("player_draft_year")
    // Both filters are load-bearing: `external_id` is not unique across
    // collections, so an unscoped lookup can resolve another chain's edition.
    expect(from[0].eq).toContainEqual(["collection_id", "95f28a17-224a-4025-96ad-adf8a4c63bfd"])
    expect(from[0].eq).toContainEqual(["external_id", "5:145"])
  })

  it("maps the row onto the camelCase shape the classifier context expects", async () => {
    table.rows = { jersey_number: 7, player_birthdate: "1990-07-06", player_draft_year: 2012 }
    const body = await (await GET(req(BASE + "&editionKey=5%3A145"))).json()
    expect(body).toEqual({ jerseyNumber: 7, birthdate: "1990-07-06", draftYear: 2012 })
  })

  it("returns nulls (200) for an edition we simply hold no bio for", async () => {
    // Not an error: Pinnacle is not in `editions` at all, and every non-Top-Shot
    // collection has no bio source, so a miss is the common case.
    table.rows = null
    const res = await GET(req(BASE + "&editionKey=nope"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jerseyNumber: null, birthdate: null, draftYear: null })
  })

  it("coerces a numeric-looking column rather than leaking a string into the classifier", async () => {
    // `classifySerial` compares the jersey numerically; a string would never match.
    table.rows = { jersey_number: "05", player_birthdate: null, player_draft_year: "2012" }
    const body = await (await GET(req(BASE + "&editionKey=5%3A145"))).json()
    expect(body.jerseyNumber).toBe(5)
    expect(body.draftYear).toBe(2012)
  })

  it("rejects a non-string birthdate instead of passing it through", async () => {
    table.rows = { jersey_number: null, player_birthdate: 19900706, player_draft_year: null }
    const body = await (await GET(req(BASE + "&editionKey=5%3A145"))).json()
    expect(body.birthdate).toBeNull()
  })

  it("errors on a failed read rather than answering with three nulls", async () => {
    // ⚠ The whole point of the split: all-null is what an edition WITHOUT a bio
    // returns, so publishing it on a failed read makes an outage indistinguishable
    // from a real answer.
    table.error = { message: "canceling statement due to statement timeout" }
    const res = await GET(req(BASE + "&editionKey=5%3A145"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.jerseyNumber).toBeUndefined()
    // And never the driver's own wording.
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("caches — a bio is a catalog fact, not a price", async () => {
    table.rows = { jersey_number: 7, player_birthdate: null, player_draft_year: null }
    const res = await GET(req(BASE + "&editionKey=5%3A145"))
    expect(res.headers.get("Cache-Control")).toContain("s-maxage")
  })

  it("400s a missing editionKey and 404s an unknown collection, without querying", async () => {
    expect((await GET(req(BASE))).status).toBe(400)
    expect((await GET(req("collection=nope&part=bio&editionKey=5%3A145"))).status).toBe(404)
    expect(from).toHaveLength(0)
  })

  it("does not require the `slug` param the other parts key on", async () => {
    // If bio were dispatched after the shared slug guard it would 400 here, and
    // the modal has an edition key but no route slug.
    table.rows = { jersey_number: 7, player_birthdate: null, player_draft_year: null }
    expect((await GET(req(BASE + "&editionKey=5%3A145"))).status).toBe(200)
  })

  it("leaves the slug guard in place for every other part", async () => {
    expect((await GET(req("collection=nba-top-shot&part=fmv-history"))).status).toBe(400)
    expect((await GET(req("collection=nba-top-shot&part=sales"))).status).toBe(400)
  })
})
