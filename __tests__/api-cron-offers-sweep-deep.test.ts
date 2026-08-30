import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Deep-drive of POST /api/cron/offers-sweep — the edition_offers writer behind
// the "best offer" display. Pins the 2026-07-07 parallel-keying correctness
// contract: Standard printings key to the base pair via the authoritative
// sets-table bridge; parallelID>0 rows key to their OWN ::subID edition via the
// (play, subedition) submap; ambiguous/unmapped parallels are SKIPPED (never
// blended onto the base — the "mixed up offers" bug). Also: best-of-dupes
// accumulation (max offer / min ask), the null-null row filter, cursor
// wrap-vs-resume, the chain-offer raise call, and both fatal paths logging.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  gqlPages: [] as unknown[],
  gqlCursor: 0,
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
  topshotGraphql: async () => {
    const page = state.gqlPages[Math.min(state.gqlCursor, Math.max(state.gqlPages.length - 1, 0))]
    state.gqlCursor++
    const poison = (page as { __throw?: string } | undefined)?.__throw
    if (poison) throw new Error(poison)
    return page ?? gqlPage([], null)
  },
}))

const { POST } = await import("@/app/api/cron/offers-sweep/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function gqlPage(editions: unknown[], rightCursor: string | null) {
  return {
    searchMarketplaceEditions: {
      data: {
        searchSummary: {
          pagination: { rightCursor },
          data: { size: editions.length, data: editions },
        },
      },
    },
  }
}

function rawEdition(opts: {
  id: string
  setUuid?: string
  playFlowID?: string
  parallelID?: number
  lowAsk?: number | null
  highestOffer?: number | null
}) {
  return {
    id: opts.id,
    set: { id: opts.setUuid ?? "set-uuid-1", flowId: 0 }, // 0-sentinel: the sets-table bridge must win
    play: { id: "play-uuid-1", flowID: opts.playFlowID ?? "45" },
    parallelID: opts.parallelID ?? 0,
    lowAsk: opts.lowAsk ?? null,
    highestOffer: opts.highestOffer ?? null,
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    pipeline_runs: { data: null, error: null }, // cursor read -> head
    sets: { data: [{ external_id: "set-uuid-1", set_id_onchain: 3 }], error: null },
    editions: {
      data: [{ external_id: "3:45::19", play_id_onchain: 45, subedition_id: 19 }],
      error: null,
    },
    edition_offers: { data: null, error: null },
    "rpc:raise_edition_offers_from_chain": { data: 2, error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/offers-sweep", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer offers-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "offers-token"
  state.afterCbs.length = 0
  state.gqlPages = []
  state.gqlCursor = 0
})

describe("offers-sweep — parallel-aware keying", () => {
  it("keys Standard to the base pair, a mapped parallel to its ::subID row, and SKIPS unmapped parallels", async () => {
    state.gqlPages = [
      gqlPage(
        [
          rawEdition({ id: "e-std", lowAsk: 10, highestOffer: 4 }),
          // parallelID 19 maps via (play 45, sub 19) -> "3:45::19".
          rawEdition({ id: "e-par", parallelID: 19, lowAsk: 60, highestOffer: 25 }),
          // parallelID 7 has NO submap entry -> must be skipped, never blended.
          rawEdition({ id: "e-unmapped-par", parallelID: 7, lowAsk: 1, highestOffer: 999 }),
        ],
        null,
      ),
    ]
    const spy = install({})

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(2)
    const byKey = Object.fromEntries(rows.map((r) => [r.external_id, r]))
    // Standard printing on the base pair — the parallel's numbers never bled in.
    expect(byKey["3:45"]).toMatchObject({
      collection_id: TOPSHOT,
      low_ask: 10,
      highest_offer: 4,
      set_uuid: "set-uuid-1",
      play_uuid: "play-uuid-1",
    })
    // The mapped parallel on its own :: edition.
    expect(byKey["3:45::19"]).toMatchObject({ low_ask: 60, highest_offer: 25 })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_pipeline: "offers-sweep",
      p_ok: true,
      p_rows_written: 2,
      p_rows_skipped: 1, // the unmapped parallel
      p_cursor_after: null, // short page -> wrapped to head
    })
    expect((log?.p_extra as Record<string, unknown>).offers_raised_from_chain).toBe(2)
  })

  it("paginates the :: subedition map past the 1,000-row PostgREST cap (a page-2 parallel still resolves)", async () => {
    // Top Shot has ~3,600 :: editions; a bare .limit(10000) clamps to 1,000, so
    // a parallel whose subedition row only exists past the first page must still
    // resolve. Page 1 = a FULL 1,000-row page (forces a second fetch); page 2
    // carries the target key (play 5000, sub 7) -> "3:5000::7".
    const page1 = Array.from({ length: 1000 }, (_v, i) => ({
      external_id: `3:${i + 1}::1`,
      play_id_onchain: i + 1,
      subedition_id: 1,
    }))
    const page2 = [{ external_id: "3:5000::7", play_id_onchain: 5000, subedition_id: 7 }]

    state.gqlPages = [
      gqlPage(
        [rawEdition({ id: "e-par2", playFlowID: "5000", parallelID: 7, lowAsk: 33, highestOffer: 12 })],
        null,
      ),
    ]
    // Sequence-aware editions fixture: first .range() -> full page1, second -> page2.
    const spy = install({
      editions: [
        { data: page1, error: null },
        { data: page2, error: null },
      ],
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    const byKey = Object.fromEntries(rows.map((r) => [r.external_id, r]))
    // Only resolvable if page 2 was fetched — the bug (clamp at page 1) drops it.
    expect(byKey["3:5000::7"]).toMatchObject({ low_ask: 33, highest_offer: 12 })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1, p_rows_skipped: 0 })
  })

  it("dupes on one key accumulate best-of: max offer, min ask", async () => {
    state.gqlPages = [
      gqlPage(
        [
          rawEdition({ id: "a", lowAsk: 12, highestOffer: 3 }),
          rawEdition({ id: "b", lowAsk: 9, highestOffer: 5 }),
          rawEdition({ id: "c", lowAsk: null, highestOffer: null }), // contributes nothing
        ],
        null,
      ),
    ]
    const spy = install({})

    await POST(req())
    await runDeferred()

    const rows = (spy.writes.edition_offers ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ external_id: "3:45", low_ask: 9, highest_offer: 5 })
  })

  it("rows with neither offer nor ask are filtered out entirely", async () => {
    state.gqlPages = [gqlPage([rawEdition({ id: "empty" })], null)]
    const spy = install({})
    await POST(req())
    await runDeferred()
    expect(spy.writes.edition_offers ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_rows_found: 1, p_rows_written: 0 })
  })
})

