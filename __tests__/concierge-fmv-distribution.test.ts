import { describe, it, expect } from "vitest"
import {
  fetchUnifiedFmvDistribution,
  fetchPinnacleFmvDistribution,
} from "@/lib/concierge/fmv-distribution"

// Unit tests for lib/concierge/fmv-distribution.ts — the catalog-FMV shaping
// behind the support-chat tools. Covers the editionKey single-lookup branch,
// the filtered distribution (p10/p50/p90/min/max + recency-sorted samples),
// the single-match and no_results/empty branches, and query-error handling.
// PROJECT INVARIANT: the Pinnacle path must key by the TRIPLE
// (character_name, set_name, variant) — never legacy_edition_key alone — so the
// Pinnacle tests assert all three ilike filters reach the query builder.

// Fake supabase client. Records every from(table) chain call so we can assert
// the exact filter keying, and resolves terminal awaits / .maybeSingle() to
// per-table configured results.
function makeClient(results: Record<string, { single?: any; list?: any }>) {
  const calls: Array<{ table: string; chain: Array<[string, ...any[]]> }> = []
  const client: any = {
    calls,
    from(table: string) {
      const rec = { table, chain: [] as Array<[string, ...any[]]> }
      calls.push(rec)
      const b: any = {}
      for (const m of ["select", "eq", "neq", "in", "order", "limit", "is", "not", "ilike", "gte", "lt"]) {
        b[m] = (...args: any[]) => {
          rec.chain.push([m, ...args])
          return b
        }
      }
      b.maybeSingle = async () => results[table]?.single ?? { data: null, error: null }
      b.then = (resolve: any) => {
        const r = results[table]?.list ?? { data: null, error: null }
        // The unified path now also asks for an exact head count over the SAME
        // filter, to tell "N matched" from "N were read". Serve a count that
        // agrees with the rows so the stub cannot manufacture a truncation the
        // fixture does not have.
        return resolve(Array.isArray(r.data) ? { ...r, count: r.data.length } : r)
      }
      return b
    },
    // ⚠ Latest-FMV-per-edition is an RPC, not a view select. fmv_current is
    // DISTINCT ON (edition_id) with no per-group LIMIT, so reading 500 editions
    // through it makes Postgres read every snapshot row per edition and keep
    // only the newest — 25,330 buffers warm (42,342 cold on a heavier id set)
    // against 2,002-5,359 for the per-id LATERAL the RPC runs. Keying these
    // fixtures on the RPC name is what keeps this suite honest about which
    // read the code actually performs.
    // ⛔ The 1,334,789 / 249x this comment used to cite is RETRACTED: it was
    // measured with IN (SELECT ...), a subquery PostgREST never sends.
    rpc(name: string, args: any) {
      calls.push({ table: `rpc:${name}`, chain: [["rpc", args]] })
      return Promise.resolve(results[name]?.list ?? { data: null, error: null })
    },
  }
  return client
}

// chain helpers for assertions
function ilikeArgs(client: any, table: string): Array<[string, string]> {
  return client.calls
    .filter((c: any) => c.table === table)
    .flatMap((c: any) => c.chain)
    .filter((step: any[]) => step[0] === "ilike")
    .map((step: any[]) => [step[1], step[2]])
}

describe("fetchUnifiedFmvDistribution — editionKey path", () => {
  it("returns single-edition shape when the key + snapshot resolve", async () => {
    const client = makeClient({
      editions: { single: { data: { id: "e1", external_id: "8:133", player_name: "LeBron", set_name: "Base", tier: "COMMON" }, error: null } },
      fmv_snapshots: { single: { data: { fmv_usd: 42.5, confidence: "HIGH", computed_at: "2026-07-01T00:00:00Z" }, error: null } },
    })
    const out = await fetchUnifiedFmvDistribution(client, { collectionUuid: null, editionKey: "8:133" })
    expect(out).toEqual({
      status: "ok",
      mode: "single",
      edition: {
        edition_id: "e1",
        external_id: "8:133",
        player_name: "LeBron",
        set_name: "Base",
        tier: "COMMON",
        fmv_usd: 42.5,
        confidence: "HIGH",
        computed_at: "2026-07-01T00:00:00Z",
      },
    })
  })

  it("returns no_results when the key does not resolve to an edition", async () => {
    const client = makeClient({ editions: { single: { data: null, error: null } } })
    const out = await fetchUnifiedFmvDistribution(client, { collectionUuid: null, editionKey: "ghost" })
    expect(out).toEqual({ status: "no_results", message: "No edition found for key 'ghost'." })
  })

  it("returns no_results when the edition has no FMV snapshot", async () => {
    const client = makeClient({
      editions: { single: { data: { id: "e1", external_id: "8:133" }, error: null } },
      fmv_snapshots: { single: { data: null, error: null } },
    })
    const out = await fetchUnifiedFmvDistribution(client, { collectionUuid: null, editionKey: "8:133" })
    expect(out).toEqual({ status: "no_results", message: "Edition '8:133' has no FMV snapshot yet." })
  })
})

