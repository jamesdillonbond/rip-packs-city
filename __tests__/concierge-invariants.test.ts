import { describe, it, expect } from "vitest"
import {
  fetchUnifiedFmvDistribution,
  fetchPinnacleFmvDistribution,
} from "@/lib/concierge/fmv-distribution"
import { searchPinnacleDeals, getPinnacleFmv } from "@/lib/concierge/pinnacle-router"

// Regression pins for the CLAUDE.md concierge non-negotiables that live in
// importable helpers (lib/concierge/fmv-distribution.ts + pinnacle-router.ts):
//   (a) Pinnacle FMV filters by the character_name / set_name / variant triple,
//       never a bare edition_key.
//   (b) editions.tier is filtered with .eq(UPPERCASE), never .ilike (enum).
//   (c) the unified get_fmv path reads BOTH editions and FMV (the bulk
//       distribution via the get_editions_latest_fmv RPC — a per-id LATERAL
//       LIMIT 1 that dodges the 1000-row clamp WITHOUT the full DISTINCT ON
//       pass that filtering the fmv_current view by key forced; the single
//       editionKey lookup via fmv_snapshots + limit(1)).
// A recording fake Supabase client captures every from()/filter call so the
// exact table + method + args are asserted.

interface Call {
  table: string
  method: string
  args: any[]
}

function makeRecorder(results: Record<string, any>) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const rec = (method: string) => (...args: any[]) => {
        calls.push({ table, method, args })
        return builder
      }
      const builder: any = {
        maybeSingle: async () => {
          calls.push({ table, method: "maybeSingle", args: [] })
          return results[`${table}:single`] ?? { data: null, error: null }
        },
        then: (resolve: any) => {
          const r = results[table] ?? { data: [], error: null }
          // The unified path also takes an exact head count over the same
          // filter; serve a count that agrees with the rows.
          return resolve(Array.isArray(r.data) ? { ...r, count: r.data.length } : r)
        },
      }
      for (const m of [
        "select", "not", "neq", "eq", "ilike", "in", "order", "limit", "lte", "gte", "gt",
      ]) {
        builder[m] = rec(m)
      }
      return builder
    },
    rpc(name: string, args: any) {
      calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] })
      return Promise.resolve(results[name] ?? { data: [], error: null })
    },
  }
  return { client, calls }
}

const has = (calls: Call[], table: string, method: string, argMatch?: (a: any[]) => boolean) =>
  calls.some((c) => c.table === table && c.method === method && (!argMatch || argMatch(c.args)))

describe("(c) unified get_fmv reads editions + fmv (current/snapshots)", () => {
  it("queries editions AND the latest-FMV RPC, scoped to the matched ids", async () => {
    const { client, calls } = makeRecorder({
      editions: {
        data: [
          { id: "e1", external_id: "1:1", player_name: "LeBron James", set_name: "Base", tier: "COMMON" },
          { id: "e2", external_id: "1:2", player_name: "LeBron James", set_name: "Base", tier: "COMMON" },
        ],
        error: null,
      },
      get_editions_latest_fmv: {
        data: [
          { edition_id: "e1", fmv_usd: 10, confidence: "HIGH", computed_at: "2026-07-12T00:00:00Z" },
          { edition_id: "e2", fmv_usd: 20, confidence: "HIGH", computed_at: "2026-07-11T00:00:00Z" },
        ],
        error: null,
      },
    })
    const res = await fetchUnifiedFmvDistribution(client as any, {
      collectionUuid: "uuid-ts",
      player: "LeBron",
    })
    expect(has(calls, "editions", "select")).toBe(true)
    // ⛔ The bulk FMV read must go through the RPC, NOT a fmv_current select.
    // A qual on edition_id DOES reach the view's index - the cost is that the
    // view has no per-group LIMIT, so it reads every snapshot per edition and
    // Unique discards the rest. Measured 2026-09-02 for 500 ids: 25,330 buffers
    // warm (42,342 cold on a heavier id set) against 2,002-5,359 for the per-id
    // LATERAL LIMIT 1, which was the difference between an answer and a
    // timed-out FMV lookup inside the 60 s lambda.
    // ⛔ RETRACTED from this comment: "does not push down", and 1,334,789 /
    // 16.7 s / 249x - a benchmark arm written as IN (SELECT ...), which is not
    // a shape PostgREST sends. Measure the shape the client actually sends.
    expect(has(calls, "rpc:get_editions_latest_fmv", "rpc")).toBe(true)
    expect(has(calls, "fmv_current", "select")).toBe(false)
    // and it must still be scoped to exactly the matched edition ids
    expect(
      has(calls, "rpc:get_editions_latest_fmv", "rpc", (a) =>
        Array.isArray(a[0]?.p_edition_ids) &&
        a[0].p_edition_ids.includes("e1") &&
        a[0].p_edition_ids.includes("e2"),
      ),
    ).toBe(true)
    expect(res.status).toBe("ok")
    expect((res as any).mode).toBe("distribution")
  })

  it("editionKey path reads editions (external_id) then fmv_snapshots", async () => {
    const { client, calls } = makeRecorder({
      "editions:single": {
        data: { id: "e9", external_id: "73:2785", player_name: "Dame", set_name: "Base", tier: "RARE" },
        error: null,
      },
      "fmv_snapshots:single": {
        data: { fmv_usd: 42, confidence: "HIGH", computed_at: "2026-07-12T00:00:00Z" },
        error: null,
      },
    })
    const res = await fetchUnifiedFmvDistribution(client as any, {
      collectionUuid: "uuid-ts",
      editionKey: "73:2785",
    })
    expect(has(calls, "editions", "eq", (a) => a[0] === "external_id" && a[1] === "73:2785")).toBe(true)
    expect(has(calls, "fmv_snapshots", "eq", (a) => a[0] === "edition_id")).toBe(true)
    expect(res.status).toBe("ok")
    expect((res as any).mode).toBe("single")
  })
})

