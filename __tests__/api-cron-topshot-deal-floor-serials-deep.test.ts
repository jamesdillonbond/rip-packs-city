import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Deep-drive of /api/cron/topshot-deal-floor-serials — the deal-board floor-serial
// capture. Pins the "price+serial from the SAME listing, parallel-correct" contract:
//   - one price-sorted page per set:play serves the base row AND its :: siblings,
//     each picking the floor whose parallelID matches its printing;
//   - a printing with no matching listing in the page is SKIPPED (never a
//     cross-printing floor);
//   - a GQL fault increments gql_errors / throttled_giveups (429), run still ok;
//   - a deal-board read error flips ok=false via the fatal fetchError;
//   - the GET introspection returns the computed count;
//   - the auth guard.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  gql: null as unknown,
  gqlThrow: null as string | null,
  failGroup: null as string | null,
  gqlCalls: 0,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  // ⚠ KEYED ON THE GROUP BEING FETCHED, NOT ON CALL ORDER. `fetchFloorWithRetry`
  // retries a 429 up to MAX_RETRIES with backoff, and CONCURRENCY=2 interleaves
  // the workers — so "fail the Nth call" is absorbed by the retry (that is the
  // backoff working) and cannot express "this group is down". Failing by set_uuid
  // fails every attempt for that group and none for the others.
  topshotGraphql: async (_q: unknown, vars?: unknown) => {
    state.gqlCalls += 1
    if (state.gqlThrow) throw new Error(state.gqlThrow)
    if (state.failGroup && JSON.stringify(vars ?? {}).includes(`set-uuid-${state.failGroup}`)) {
      throw new Error("429 Too Many Requests")
    }
    return state.gql
  },
}))

process.env.INGEST_SECRET_TOKEN = "deal-token"

const { POST, GET } = await import("@/app/api/cron/topshot-deal-floor-serials/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function floorPage(moments: Array<{ flowId: string; flowSerialNumber: string; price: string; parallelID: number }>) {
  return { searchMintedMoments: { data: { searchSummary: { data: { data: moments } } } } }
}

// ⚠ `group` matters: the route fetches ONE price page per (set_uuid, play_uuid)
// and serves every edition in that group from it. Two targets in the SAME group
// are one fetch; in different groups they are two. A test that wants "one fetch
// failed, another succeeded" MUST put them in different groups.
function target(external_id: string, opts: { serial?: number | null; group?: string } = {}) {
  const g = opts.group ?? "1"
  return {
    external_id,
    set_uuid: `set-uuid-${g}`,
    play_uuid: `play-uuid-${g}`,
    low_ask_serial: opts.serial ?? null,
    updated_at: null,
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    "rpc:get_topshot_deal_external_ids": { data: [], error: null },
    edition_offers: { data: [], error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/topshot-deal-floor-serials", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer deal-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}

beforeEach(() => {
  state.afterCbs.length = 0
  state.gql = floorPage([])
  state.gqlThrow = null
  state.failGroup = null
  state.gqlCalls = 0
})

describe("topshot-deal-floor-serials — floor capture", () => {
  it("picks each printing's parallel-matched floor from one shared page and writes price+serial+nft together", async () => {
    state.gql = floorPage([
      // cheapest Standard first, then the parallel printing 19.
      { flowId: "n1", flowSerialNumber: "12", price: "40", parallelID: 0 },
      { flowId: "n2", flowSerialNumber: "3", price: "75", parallelID: 19 },
    ])
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: ["3:45", "3:45::19"], error: null },
      edition_offers: { data: [target("3:45"), target("3:45::19")], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(2)
    const byId = Object.fromEntries(rows.map((r) => [r.external_id, r]))
    // Standard (parallelID 0) floor.
    expect(byId["3:45"]).toMatchObject({ collection_id: TS, low_ask: 40, low_ask_serial: 12, low_ask_nft_id: "n1" })
    // Parallel 19 floor — NOT the cheaper Standard listing.
    expect(byId["3:45::19"]).toMatchObject({ low_ask: 75, low_ask_serial: 3, low_ask_nft_id: "n2" })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "topshot-deal-floor-serials", p_ok: true, p_rows_written: 2 })
    expect(log.p_extra).toMatchObject({ listings_found: 2, deal_editions_total: 2 })
  })

  it("skips a printing with no matching listing in the page (never a cross-printing floor)", async () => {
    // Page has only a Standard listing; the ::19 printing must be skipped.
    state.gql = floorPage([{ flowId: "n1", flowSerialNumber: "12", price: "40", parallelID: 0 }])
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: ["3:45", "3:45::19"], error: null },
      edition_offers: { data: [target("3:45"), target("3:45::19")], error: null },
    })

    await POST(req())
    await runDeferred()

    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0].external_id).toBe("3:45")
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_rows_skipped: 1, p_ok: true })
  })
})

