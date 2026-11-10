import { describe, it, expect, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { resolveLiveAsks } from "@/lib/asks/edition-live-ask"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

// lib/asks/edition-live-ask.ts — the binder's live ask (#182, 2026-10-10). The rule
// is get_team_checklist's: All Day floor, then edition_offers, then badge_editions
// (both <= 7 d), Candy's confirmed floor; an ask counts only with an FMV and only
// when <= 3x it. A failed read is REPORTED and never becomes "no ask".

const TS = COLLECTION_UUID_BY_SLUG["nba-top-shot"]
const AD = COLLECTION_UUID_BY_SLUG["nfl-all-day"]

type Rows = Record<string, { data?: unknown[]; error?: { message: string } | null }>

function db(rows: Rows) {
  return {
    from(table: string) {
      const res = rows[table] ?? { data: [], error: null }
      const b: Record<string, unknown> = {}
      for (const m of ["select", "eq", "in", "gt", "lt", "order", "limit"]) b[m] = () => b
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: res.data ?? [], error: res.error ?? null }).then(ok)
      return b
    },
    rpc(fn: string) {
      const res = rows[fn] ?? { data: [], error: null }
      return Promise.resolve({ data: res.data ?? [], error: res.error ?? null })
    },
  }
}

const EDS = [
  { id: "e1", external_id: "1:1" },
  { id: "e2", external_id: "2:2" },
  { id: "e3", external_id: "3:3" },
]

describe("resolveLiveAsks", () => {
  it("takes edition_offers before badge_editions, and only asks connected to FMV (<= 3x)", async () => {
    const { asks, errors } = await resolveLiveAsks(db({
      editions: { data: EDS },
      edition_fmv_current: { data: [{ edition_id: "e1", fmv_usd: 10 }, { edition_id: "e2", fmv_usd: 10 }, { edition_id: "e3", fmv_usd: 10 }] },
      edition_offers: { data: [{ external_id: "1:1", low_ask: 8 }, { external_id: "2:2", low_ask: 45 }] },
      badge_editions: { data: [{ external_id: "1:1", low_ask: 5 }, { external_id: "2:2", low_ask: 12 }] },
    }), TS, ["1:1", "2:2", "3:3"])
    expect(errors).toEqual([])
    expect(asks.get("1:1")).toEqual({ ask: 8, source: "edition_offers" }) // priority, even though badge is lower
    expect(asks.get("2:2")).toEqual({ ask: 12, source: "badge_editions" }) // 45 > 3x FMV is a troll ask: falls through
    expect(asks.has("3:3")).toBe(false) // no ask anywhere
  })

  it("an edition with NO FMV gets no ask (the lone-ask troll shape stays unpriced)", async () => {
    const { asks } = await resolveLiveAsks(db({
      editions: { data: [EDS[0]] },
      edition_fmv_current: { data: [] },
      edition_offers: { data: [{ external_id: "1:1", low_ask: 8 }] },
    }), TS, ["1:1"])
    expect(asks.size).toBe(0)
  })

  it("All Day's live floor outranks the GQL tables", async () => {
    const { asks } = await resolveLiveAsks(db({
      editions: { data: [EDS[0]] },
      edition_fmv_current: { data: [{ edition_id: "e1", fmv_usd: 10 }] },
      allday_edition_floor_ask: { data: [{ edition_id: "e1", floor_ask: 9 }] },
      edition_offers: { data: [{ external_id: "1:1", low_ask: 7 }] },
    }), AD, ["1:1"])
    expect(asks.get("1:1")).toEqual({ ask: 9, source: "allday_floor" })
  })

  it("the All Day leg is never read for another collection", async () => {
    const { asks } = await resolveLiveAsks(db({
      editions: { data: [EDS[0]] },
      edition_fmv_current: { data: [{ edition_id: "e1", fmv_usd: 10 }] },
      allday_edition_floor_ask: { data: [{ edition_id: "e1", floor_ask: 9 }] },
    }), TS, ["1:1"])
    expect(asks.size).toBe(0)
  })

  it("a failed source read is REPORTED, and the keys it would have answered stay absent", async () => {
    const { asks, errors } = await resolveLiveAsks(db({
      editions: { data: [EDS[0]] },
      edition_fmv_current: { data: [{ edition_id: "e1", fmv_usd: 10 }] },
      edition_offers: { error: { message: "timeout" } },
      badge_editions: { data: [] },
    }), TS, ["1:1"])
    expect(asks.size).toBe(0)
    expect(errors.some((e) => e.includes("edition_offers"))).toBe(true)
  })
})