describe("(b) tier filter uses .eq(UPPERCASE), never .ilike on the enum", () => {
  it("passes a lowercased tier as .eq('tier','COMMON') and never .ilike('tier',...)", async () => {
    const { client, calls } = makeRecorder({
      editions: { data: [], error: null },
    })
    await fetchUnifiedFmvDistribution(client as any, {
      collectionUuid: "uuid-ts",
      tier: "common",
    })
    expect(has(calls, "editions", "eq", (a) => a[0] === "tier" && a[1] === "COMMON")).toBe(true)
    // The enum footgun: an ilike on tier silently matches nothing.
    expect(has(calls, "editions", "ilike", (a) => a[0] === "tier")).toBe(false)
  })
})

describe("(a) Pinnacle FMV filters by character/set/variant, never a bare edition_key", () => {
  it("fetchPinnacleFmvDistribution filters pinnacle_catalog by the triple", async () => {
    const { client, calls } = makeRecorder({
      pinnacle_catalog: { data: [], error: null },
    })
    await fetchPinnacleFmvDistribution(client as any, {
      character: "Mickey",
      setName: "Steamboat",
      variant: "Golden",
    })
    expect(has(calls, "pinnacle_catalog", "ilike", (a) => a[0] === "character_name")).toBe(true)
    expect(has(calls, "pinnacle_catalog", "ilike", (a) => a[0] === "set_name")).toBe(true)
    expect(has(calls, "pinnacle_catalog", "ilike", (a) => a[0] === "variant")).toBe(true)
    // Character-level query must NOT be keyed off legacy_edition_key alone.
    expect(has(calls, "pinnacle_catalog", "eq", (a) => a[0] === "legacy_edition_key")).toBe(false)
  })

  it("searchPinnacleDeals filters character_name + variant (not player_name/tier)", async () => {
    const { client, calls } = makeRecorder({
      pinnacle_catalog: { data: [], error: null },
    })
    await searchPinnacleDeals(client as any, { player: "Elsa", tier: "Silver" })
    expect(has(calls, "pinnacle_catalog", "ilike", (a) => a[0] === "character_name")).toBe(true)
    expect(has(calls, "pinnacle_catalog", "ilike", (a) => a[0] === "variant")).toBe(true)
    // Pinnacle has no player_name / enum tier column — never queried.
    expect(has(calls, "pinnacle_catalog", "ilike", (a) => a[0] === "player_name")).toBe(false)
    expect(has(calls, "pinnacle_catalog", "ilike", (a) => a[0] === "tier")).toBe(false)
  })

  it("getPinnacleFmv by character queries character_name on pinnacle_catalog", async () => {
    const { client, calls } = makeRecorder({
      pinnacle_catalog: { data: [], error: null },
    })
    const out = await getPinnacleFmv(client as any, { playerName: "Stitch" })
    expect(has(calls, "pinnacle_catalog", "ilike", (a) => a[0] === "character_name")).toBe(true)
    // no rows → not_found status (never blends across characters)
    expect(JSON.parse(out).status).toBe("not_found")
  })

  it("getPinnacleFmv by editionKey collapses to the most-traded render (set-level key)", async () => {
    // legacy_edition_key spans characters; the helper must collapse to a single
    // representative render + surface the spread, never blend the whole key.
    const { client } = makeRecorder({
      pinnacle_catalog: {
        data: [
          { render_id: "r1", character_name: "A", set_name: "S", variant: "Gold", legacy_edition_key: "K", fmv_usd: 30, fmv_confidence: "HIGH", fmv_sales_count_30d: 12, fmv_wap_usd: 28, floor_ask: 25 },
          { render_id: "r2", character_name: "B", set_name: "S", variant: "Gold", legacy_edition_key: "K", fmv_usd: 90, fmv_confidence: "LOW", fmv_sales_count_30d: 2, fmv_wap_usd: 80, floor_ask: 70 },
        ],
        error: null,
      },
    })
    const out = JSON.parse(await getPinnacleFmv(client as any, { editionKey: "K" }))
    expect(out.status).toBe("ok")
    // most-traded (12 sales) render wins, not the higher-FMV one
    expect(out.fmv).toBe(30)
    expect(out.player).toBe("A")
    expect(out.fmv_render_range).toEqual({ min: 30, max: 90, renders: 2 })
  })
})
