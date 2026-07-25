import { describe, it, expect, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"

// Queues 2-4 of GET /api/cron/pinnacle-metadata-backfill, plus the apply-phase
// legs the sibling deep test doesn't reach (it drives Q1 only). Everything here
// hangs off the same on-chain PinInfo read, so a decode regression would silently
// mis-key the catalog rather than fail loudly:
//
//   Q2 edition_key resolve — a Pinnacle wmc row with a NULL edition_key gets the
//     authoritative `royaltyCode:variant:printing` key AND the pinnacle_nft_map
//     row upserted alongside it (the map is what the disagreement queue audits
//     against, so a wmc-only write would manufacture tomorrow's Q3 backlog).
//   Q3 disagreement — chain is the tiebreaker, and it corrects whichever SIDE is
//     wrong: map when wmc already matches chain, wmc otherwise. Getting the side
//     backwards would overwrite the correct value with the wrong one.
//   Q4 catalog create/repair — upsert shape, the Unknown/trim fallbacks, the
//     already-complete skip, per-key dedupe, and match-vs-remapped tagging.
//     thumbnail_url must NEVER appear in the payload (images are a documented
//     dead-end; writing one would fabricate a CDN path).
//   Opportunistic serial fill — NULL-guarded, and skipped for open editions
//     (serialNumber nil on-chain), so it can never clobber a real serial.
//   The remaining pre-Cadence 500s, the no-sample skip counter, and the
//     soft-deadline break.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

process.env.INGEST_SECRET_TOKEN = "pin-token"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"

const { GET } = await import("@/app/api/cron/pinnacle-metadata-backfill/route")

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")
const T = {
  int: (v: number) => ({ type: "Int", value: String(v) }),
  uint64: (v: number | string) => ({ type: "UInt64", value: String(v) }),
  str: (v: string) => ({ type: "String", value: v }),
  bool: (v: boolean) => ({ type: "Bool", value: v }),
  opt: (v: unknown) => ({ type: "Optional", value: v }),
}

interface Pin {
  royaltyCode: string
  variant: string
  printing: number
  numberMinted?: number
  isLimited?: boolean
  isChaser?: boolean
  characterName?: string
  franchise?: string
  setName?: string
  editionType?: string
  /** null (the default) models an open edition — no on-chain serial. */
  serial?: number | null
}

function pinStruct(p: Pin) {
  return {
    type: "Struct",
    value: {
      id: "A.edf9df96c92f4595.Pinnacle.PinInfo",
      fields: [
        { name: "editionId", value: T.int(1) },
        { name: "royaltyCode", value: T.str(p.royaltyCode) },
        { name: "variant", value: T.str(p.variant) },
        { name: "printing", value: T.uint64(p.printing) },
        { name: "numberMinted", value: T.uint64(p.numberMinted ?? 100) },
        { name: "maxMintSize", value: T.uint64(0) },
        { name: "isLimited", value: T.bool(p.isLimited ?? false) },
        { name: "isChaser", value: T.bool(p.isChaser ?? false) },
        { name: "characterName", value: T.str(p.characterName ?? "Mickey") },
        { name: "franchise", value: T.str(p.franchise ?? "Disney") },
        { name: "setName", value: T.str(p.setName ?? "Series 1") },
        { name: "editionType", value: T.str(p.editionType ?? "Standard") },
        { name: "serialNumber", value: T.opt(p.serial == null ? null : T.uint64(p.serial)) },
      ],
    },
  }
}

function pinDict(entries: Record<string, Pin>): string {
  return b64({
    type: "Dictionary",
    value: Object.entries(entries).map(([k, v]) => ({ key: T.uint64(k), value: pinStruct(v) })),
  })
}

function flowScript(bodies: string[]): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("rest-mainnet.onflow.org"),
    respond: () => {
      const body = bodies[Math.min(call, bodies.length - 1)] ?? ""
      call++
      return { status: 200, text: body }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    pinnacle_editions: { data: [], error: null },
    wallet_moments_cache: { data: [], error: null },
    pinnacle_nft_map: { data: [], error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/pinnacle-metadata-backfill", {
    method: "GET",
    headers: new Headers({ authorization: "Bearer pin-token" }),
  })
}

/** Empty Q1 candidate list, so pinnacle_editions[0] is Q1 and [1] is Q4's pe load. */
const NO_Q1 = { data: [], error: null }