describe("fetchUnifiedFmvDistribution — filtered distribution path", () => {
  const editionRows = [
    { id: "e1", external_id: "x1", player_name: "P", set_name: "S", tier: "COMMON", collection_id: "c" },
    { id: "e2", external_id: "x2", player_name: "P", set_name: "S", tier: "COMMON", collection_id: "c" },
    { id: "e3", external_id: "x3", player_name: "P", set_name: "S", tier: "COMMON", collection_id: "c" },
    { id: "e4", external_id: "x4", player_name: "P", set_name: "S", tier: "COMMON", collection_id: "c" },
    { id: "e5", external_id: "x5", player_name: "P", set_name: "S", tier: "COMMON", collection_id: "c" },
  ]
  const snapRows = [
    { edition_id: "e1", fmv_usd: 10, confidence: "HIGH", computed_at: "2026-01-01T00:00:00Z" },
    { edition_id: "e2", fmv_usd: 20, confidence: "HIGH", computed_at: "2026-01-05T00:00:00Z" },
    { edition_id: "e3", fmv_usd: 30, confidence: "HIGH", computed_at: "2026-01-03T00:00:00Z" },
    { edition_id: "e4", fmv_usd: 40, confidence: "HIGH", computed_at: "2026-01-02T00:00:00Z" },
    { edition_id: "e5", fmv_usd: 50, confidence: "HIGH", computed_at: "2026-01-04T00:00:00Z" },
  ]

  it("computes the p10/p50/p90/min/max distribution over 5 editions", async () => {
    const client = makeClient({
      editions: { list: { data: editionRows, error: null } },
      get_editions_latest_fmv: { list: { data: snapRows, error: null } },
    })
    const out: any = await fetchUnifiedFmvDistribution(client, {
      collectionUuid: "c",
      player: "P",
      setName: "S",
      tier: "common",
    })
    expect(out.status).toBe("ok")
    expect(out.mode).toBe("distribution")
    expect(out.count).toBe(5)
    expect(out.p10).toBe(14)
    expect(out.p50).toBe(30)
    expect(out.p90).toBe(46)
    expect(out.min_fmv).toBe(10)
    expect(out.max_fmv).toBe(50)
    // samples: five rows, sorted by computed_at desc (e2=Jan05 first)
    expect(out.sample_editions).toHaveLength(5)
    expect(out.sample_editions[0].edition_id).toBe("e2")
    expect(out.sample_editions[1].edition_id).toBe("e5")
  })

  it("uppercases the tier filter into an eq() (enum-safe, no ilike)", async () => {
    const client = makeClient({
      editions: { list: { data: editionRows, error: null } },
      get_editions_latest_fmv: { list: { data: snapRows, error: null } },
    })
    await fetchUnifiedFmvDistribution(client, { collectionUuid: "c", tier: "common" })
    const edChain = client.calls.filter((c: any) => c.table === "editions").flatMap((c: any) => c.chain)
    expect(edChain).toContainEqual(["eq", "tier", "COMMON"])
    // tier must NOT be routed through ilike
    expect(edChain.some((s: any) => s[0] === "ilike" && s[1] === "tier")).toBe(false)
  })

  it("respects sampleLimit (capped at 10, min 1)", async () => {
    const client = makeClient({
      editions: { list: { data: editionRows, error: null } },
      get_editions_latest_fmv: { list: { data: snapRows, error: null } },
    })
    const out: any = await fetchUnifiedFmvDistribution(client, { collectionUuid: "c", sampleLimit: 2 })
    expect(out.sample_editions).toHaveLength(2)
  })

  it("returns single mode when exactly one edition has FMV", async () => {
    const client = makeClient({
      editions: { list: { data: [editionRows[0]], error: null } },
      get_editions_latest_fmv: { list: { data: [snapRows[0]], error: null } },
    })
    const out: any = await fetchUnifiedFmvDistribution(client, { collectionUuid: "c" })
    expect(out.mode).toBe("single")
    expect(out.edition.edition_id).toBe("e1")
    expect(out.edition.fmv_usd).toBe(10)
  })

  it("returns no_results when no editions match", async () => {
    const client = makeClient({ editions: { list: { data: [], error: null } } })
    const out = await fetchUnifiedFmvDistribution(client, { collectionUuid: "c", player: "Nobody" })
    expect(out).toEqual({ status: "no_results", message: "No catalog editions matched those filters." })
  })

  it("returns no_results when editions matched but none have a snapshot", async () => {
    const client = makeClient({
      editions: { list: { data: editionRows, error: null } },
      get_editions_latest_fmv: { list: { data: [], error: null } },
    })
    const out = await fetchUnifiedFmvDistribution(client, { collectionUuid: "c" })
    expect(out).toEqual({ status: "no_results", message: "No catalog editions matched those filters." })
  })

  it("surfaces an editions query error as no_results", async () => {
    const client = makeClient({ editions: { list: { data: null, error: { message: "boom" } } } })
    const out = await fetchUnifiedFmvDistribution(client, { collectionUuid: "c" })
    expect(out).toEqual({ status: "no_results", message: "editions query error: boom" })
  })

  it("says a failed FMV READ failed — it is not an empty catalog", async () => {
    // ⚠ FmvDistributionResult has no error variant, so the MESSAGE has to carry
    // the distinction the shape cannot. The prompt's error-vs-empty rule is
    // unreachable for this tool if a failed read reads as "nothing matched".
    const client = makeClient({
      editions: { list: { data: editionRows, error: null } },
      get_editions_latest_fmv: { list: { data: null, error: { message: "snap boom" } } },
    })
    const out: any = await fetchUnifiedFmvDistribution(client, { collectionUuid: "c" })
    expect(out.status).toBe("no_results")
    expect(out.message).toContain("FMV LOOKUP FAILED")
    expect(out.message).toContain("snap boom")
    expect(out.message).not.toMatch(/^No catalog editions matched/)
  })

  it("keeps only the latest snapshot per edition (first ordered row wins)", async () => {
    // Two snapshots for e1; the first in the (desc-ordered) list is authoritative.
    const client = makeClient({
      editions: { list: { data: [editionRows[0], editionRows[1]], error: null } },
      get_editions_latest_fmv: {
        list: {
          data: [
            { edition_id: "e1", fmv_usd: 99, confidence: "HIGH", computed_at: "2026-02-01T00:00:00Z" },
            { edition_id: "e1", fmv_usd: 11, confidence: "LOW", computed_at: "2026-01-01T00:00:00Z" },
            { edition_id: "e2", fmv_usd: 20, confidence: "HIGH", computed_at: "2026-01-05T00:00:00Z" },
          ],
          error: null,
        },
      },
    })
    const out: any = await fetchUnifiedFmvDistribution(client, { collectionUuid: "c" })
    expect(out.count).toBe(2)
    expect(out.max_fmv).toBe(99)
    expect(out.min_fmv).toBe(20)
  })
})

