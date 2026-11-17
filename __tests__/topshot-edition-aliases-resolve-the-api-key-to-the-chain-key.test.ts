// #175 (2026-10-10): Top Shot names the 2023-24 Honors (Diced) printing two ways —
// the chain mints it `152:<play>` (set 152, subedition 0) and Top Shot's API /
// offer contract names it `149:<play>::8`. The chain key is canonical;
// `public.topshot_edition_aliases` (migration 20261010155627) is the ONE alias
// point, and every API-facing writer resolves through it BEFORE keying a row.
//
// Contract pinned here:
//   helper  1. a hit maps alias -> canonical; a non-alias maps to itself;
//           2. a failed read THROWS (never "no aliases" — that keys the offer to
//              the phantom edition again, a correct-looking write to the wrong row);
//           3. a chained alias (a canonical that is itself an alias) is refused;
//           4. a page-cap read is refused (a one-page read that cannot be proven
//              complete is not a read).
//   indexer 5. a TopShotSubedition offer on (149, play, 8) lands on the `152:<play>`
//              edition's uuid, counted in `aliased_to_canonical`;
//           6. a failed alias read aborts the tick: ok=false, cursor NOT advanced.
//   sweep   7. a GQL parallel whose submap key is an alias is upserted on the
//              canonical key — the alias key is never written;
//           8. a failed alias read skips every parallel this tick (Standard rows
//              still land) and names `alias_read_error` in the run's extra.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock } from "./helpers/flow-cdc-fixture"

const state = vi.hoisted(() => ({
  sb: null as unknown,
  afterCbs: [] as Array<() => unknown>,
  gqlPages: [] as unknown[],
  gqlCursor: 0,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => {
    const page = state.gqlPages[Math.min(state.gqlCursor, Math.max(state.gqlPages.length - 1, 0))]
    state.gqlCursor++
    return page ?? gqlPage([], null)
  },
}))

process.env.INGEST_SECRET_TOKEN = "alias-token"

const { fetchTopShotEditionAliases, canonicalTopShotExternalId } = await import("@/lib/topshot/edition-aliases")
const { POST: indexerPOST } = await import("@/app/api/topshot-offers-indexer/route")
const { POST: sweepPOST } = await import("@/app/api/cron/offers-sweep/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TS_NFT = "A.0b2a3299cc857e29.TopShot.NFT"
const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const ALIAS_ROWS = [{ alias_external_id: "149:5370::8", canonical_external_id: "152:5370" }]

function install(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function terminalLog(rpcCalls: RecordedRpcCall[], pipeline: string) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === pipeline).at(-1)?.args
}

// ── helper ──────────────────────────────────────────────────────────────────

describe("fetchTopShotEditionAliases — the one alias point", () => {
  it("1. maps an alias to its canonical and a non-alias to itself", async () => {
    install({ topshot_edition_aliases: { data: ALIAS_ROWS, error: null } })
    const m = await fetchTopShotEditionAliases()
    expect(canonicalTopShotExternalId("149:5370::8", m)).toBe("152:5370")
    expect(canonicalTopShotExternalId("152:5370", m)).toBe("152:5370")
    expect(canonicalTopShotExternalId("8:133", m)).toBe("8:133")
  })

  it("2. a failed read THROWS — it never answers 'no aliases'", async () => {
    install({ topshot_edition_aliases: { data: null, error: { message: "pool boom" } } })
    await expect(fetchTopShotEditionAliases()).rejects.toThrow(/topshot_edition_aliases read: pool boom/)
  })

  it("3. a chained alias is refused", async () => {
    install({
      topshot_edition_aliases: {
        data: [
          { alias_external_id: "a:1", canonical_external_id: "b:1" },
          { alias_external_id: "b:1", canonical_external_id: "c:1" },
        ],
        error: null,
      },
    })
    await expect(fetchTopShotEditionAliases()).rejects.toThrow(/chain/)
  })

  it("4. a read that hits the page cap is refused", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ alias_external_id: `1:${i}::9`, canonical_external_id: `2:${i}` }))
    install({ topshot_edition_aliases: { data: rows, error: null } })
    await expect(fetchTopShotEditionAliases()).rejects.toThrow(/page cap/)
  })
})

// ── indexer ─────────────────────────────────────────────────────────────────

const address = (v: string) => ({ type: "Address", value: v })
const paramsDict = (entries: Record<string, string>) => ({
  type: "Dictionary",
  value: Object.entries(entries).map(([k, v]) => ({ key: cdc.string(k), value: cdc.string(v) })),
})
function offerAvailPayload(params: Record<string, string>) {
  return cdcEvent(OFFER_AVAILABLE, {
    offerAddress: address("0xABCDEF0123456789"),
    offerId: cdc.uint64("901"),
    nftType: cdc.nftType(TS_NFT),
    offerAmount: cdc.ufix64("2000.00000000"),
    offerParamsString: paramsDict(params),
  })
}
function flowRestStubs(avail: unknown[]): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }], { status: 200 }),
    jsonRoute("OfferAvailable", avail),
    jsonRoute("OfferCompleted", []),
    jsonRoute("/v1/events", []),
  ]
}
function indexerReq() {
  return new NextRequest("https://t/api/topshot-offers-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer alias-token" }),
  })
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "alias-token"
  state.afterCbs.length = 0
  state.gqlPages = []
  state.gqlCursor = 0
})