/** Per-queue eligibility only reaches pipeline_runs.extra, never the response. */
function logExtra(spy: ReturnType<typeof install>) {
  const args = spy.rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)!.args as Record<
    string,
    unknown
  >
  return { args, extra: args.p_extra as Record<string, unknown> }
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
  vi.restoreAllMocks()
})

describe("pinnacle-metadata-backfill — Q2 edition_key resolve", () => {
  it("writes the authoritative key to BOTH wmc and pinnacle_nft_map, and fills the serial", async () => {
    const spy = install({
      pinnacle_editions: [NO_Q1, { data: [], error: null }],
      wallet_moments_cache: [
        { data: [{ id: "w1", wallet_address: "0xw1", moment_id: "777" }], error: null }, // Q2
        { data: [], error: null }, // Q3 pool
        { data: [], error: null }, // Q4 pool
        { data: [{ id: "w1" }], error: null }, // serial update .select("id")
        { data: null, error: null }, // edition_key update
      ],
    })
    fetchMock = installFetchMock([
      flowScript([pinDict({ "777": { royaltyCode: "RC", variant: "Std", printing: 1, serial: 42 } })]),
    ])

    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(body.edition_keys_resolved).toBe(1)
    expect(body.serials_filled).toBe(1)

    // The map row is written alongside wmc — otherwise this fill becomes a Q3
    // disagreement on the next pass.
    const mapUpsert = (spy.writes.pinnacle_nft_map ?? []).find((w) => w.method === "upsert")
    expect(mapUpsert?.rows[0]).toEqual({ nft_id: "777", edition_key: "RC:Std:1" })

    const wmcRows = (spy.writes.wallet_moments_cache ?? []).flatMap((w) => w.rows)
    expect(wmcRows).toContainEqual({ serial_number: 42 })
    expect(wmcRows).toContainEqual({ edition_key: "RC:Std:1" })
  })

  it("skips the serial fill for an open edition (no on-chain serial) and when the key components are missing", async () => {
    const spy = install({
      pinnacle_editions: [NO_Q1, { data: [], error: null }],
      wallet_moments_cache: [
        { data: [{ id: "w1", wallet_address: "0xw1", moment_id: "777" }], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
    })
    fetchMock = installFetchMock([
      // Open edition: serial nil, and an empty variant makes the composite key
      // unformable -> the resolve is skipped rather than writing "RC::1".
      flowScript([pinDict({ "777": { royaltyCode: "RC", variant: "", printing: 1, serial: null } })]),
    ])

    const body = await (await GET(req())).json()
    expect(body.edition_keys_resolved).toBe(0)
    expect(body.serials_filled).toBe(0)
    expect(spy.writes.wallet_moments_cache ?? []).toHaveLength(0)
  })

  it("ignores a moment the chain read did not return", async () => {
    install({
      pinnacle_editions: [NO_Q1, { data: [], error: null }],
      wallet_moments_cache: [
        { data: [{ id: "w1", wallet_address: "0xw1", moment_id: "777" }], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
    })
    fetchMock = installFetchMock([flowScript([pinDict({})])])

    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(body.edition_keys_resolved).toBe(0)
  })
})

describe("pinnacle-metadata-backfill — Q3 disagreements", () => {
  it("corrects the map when wmc already matches chain, and wmc otherwise", async () => {
    const spy = install({
      pinnacle_editions: [NO_Q1, { data: [], error: null }],
      wallet_moments_cache: [
        { data: [], error: null }, // Q2
        {
          data: [
            // wmc agrees with chain -> the MAP is the wrong side.
            { id: "wA", wallet_address: "0xw1", moment_id: "1", edition_key: "RC:Std:1" },
            // wmc disagrees with chain -> overwrite WMC.
            { id: "wB", wallet_address: "0xw1", moment_id: "2", edition_key: "RC:Alt:2" },
            // everything already agrees -> no write at all.
            { id: "wC", wallet_address: "0xw1", moment_id: "3", edition_key: "RC:Std:3" },
            // map key is integer-only -> excluded by spec (composite-vs-composite).
            { id: "wD", wallet_address: "0xw1", moment_id: "4", edition_key: "RC:Std:4" },
            // no map row at all -> nothing to disagree with.
            { id: "wE", wallet_address: "0xw1", moment_id: "5", edition_key: "RC:Std:5" },
            // integer-only wmc key -> filtered out of the composite pool.
            { id: "wF", wallet_address: "0xw1", moment_id: "6", edition_key: "12345" },
          ],
          error: null,
        }, // Q3 pool
        { data: [], error: null }, // Q4 pool
        { data: null, error: null }, // the wmc correction write
      ],
      pinnacle_nft_map: [
        {
          data: [
            { nft_id: "1", edition_key: "RC:Alt:1" },
            { nft_id: "2", edition_key: "RC:Std:2" },
            { nft_id: "3", edition_key: "RC:Std:3" },
            { nft_id: "4", edition_key: "9999" },
          ],
          error: null,
        },
        { data: null, error: null }, // the map correction write
      ],
    })
    fetchMock = installFetchMock([
      flowScript([
        pinDict({
          "1": { royaltyCode: "RC", variant: "Std", printing: 1 },
          "2": { royaltyCode: "RC", variant: "Std", printing: 2 },
          "3": { royaltyCode: "RC", variant: "Std", printing: 3 },
        }),
      ]),
    ])

    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    // wD (integer map key) and wE (no map row) never entered the queue; wF was
    // filtered out before the map lookup.
    expect(logExtra(spy).extra.q3_eligible).toBe(2)
    expect(body.disagreements_corrected).toBe(2)

    const sides = body.samples.disagreement.map((s: { corrected_side: string }) => s.corrected_side)
    expect(sides.sort()).toEqual(["map", "wmc"])

    // The map got the chain key; wmc got the chain key. Neither side was given
    // the other side's (wrong) value.
    expect((spy.writes.pinnacle_nft_map ?? []).flatMap((w) => w.rows)).toContainEqual({
      edition_key: "RC:Std:1",
    })
    expect((spy.writes.wallet_moments_cache ?? []).flatMap((w) => w.rows)).toContainEqual({
      edition_key: "RC:Std:2",
    })
  })
})

describe("pinnacle-metadata-backfill — Q4 catalog create/repair", () => {
  it("upserts from chain text with Unknown/trim fallbacks, skips complete rows, dedupes keys, and never writes thumbnail_url", async () => {
    const spy = install({
      pinnacle_editions: [
        NO_Q1,
        {
          data: [
            // COMPLETE -> its key must be skipped.
            { id: "RC:Std:9", character_name: "Mickey", edition_key: "RC:Std:9" },
            // fetch-missing stub -> repair target.
            { id: "RC:Std:8", character_name: "Unknown", edition_key: null },
          ],
          error: null,
        },
        { data: null, error: null }, // upsert acks
      ],
      wallet_moments_cache: [
        { data: [], error: null }, // Q2
        { data: [], error: null }, // Q3 pool
        {
          data: [
            { wallet_address: "0xw1", moment_id: "9", edition_key: "RC:Std:9" }, // complete -> skip
            { wallet_address: "0xw1", moment_id: "8", edition_key: "RC:Std:8" }, // stub -> repair
            { wallet_address: "0xw1", moment_id: "88", edition_key: "RC:Std:8" }, // dup key -> deduped
            { wallet_address: "0xw1", moment_id: "7", edition_key: "RC:Old:7" }, // chain says otherwise
          ],
          error: null,
        }, // Q4 pool
      ],
    })
    fetchMock = installFetchMock([
      flowScript([
        pinDict({
          "8": {
            royaltyCode: "RC",
            variant: "Std",
            printing: 8,
            numberMinted: 250,
            isLimited: true,
            isChaser: true,
            characterName: "",
            franchise: "",
            setName: "  Series 2  ",
            editionType: "",
          },
          // The on-chain key differs from the wmc key -> tagged "remapped".
          "7": { royaltyCode: "RC", variant: "New", printing: 7 },
        }),
      ]),
    ])

    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(logExtra(spy).extra.q4_eligible).toBe(2) // 9 skipped as complete, 88 deduped
    expect(body.catalog_upserted).toBe(2)

    const rows = (spy.writes.pinnacle_editions ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    const repaired = rows.find((r) => r.id === "RC:Std:8")!
    expect(repaired).toMatchObject({
      edition_key: "RC:Std:8",
      character_name: "Unknown", // empty on-chain string -> explicit Unknown
      franchise: "Unknown",
      set_name: "Series 2", // trimmed
      edition_type: "Unknown",
      royalty_code: "RC",
      variant_type: "Std",
      printing: 8,
      mint_count: 250,
      is_serialized: true,
      is_chaser: true,
    })
    // Images are a documented dead-end — the writer must not invent one.
    expect("thumbnail_url" in repaired).toBe(false)

    const tags = body.samples.catalog.map((s: { created_or_repaired: string }) => s.created_or_repaired)
    expect(tags.sort()).toEqual(["match", "remapped"])
  })
})

describe("pinnacle-metadata-backfill — load failures + limits", () => {
  const cases: Array<[string, Fixtures]> = [
    ["q1 wmc lookup", {
      pinnacle_editions: [{ data: [{ id: "pe1", edition_key: "RC:Std:1" }], error: null }],
      wallet_moments_cache: [{ data: null, error: { message: "wmc down" } }],
    }],
    ["q2 load", {
      pinnacle_editions: [NO_Q1],
      wallet_moments_cache: [{ data: null, error: { message: "q2 down" } }],
    }],
    ["q3 wmc pool", {
      pinnacle_editions: [NO_Q1],
      wallet_moments_cache: [
        { data: [], error: null },
        { data: null, error: { message: "q3 pool down" } },
      ],
    }],
    ["q3 map lookup", {
      pinnacle_editions: [NO_Q1],
      wallet_moments_cache: [
        { data: [], error: null },
        { data: [{ id: "w1", wallet_address: "0xw1", moment_id: "1", edition_key: "RC:Std:1" }], error: null },
      ],
      pinnacle_nft_map: [{ data: null, error: { message: "map down" } }],
    }],
    ["q4 pe load", {
      pinnacle_editions: [NO_Q1, { data: null, error: { message: "pe down" } }],
      wallet_moments_cache: [{ data: [], error: null }, { data: [], error: null }],
    }],
    ["q4 wmc pool", {
      pinnacle_editions: [NO_Q1, { data: [], error: null }],
      wallet_moments_cache: [
        { data: [], error: null },
        { data: [], error: null },
        { data: null, error: { message: "q4 pool down" } },
      ],
    }],
  ]

  for (const [label, fixtures] of cases) {
    it(`500s on a ${label} error, before any Cadence work`, async () => {
      install(fixtures)
      fetchMock = installFetchMock([]) // any Flow call would throw
      const res = await GET(req())
      expect(res.status).toBe(500)
      expect((await res.json()).ok).toBe(false)
      expect(fetchMock.calls).toHaveLength(0)
    })
  }

  it("counts a Q1 candidate with no sample wmc row as skipped rather than dropping it silently", async () => {
    const spy = install({
      pinnacle_editions: [
        { data: [{ id: "pe1", edition_key: "RC:Std:1" }], error: null },
        { data: [], error: null },
      ],
      wallet_moments_cache: [
        { data: [], error: null }, // Q1: no wmc row holds that key
        { data: [], error: null }, // Q2
        { data: [], error: null }, // Q3 pool
        { data: [], error: null }, // Q4 pool
      ],
    })
    const body = await (await GET(req())).json()
    const { args, extra } = logExtra(spy)
    expect(extra.q1_eligible).toBe(0)
    expect(extra.q1_skipped_no_sample).toBe(1)
    expect(args.p_rows_skipped).toBe(1)
  })

  it("stops fanning out at the soft deadline instead of running past the lambda budget", async () => {
    install({
      pinnacle_editions: [NO_Q1, { data: [], error: null }],
      wallet_moments_cache: [
        {
          data: [
            { id: "w1", wallet_address: "0xw1", moment_id: "1" },
            { id: "w2", wallet_address: "0xw2", moment_id: "2" },
          ],
          error: null,
        }, // Q2 — two distinct wallets = two fan-out iterations
        { data: [], error: null },
        { data: [], error: null },
        { data: null, error: null },
      ],
    })
    fetchMock = installFetchMock([
      flowScript([
        pinDict({ "1": { royaltyCode: "RC", variant: "Std", printing: 1 } }),
        pinDict({ "2": { royaltyCode: "RC", variant: "Std", printing: 2 } }),
      ]),
    ])

    // Clock advances 20s per read: the first wallet's deadline check passes, the
    // second one is already past SOFT_DEADLINE_MS (25s).
    const base = Date.now()
    let tick = 0
    vi.spyOn(Date, "now").mockImplementation(() => base + tick++ * 20_000)

    const body = await (await GET(req())).json()
    expect(body.ok).toBe(true)
    expect(fetchMock.calls).toHaveLength(1) // second wallet never fanned out
    expect(body.edition_keys_resolved).toBe(1)
  })
})