describe("fetchPinnacleFmvDistribution — TRIPLE keying invariant", () => {
  const renderRows = [
    { render_id: "r1", legacy_edition_key: "k1", character_name: "Mickey", set_name: "Classics", variant: "Gold", fmv_usd: 100, fmv_confidence: "HIGH", fmv_computed_at: "2026-01-02T00:00:00Z" },
    { render_id: "r2", legacy_edition_key: "k1", character_name: "Mickey", set_name: "Classics", variant: "Gold", fmv_usd: 300, fmv_confidence: "HIGH", fmv_computed_at: "2026-01-01T00:00:00Z" },
  ]

  it("filters by character_name AND set_name AND variant (triple, never edition_key alone)", async () => {
    const client = makeClient({ pinnacle_catalog: { list: { data: renderRows, error: null } } })
    await fetchPinnacleFmvDistribution(client, { character: "Mickey", setName: "Classics", variant: "Gold" })
    const filters = ilikeArgs(client, "pinnacle_catalog")
    const fields = filters.map((f) => f[0])
    expect(fields).toContain("character_name")
    expect(fields).toContain("set_name")
    expect(fields).toContain("variant")
    // and it must NOT collapse to a legacy_edition_key eq() in the filtered path
    const pinChain = client.calls.filter((c: any) => c.table === "pinnacle_catalog").flatMap((c: any) => c.chain)
    expect(pinChain.some((s: any) => s[0] === "eq" && s[1] === "legacy_edition_key")).toBe(false)
  })

  it("builds a distribution over priced renders", async () => {
    const client = makeClient({ pinnacle_catalog: { list: { data: renderRows, error: null } } })
    const out: any = await fetchPinnacleFmvDistribution(client, { character: "Mickey" })
    expect(out.status).toBe("ok")
    expect(out.mode).toBe("distribution")
    expect(out.count).toBe(2)
    expect(out.min_fmv).toBe(100)
    expect(out.max_fmv).toBe(300)
  })

  it("returns no_results when no priced renders match", async () => {
    const client = makeClient({ pinnacle_catalog: { list: { data: [], error: null } } })
    const out = await fetchPinnacleFmvDistribution(client, { character: "Nobody" })
    expect(out).toEqual({ status: "no_results", message: "No priced Pinnacle renders matched those filters." })
  })

  it("editionKey path collapses to the most-traded render as single", async () => {
    const client = makeClient({ pinnacle_catalog: { list: { data: renderRows, error: null } } })
    const out: any = await fetchPinnacleFmvDistribution(client, { editionKey: "k1" })
    expect(out.mode).toBe("single")
    expect(out.edition.edition_id).toBe("r1")
    expect(out.edition.player_name).toBe("Mickey")
    expect(out.edition.set_name).toBe("Classics")
    expect(out.edition.tier).toBe("Gold")
    // editionKey path keys on legacy_edition_key
    const pinChain = client.calls.filter((c: any) => c.table === "pinnacle_catalog").flatMap((c: any) => c.chain)
    expect(pinChain).toContainEqual(["eq", "legacy_edition_key", "k1"])
  })

  it("editionKey path returns no_results when no priced render exists", async () => {
    const client = makeClient({ pinnacle_catalog: { list: { data: [], error: null } } })
    const out = await fetchPinnacleFmvDistribution(client, { editionKey: "kX" })
    expect(out).toEqual({ status: "no_results", message: "Pinnacle edition 'kX' has no priced render." })
  })
})