describe("topshot-offers-indexer resolves the API key through the alias table", () => {
  const dicedOffer = eventBlock({
    height: 1100,
    txId: "b".repeat(64),
    eventType: OFFER_AVAILABLE,
    payload: offerAvailPayload({ _type: "TopShotSubedition", setId: "149", playId: "5370", subeditionId: "8" }),
  })

  it("5. a (149, play, 8) offer lands on the 152:<play> edition and is counted", async () => {
    fetchMock = installFetchMock(flowRestStubs([dicedOffer]))
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      topshot_edition_aliases: { data: ALIAS_ROWS, error: null },
      // Both rows are catalogued (the alias row exists as a FK target); the
      // offer must pick the CANONICAL uuid.
      editions: {
        data: [
          { external_id: "149:5370::8", id: "uuid-alias" },
          { external_id: "152:5370", id: "uuid-canonical" },
        ],
        error: null,
      },
      offers: { data: [], error: null },
    })
    const res = await indexerPOST(indexerReq())
    expect(res.status).toBe(200)
    const rows = (spy.writes.offers ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ offer_id: "901", edition_id: "uuid-canonical", offer_type: "subedition" })
    expect(rows.some((r) => r.edition_id === "uuid-alias")).toBe(false)
    const log = terminalLog(spy.rpcCalls, "topshot-offers-indexer")
    expect(log).toMatchObject({ p_ok: true, p_cursor_after: "1250" })
    expect((log?.p_extra as Record<string, unknown>).aliased_to_canonical).toBe(1)
  })

  it("6. a failed alias read aborts the tick: ok=false and the cursor does NOT advance", async () => {
    fetchMock = installFetchMock(flowRestStubs([dicedOffer]))
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      topshot_edition_aliases: { data: null, error: { message: "alias read boom" } },
      editions: { data: [{ external_id: "149:5370::8", id: "uuid-alias" }], error: null },
      offers: { data: [], error: null },
    })
    const res = await indexerPOST(indexerReq())
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("topshot_edition_aliases read")
    expect((spy.writes.offers ?? []).length).toBe(0)
    expect(spy.writes.event_cursor?.find((w) => w.method === "update")).toBeUndefined()
    const log = terminalLog(spy.rpcCalls, "topshot-offers-indexer")
    expect(log?.p_ok).toBe(false)
  })
})

// ── sweep ───────────────────────────────────────────────────────────────────

function gqlPage(editions: unknown[], rightCursor: string | null) {
  return {
    searchMarketplaceEditions: {
      data: { searchSummary: { pagination: { rightCursor }, data: { size: editions.length, data: editions } } },
    },
  }
}
function rawEdition(opts: { id: string; parallelID?: number; lowAsk?: number | null; highestOffer?: number | null }) {
  return {
    id: opts.id,
    set: { id: "set-uuid-149", flowId: 0 },
    play: { id: "play-uuid-5370", flowID: "5370" },
    parallelID: opts.parallelID ?? 0,
    lowAsk: opts.lowAsk ?? null,
    highestOffer: opts.highestOffer ?? null,
  }
}
function sweepReq() {
  return new NextRequest("https://t/api/cron/offers-sweep", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer alias-token" }),
  })
}
async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}
const SWEEP_BASE = {
  pipeline_runs: { data: null, error: null },
  sets: { data: [{ external_id: "set-uuid-149", set_id_onchain: 149 }], error: null },
  editions: { data: [{ external_id: "149:5370::8", play_id_onchain: 5370, subedition_id: 8 }], error: null },
  edition_offers: { data: null, error: null },
  "rpc:raise_edition_offers_from_chain": { data: 0, error: null },
  "rpc:log_pipeline_run": { data: null, error: null },
}

describe("offers-sweep resolves a parallel's key through the alias table", () => {
  it("7. the Diced parallel (149, 5370, parallel 8) is upserted on 152:5370 — the alias key is never written", async () => {
    state.gqlPages = [
      gqlPage(
        [
          rawEdition({ id: "e-std", lowAsk: 10, highestOffer: 4 }), // Standard 149:5370 — untouched
          rawEdition({ id: "e-diced", parallelID: 8, lowAsk: 2188, highestOffer: 1800 }),
        ],
        null,
      ),
    ]
    const spy = install({ ...SWEEP_BASE, topshot_edition_aliases: { data: ALIAS_ROWS, error: null } })
    const res = await sweepPOST(sweepReq())
    expect(res.status).toBe(202)
    await runDeferred()
    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    const byKey = Object.fromEntries(rows.map((r) => [r.external_id as string, r]))
    expect(Object.keys(byKey).sort()).toEqual(["149:5370", "152:5370"])
    expect(byKey["152:5370"]).toMatchObject({ collection_id: TS, low_ask: 2188, highest_offer: 1800 })
    expect(byKey["149:5370"]).toMatchObject({ low_ask: 10, highest_offer: 4 })
    const log = terminalLog(spy.rpcCalls, "offers-sweep")
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 2, p_rows_skipped: 0 })
    expect((log?.p_extra as Record<string, unknown>).alias_read_error).toBeNull()
  })

  it("8. a failed alias read skips every parallel this tick (Standard still lands) and names the error", async () => {
    state.gqlPages = [
      gqlPage(
        [
          rawEdition({ id: "e-std", lowAsk: 10, highestOffer: 4 }),
          rawEdition({ id: "e-diced", parallelID: 8, lowAsk: 2188, highestOffer: 1800 }),
        ],
        null,
      ),
    ]
    const spy = install({ ...SWEEP_BASE, topshot_edition_aliases: { data: null, error: { message: "alias boom" } } })
    const res = await sweepPOST(sweepReq())
    expect(res.status).toBe(202)
    await runDeferred()
    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    expect(rows.map((r) => r.external_id)).toEqual(["149:5370"])
    const log = terminalLog(spy.rpcCalls, "offers-sweep")
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1, p_rows_skipped: 1 })
    expect(String((log?.p_extra as Record<string, unknown>).alias_read_error)).toContain("alias boom")
  })
})