describe("offers-sweep — cursoring + failure honesty", () => {
  it("resumes from the prior tick's cursor and persists the next unwrapped cursor", async () => {
    // A full page (100 nodes) with a fresh cursor -> the tick continues; with
    // MAX_PAGES 40 we stop it after page 2 by returning a short page.
    const fullPage = gqlPage(
      Array.from({ length: 100 }, (_, i) => rawEdition({ id: `e${i}`, lowAsk: 5 })),
      "cursor-B",
    )
    state.gqlPages = [fullPage, gqlPage([rawEdition({ id: "tail", lowAsk: 7 })], "cursor-C")]
    const spy = install({
      pipeline_runs: { data: { cursor_after: "cursor-A" }, error: null },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_cursor_before: "cursor-A", p_cursor_after: null })
    expect((log?.p_extra as Record<string, unknown>).pages).toBe(2)
    expect((log?.p_extra as Record<string, unknown>).wrapped).toBe(true)
  })

  it("UPSTREAM BREAKER — declines the tick, writes a marker, and CARRIES THE CURSOR FORWARD", async () => {
    // The Top Shot GraphQL host 530s when its origin is down. A declined tick
    // must still leave a pipeline_runs row (a gate returning before any write is
    // the 4th cause of cron_silent), and it must NOT reset the sweep to head:
    // the cursor is read from the newest row, so a marker with a null cursor
    // would throw away the whole cycle's progress.
    state.gqlPages = [gqlPage([rawEdition({ id: "should-never-be-fetched", lowAsk: 5 })], null)]
    const spy = install({
      // ⚠ THREE entries, and the first one is not a read. `writeInvocationHeartbeat`
      // INSERTs into pipeline_runs, and an awaited insert consumes a sequence slot
      // just like a select does. Omitting it silently shifts every later payload
      // by one, which presents as "the cursor vanished".
      pipeline_runs: [
        { data: null, error: null }, // 1: the heartbeat insert
        { data: { cursor_after: "cursor-A" }, error: null }, // 2: the cursor read
        {
          data: [
            {
              ok: false,
              error: "Top Shot GraphQL failed with 530. Response body: <head>",
              finished_at: new Date(Date.now() - 60_000).toISOString(),
              extra: null,
            },
          ],
          error: null,
        }, // 3: the breaker read
      ],
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.skipped).toBe("upstream_outage")
    // The cursor survives the decline — this is the assertion that would have
    // caught a marker written with a null cursor.
    expect(log).toMatchObject({ p_cursor_before: "cursor-A", p_cursor_after: "cursor-A" })
    // NULL, not 0: a declined tick measured nothing.
    expect(log?.p_rows_found).toBeNull()
    expect(log?.p_rows_written).toBeNull()
    // And it really did skip the work, rather than doing it and logging a skip.
    expect(spy.writes.edition_offers ?? []).toHaveLength(0)
    expect(state.gqlCursor).toBe(0)
  })

  it("UPSTREAM BREAKER — does NOT decline when the last run succeeded", async () => {
    // Negative control. Without it the test above passes on a breaker that
    // short-circuits unconditionally, which would silently stop the pipeline.
    state.gqlPages = [gqlPage([rawEdition({ id: "e1", lowAsk: 5 })], null)]
    const spy = install({
      pipeline_runs: [
        { data: null, error: null }, // the heartbeat insert
        { data: { cursor_after: "cursor-A" }, error: null }, // the cursor read
        {
          data: [{ ok: true, error: null, finished_at: new Date().toISOString(), extra: null }],
          error: null,
        }, // the breaker read
      ],
    })

    await POST(req())
    await runDeferred()

    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.skipped).toBeUndefined()
    expect(state.gqlCursor).toBeGreaterThan(0)
  })

  it("a mid-sweep GQL failure still upserts what was collected and logs ok=false with the error", async () => {
    state.gqlPages = [
      gqlPage(Array.from({ length: 100 }, (_, i) => rawEdition({ id: `e${i}`, lowAsk: 5 })), "cursor-B"),
      { __throw: "upstream 429" },
    ]
    const spy = install({})

    await POST(req())
    await runDeferred()

    // The partial harvest still landed.
    expect((spy.writes.edition_offers ?? []).flatMap((w) => w.rows)).toHaveLength(1)
    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("upstream 429")
  })

  it("a fatal throw outside the sweep loop still writes the pipeline_runs row (2026-06-11 class)", async () => {
    state.gqlPages = [gqlPage([rawEdition({ id: "e", lowAsk: 5 })], null)]
    const spy = install({
      // Poison the sets-map read: a non-iterable data makes the for..of throw.
      sets: { data: 42 as never, error: null },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("fatal:")
    expect((log?.p_extra as Record<string, unknown>).fatal).toBe(true)
  })

  it("401s without the token", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/cron/offers-sweep", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