describe("topshot-deal-floor-serials — degradation + auth", () => {
  // ⚠ REWRITTEN 2026-08-29, NOT DELETED. This test's INTENT — "a per-edition fault
  // does not fail the whole run" — is correct and still pinned below. But its
  // fixture had ONE edition, so "one of several failed" and "every single one
  // failed" were the same input, and it therefore also pinned the second, wrong
  // thing: that a TOTAL wipeout stays green. Production showed what that costs —
  // 21 consecutive hourly runs logged gql_errors 10 of 10, listings_found 0,
  // rows_written 0, all ok:true, while the upstream had been 530ing for 22 hours,
  // and the resulting "23 runs, 22 ok" aggregate actively argued the endpoint was
  // healthy. Two editions is the smallest fixture that can tell the cases apart.
  it("a per-edition GQL fault increments gql_errors + throttled_giveups and the run STAYS ok when another edition resolved", async () => {
    // Two DIFFERENT set:play groups ⇒ two fetches. Group 1 fails every attempt
    // (so the retry cannot rescue it); group 2 returns a page. listings_found is
    // therefore 1 — the run is working, not failing.
    state.gql = floorPage([{ flowId: "n1", flowSerialNumber: "7", price: "10", parallelID: 0 }])
    state.failGroup = "1"
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: ["3:45", "9:99"], error: null },
      edition_offers: {
        data: [target("3:45", { group: "1" }), target("9:99", { group: "2" })],
        error: null,
      },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok, "one failed group out of two must not redden a run that priced the other").toBe(true)
    expect(log.p_extra).toMatchObject({ gql_errors: 1, throttled_giveups: 1, listings_found: 1 })
    expect(log.p_error ?? null).toBeNull()
  })

  it("a run where EVERY edition's fetch failed is NOT ok, and says so", async () => {
    state.gqlThrow = "429 Too Many Requests"
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: ["3:45", "9:99"], error: null },
      edition_offers: { data: [target("3:45"), target("9:99")], error: null },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok, "2 of 2 fetches failed and the run still claimed success").toBe(false)
    expect(log.p_rows_written).toBe(0)
    expect(log.p_extra).toMatchObject({ gql_errors: 2, throttled_giveups: 2 })
    // The cause must survive into the row: identifying the 2026-08-29 outage from
    // this pipeline was impossible because the error column was always null.
    expect(log.p_error).toBeTruthy()
    expect(log.p_error).toContain("429")
    expect(log.p_extra.first_gql_error).toContain("429")
  })

  it("CONTROL — an EMPTY deal board stays ok (nothing attempted is not a failure)", async () => {
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: [], error: null },
      edition_offers: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok, "an empty deal board is the healthy steady state").toBe(true)
    expect(log.p_error ?? null).toBeNull()
  })

  it("a deal-board read error flips ok=false via the fatal path", async () => {
    const spy = install({
      "rpc:get_topshot_deal_external_ids": { data: null, error: { message: "statement timeout" } },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("deal board read: statement timeout")
  })

  it("GET returns the computed floor-serial count", async () => {
    install({ edition_offers: { count: 42, error: null } as never })
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).editionsWithFloorSerial).toBe(42)
  })

  it("401s POST without the token and registers no deferred work", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/cron/topshot-deal-floor-serials", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