describe("fetchUnifiedFmvDistribution — Top Shot's dual key convention", () => {
  const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

  // `editions` stores every Top Shot moment TWICE — int-keyed and UUID-keyed —
  // and the twins carry their own fmv_current rows, so an unfiltered
  // distribution counts each moment twice and computes p10/p50/p90 over the
  // inflated set. Measured 2026-08-15 for "Damian Lillard": 65 canonical vs 28
  // twins, 14 of them priced, so count read 77 against a truth of 63.
  it("counts each moment ONCE, not once per key convention", async () => {
    const client = makeClient({
      editions: {
        list: {
          data: [
            { id: "a", external_id: "48:1652", player_name: "Damian Lillard", set_name: "Archive Set", tier: "COMMON", collection_id: TS },
            { id: "b", external_id: "9e89b552-0236-4ffc-ab6b:d01a3af4-dce1-499a", player_name: "Damian Lillard", set_name: "Archive Set", tier: "COMMON", collection_id: TS },
            { id: "c", external_id: "121:4255", player_name: "Damian Lillard", set_name: "Run It Back", tier: "LEGENDARY", collection_id: TS },
          ],
          error: null,
        },
      },
      get_editions_latest_fmv: {
        list: {
          data: [
            { edition_id: "a", fmv_usd: 10, confidence: "HIGH", computed_at: "2026-08-15T00:00:00Z" },
            { edition_id: "b", fmv_usd: 10, confidence: "HIGH", computed_at: "2026-08-15T00:00:00Z" },
            { edition_id: "c", fmv_usd: 500, confidence: "HIGH", computed_at: "2026-08-15T00:00:00Z" },
          ],
          error: null,
        },
      },
    })
    const res = await fetchUnifiedFmvDistribution(client, {
      collectionUuid: TS,
      player: "Damian Lillard",
    } as never)
    if (res.status !== "ok" || res.mode !== "distribution") throw new Error("expected a distribution")
    expect(res.count).toBe(2) // NOT 3 — "b" is "a" under the other convention
    expect(res.sample_editions.map((e) => e.external_id).sort()).toEqual(["121:4255", "48:1652"])
  })

  it("keeps a non-Top-Shot collection's UUID keys, which are canonical there", async () => {
    // ⚠ All Day / Golazos / UFC / Candy are 100% UUID-keyed, so applying the
    // int-key predicate to them would return an empty distribution.
    const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
    const client = makeClient({
      editions: {
        list: {
          data: [
            { id: "x", external_id: "9e89b552-0236-4ffc-ab6b", player_name: "Patrick Mahomes", set_name: "Base", tier: "COMMON", collection_id: AD },
          ],
          error: null,
        },
      },
      get_editions_latest_fmv: {
        list: {
          data: [{ edition_id: "x", fmv_usd: 25, confidence: "HIGH", computed_at: "2026-08-15T00:00:00Z" }],
          error: null,
        },
      },
    })
    const res = await fetchUnifiedFmvDistribution(client, {
      collectionUuid: AD,
      player: "Patrick Mahomes",
    } as never)
    expect(res.status).toBe("ok")
  })
})