describe("resolveLiveAsks — Panini's confirmed ask (2026-10-19)", () => {
  const PN = COLLECTION_UUID_BY_SLUG["panini-blockchain"]
  const PE = [{ id: "p1", external_id: "packcard-1_1_1_1" }, { id: "p2", external_id: "packcard-2_2_2_2" }]
  it("reads the board's confirmed ask (keyed RPC) as priority 1, under the 3x FMV gate", async () => {
    const { asks, errors } = await resolveLiveAsks(db({
      editions: { data: PE },
      edition_fmv_current: { data: [{ edition_id: "p1", fmv_usd: 20 }, { edition_id: "p2", fmv_usd: 20 }] },
      panini_confirmed_low_asks: { data: [{ external_id: "packcard-1_1_1_1", low_ask_usd: 15 }, { external_id: "packcard-2_2_2_2", low_ask_usd: 70 }] },
      edition_offers: { data: [{ external_id: "packcard-1_1_1_1", low_ask: 12 }] },
    }), PN, ["packcard-1_1_1_1", "packcard-2_2_2_2"])
    expect(errors).toEqual([])
    expect(asks.get("packcard-1_1_1_1")).toEqual({ ask: 15, source: "panini_confirmed_ask" })
    expect(asks.has("packcard-2_2_2_2")).toBe(false) // 70 > 3x20
  })
  it("the Panini board is never read for another collection", async () => {
    const { asks } = await resolveLiveAsks(db({
      editions: { data: [EDS[0]] },
      edition_fmv_current: { data: [{ edition_id: "e1", fmv_usd: 10 }] },
      panini_confirmed_low_asks: { data: [{ external_id: "1:1", low_ask_usd: 5 }] },
    }), TS, ["1:1"])
    expect(asks.has("1:1")).toBe(false)
  })
  it("a failed Panini board read is reported, never 'no ask'", async () => {
    const { asks, errors } = await resolveLiveAsks(db({
      editions: { data: PE },
      edition_fmv_current: { data: [{ edition_id: "p1", fmv_usd: 20 }] },
      panini_confirmed_low_asks: { error: { message: "boom" } },
    }), PN, ["packcard-1_1_1_1"])
    expect(asks.size).toBe(0)
    expect(errors.some((e) => e.startsWith("panini_market_board"))).toBe(true)
  })
})

describe("panini_confirmed_low_asks keeps panini_market_board's ask rule (2026-11-10)", () => {
  // The resolver reads Panini asks through a keyed RPC because the view's `.in()` aggregated every
  // listed serial. The RPC is only honest while it applies the VIEW's rule: listed, priced > 0,
  // re-confirmed within 7 days, minimum price. Read from the newest migration defining each.
  const dir = join(process.cwd(), "supabase", "migrations")
  const newest = (needle: string) => {
    const f = readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()
      .filter((x) => readFileSync(join(dir, x), "utf8").includes(needle))
    return readFileSync(join(dir, f[f.length - 1]), "utf8")
  }
  it("the RPC carries the view's four predicates and the min()", () => {
    const fn = newest("FUNCTION public.panini_confirmed_low_asks")
    const body = fn.slice(fn.indexOf("AS $$"), fn.lastIndexOf("$$"))
    expect(body).toContain("s.is_listed")
    expect(body).toMatch(/s\.price_usd > 0(::numeric)?/)
    expect(body).toContain("s.captured_at > (now() - '7 days'::interval)")
    expect(body).toContain("min(s.price_usd)")
    expect(body).toContain("d1a0a7f5-609a-49f4-a1a7-4eaac55b020b")
  })
  it("the resolver calls the RPC, not the view's .in()", () => {
    const src = stripComments(readFileSync(join(process.cwd(), "lib", "asks", "edition-live-ask.ts"), "utf8"))
    expect(src).toContain('db.rpc("panini_confirmed_low_asks"')
    expect(src).not.toMatch(/from\("panini_market_board"\)[^\n]*\.in\(/)
  })
})

describe("resolveLiveAsks freshness column", () => {
  it("judges edition_offers by low_ask_confirmed_at (when the ask was SEEN) and badge_editions by updated_at", async () => {
    const gts: Array<[string, string]> = []
    const rec = {
      from(table: string) {
        const b: Record<string, unknown> = {}
        for (const m of ["select", "eq", "in", "lt", "order", "limit"]) b[m] = () => b
        b.gt = (col: string) => { gts.push([table, col]); return b }
        b.then = (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: table === "editions" ? [EDS[0]] : [], error: null }).then(ok)
        return b
      },
    }
    await resolveLiveAsks(rec, TS, ["1:1"])
    expect(gts).toContainEqual(["edition_offers", "low_ask_confirmed_at"])
    expect(gts).not.toContainEqual(["edition_offers", "updated_at"])
    expect(gts).toContainEqual(["badge_editions", "updated_at"])
  })
})

describe("POST /api/best-asks", () => {
  it("refuses an unknown collection (no substitution) and a bad body", async () => {
    vi.resetModules()
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: db({}) }))
    const { POST } = await import("@/app/api/best-asks/route")
    const req = (body: unknown, bad = false) => ({ json: async () => { if (bad) throw new Error("x"); return body } }) as never
    expect((await POST(req({ collectionId: "not-a-collection", editionKeys: ["1:1"] }))).status).toBe(400)
    expect((await POST(req({ collectionId: "constructor", editionKeys: ["1:1"] }))).status).toBe(400)
    expect((await POST(req(null, true))).status).toBe(400)
    const empty = await POST(req({ collectionId: TS, editionKeys: [] }))
    expect(await empty.json()).toEqual({ results: [], partial: false })
  })

  it("returns connected asks and flags a partial read", async () => {
    vi.resetModules()
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: db({
        editions: { data: [EDS[0], EDS[1]] },
        edition_fmv_current: { data: [{ edition_id: "e1", fmv_usd: 10 }, { edition_id: "e2", fmv_usd: 10 }] },
        edition_offers: { data: [{ external_id: "1:1", low_ask: 8 }] },
        badge_editions: { error: { message: "down" } },
      }),
    }))
    const { POST } = await import("@/app/api/best-asks/route")
    const res = await POST({ json: async () => ({ collectionId: TS, editionKeys: ["1:1", "2:2"] }) } as never)
    expect(await res.json()).toEqual({
      results: [{ editionKey: "1:1", ask: 8, askSource: "edition_offers" }],
      partial: true,
    })
  })
})
