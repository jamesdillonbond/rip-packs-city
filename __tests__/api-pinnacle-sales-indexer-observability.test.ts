import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock, V2_DAPPER_LISTING_COMPLETED } from "./helpers/flow-cdc-fixture"

// PIPELINE OBSERVABILITY — app/api/pinnacle-sales-indexer (added by fa1d356,
// 2026-08-01). Companion to __tests__/pipeline-observability-ingest-routes.ts,
// which pins only the cursor-fail and up_to_date arms; this file drives the
// REMAINING terminal log paths plus the resilience contract around them.
//
// Why each of these is worth a test rather than a coverage number:
//
//  * This route is the ONLY signal that the ingest ran. It is fully synchronous,
//    so "one row per invocation, on every terminal path" is the contract that
//    makes an ABSENT row mean "never reached" instead of "maybe crashed". A path
//    that silently returns without logging re-opens exactly the blind spot the
//    commit closed — 240 pinnacle_sales rows/24h that could only be proven from
//    the destination table.
//  * log_pipeline_run must NEVER be able to take the ingest down. Instrumentation
//    that can fail the thing it instruments is worse than no instrumentation, so
//    both the returned-error and the thrown-error arms are pinned to be swallowed
//    while the route still answers 200 and still writes its sales.
//  * rows_found / rows_written / rows_skipped are the numbers a human reads when
//    deciding whether a quiet tick is healthy. `duped` must land in rows_SKIPPED,
//    not be folded into written (which would read as fabricated throughput) and
//    not be dropped (which would read as loss).
//  * fetchEventRange returning [] on a non-OK HTTP is the silent-loss shape: the
//    cursor still advances over blocks that were never actually read. It is
//    pinned here so the behaviour is at least DELIBERATE and visible in the
//    logged accounting (blocks_scanned counts them, rows_found does not).

const state = vi.hoisted(() => ({
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/pipeline-chain", () => ({
  fireNextPipelineStep: async (path: string, chain: boolean) =>
    void state.chained.push({ path, chain }),
}))

process.env.INGEST_SECRET_TOKEN = "pinnacle-obs-token"
const { POST } = await import("@/app/api/pinnacle-sales-indexer/route")

const PINNACLE_NFT = "A.edf9df96c92f4595.Pinnacle.NFT"
const SEALED = 1300
const CURSOR_START = 1000
const TARGET = 1250 // CURSOR_START + range(250)

function pinnacleSale(
  nftId: string,
  price: string,
  txId: string,
  height: number,
  opts: { commission?: string } = {},
) {
  return eventBlock({
    height,
    txId,
    eventType: V2_DAPPER_LISTING_COMPLETED,
    payload: cdcEvent(V2_DAPPER_LISTING_COMPLETED, {
      listingResourceID: cdc.uint64(9400 + (Number(nftId) % 1000)),
      storefrontResourceID: cdc.uint64(1),
      purchased: cdc.bool(true),
      nftType: cdc.nftType(PINNACLE_NFT),
      nftID: cdc.uint64(nftId),
      salePrice: cdc.ufix64(price),
      commissionReceiver: opts.commission
        ? { type: "Optional", value: { type: "Address", value: opts.commission } }
        : cdc.optionalNull(),
    }),
  })
}

function flowStubs(opts: {
  events?: unknown[]
  eventsStatus?: number
  eventsThrow?: boolean
  sealedHeight?: number
}): FetchStub[] {
  return [
    {
      match: (url) => url.includes("/v1/blocks?height=sealed"),
      respond: () => ({ json: [{ header: { height: String(opts.sealedHeight ?? SEALED) } }] }),
    },
    opts.eventsThrow
      ? {
          match: (url) => url.includes("/v1/events"),
          respond: () => {
            throw new Error("events socket hang up")
          },
        }
      : opts.eventsStatus
        ? {
            match: (url) => url.includes("/v1/events"),
            respond: () => ({ status: opts.eventsStatus!, ok: false, text: "upstream down" }),
          }
        : jsonRoute("/v1/events", opts.events ?? []),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

const req = (qs = "?range=250"): NextRequest =>
  new NextRequest(`https://t/api/pinnacle-sales-indexer${qs}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer pinnacle-obs-token" }),
  })

const cursorFixture = { data: { last_processed_block: CURSOR_START }, error: null }
const logsOf = (spy: ReturnType<typeof install>) =>
  spy.rpcCalls.filter((c) => c.name === "log_pipeline_run").map((c) => c.args as any)

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "pinnacle-obs-token"
  state.chained.length = 0
})

describe("pinnacle-sales-indexer — terminal log paths", () => {
  it("logs phase:no_sales ok:true when the window scanned clean, carrying the cursor move", async () => {
    fetchMock = installFetchMock(flowStubs({ events: [] }))
    const spy = install({ event_cursor: cursorFixture })

    const res = await POST(req())
    expect(res.status).toBe(200)

    const logs = logsOf(spy)
    expect(logs).toHaveLength(1)
    expect(logs[0].p_pipeline).toBe("pinnacle-sales-indexer")
    expect(logs[0].p_collection_slug).toBe("disney_pinnacle")
    expect(logs[0].p_ok).toBe(true)
    expect(logs[0].p_extra.phase).toBe("no_sales")
    // An empty window is WORK, not a no-op: blocks_scanned must be non-zero or
    // a healthy quiet tick is indistinguishable from the up_to_date short-circuit.
    expect(logs[0].p_extra.blocks_scanned).toBe(TARGET - CURSOR_START)
    expect(logs[0].p_extra.chain_height).toBe(SEALED)
    // Cursor endpoints are stringified (the RPC takes text), and must show the
    // window actually advancing.
    expect(logs[0].p_cursor_before).toBe(String(CURSOR_START))
    expect(logs[0].p_cursor_after).toBe(String(TARGET))
    expect(logs[0].p_rows_found).toBe(0)
    expect(logs[0].p_rows_written).toBe(0)
  })

  it("logs phase:complete with duped sales counted as rows_SKIPPED, never as rows_written", async () => {
    // A re-scan legitimately re-sees sales already indexed. Folding those into
    // rows_written would report throughput that did not happen; dropping them
    // entirely would read as loss. They belong in rows_skipped.
    fetchMock = installFetchMock(
      flowStubs({
        events: [
          pinnacleSale("111", "4.00000000", "1".repeat(64), CURSOR_START + 10, {
            commission: "0xaaaaaaaaaaaaaaaa",
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      pinnacle_nft_map: { data: [{ nft_id: "111", edition_key: "RC1:Standard:1" }], error: null },
      pinnacle_sales: { error: { code: "23505", message: "duplicate key value" } },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    const logs = logsOf(spy)
    expect(logs).toHaveLength(1)
    expect(logs[0].p_ok).toBe(true)
    expect(logs[0].p_extra.phase).toBe("complete")
    expect(logs[0].p_rows_found).toBe(1)
    expect(logs[0].p_rows_written).toBe(0)
    expect(logs[0].p_rows_skipped).toBe(1)
    expect(logs[0].p_extra.unique_nft_ids).toBe(1)
    expect(logs[0].p_extra.edition_resolved).toBe(1)
    expect(logs[0].p_extra.sales_unresolved).toBe(0)
  })

  it("logs phase:complete counting an UNRESOLVED sale — written, but reported as unresolved", async () => {
    // The route has no unmapped_sales lane: an unresolvable nft is still written
    // with edition_id null. sales_unresolved is therefore the ONLY signal that
    // the edition-resolution ladder is degrading, so it must be logged.
    fetchMock = installFetchMock(
      flowStubs({
        events: [pinnacleSale("777", "9.00000000", "7".repeat(64), CURSOR_START + 10)],
      }),
    )
    const spy = install({ event_cursor: cursorFixture })

    await POST(req())
    const logs = logsOf(spy)
    expect(logs[0].p_extra.phase).toBe("complete")
    expect(logs[0].p_rows_found).toBe(1)
    expect(logs[0].p_rows_written).toBe(1)
    expect(logs[0].p_extra.edition_resolved).toBe(0)
    expect(logs[0].p_extra.sales_unresolved).toBe(1)
  })

  it("logs phase:fatal ok:false with the thrown message when the scan dies", async () => {
    // The sealed-height probe is outside the chunk try/catch, so a failure there
    // reaches the outer catch. Before fa1d356 this 500'd with NO row at all.
    fetchMock = installFetchMock([
      {
        match: (url) => url.includes("/v1/blocks?height=sealed"),
        respond: () => ({ status: 503, ok: false, text: "sealed down" }),
      },
      jsonRoute("/v1/events", []),
    ])
    const spy = install({ event_cursor: cursorFixture })

    const res = await POST(req())
    expect(res.status).toBe(500)

    const logs = logsOf(spy)
    expect(logs).toHaveLength(1)
    expect(logs[0].p_ok).toBe(false)
    expect(logs[0].p_extra.phase).toBe("fatal")
    expect(String(logs[0].p_error)).toContain("blocks sealed HTTP 503")
    expect(typeof logs[0].p_extra.elapsed_ms).toBe("number")
    // A fatal must not chain the resolver — there is nothing to drain.
    expect(state.chained).toHaveLength(0)
  })
})

describe("pinnacle-sales-indexer — instrumentation must never break the ingest", () => {
  it("swallows a log_pipeline_run ERROR result and still writes sales / answers 200", async () => {
    fetchMock = installFetchMock(
      flowStubs({ events: [pinnacleSale("222", "5.00000000", "2".repeat(64), CURSOR_START + 10)] }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      "rpc:log_pipeline_run": { data: null, error: { message: "pipeline_runs full" } },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, eventsFound: 1, salesInserted: 1 })
    // The sale still landed even though its own audit row failed.
    expect((spy.writes.pinnacle_sales ?? []).flatMap((w) => w.rows)).toHaveLength(1)
  })

  it("swallows a log_pipeline_run THROW and still answers 200", async () => {
    fetchMock = installFetchMock(flowStubs({ events: [] }))
    const spy = makeInstrumentedSupabaseFixture({ event_cursor: cursorFixture })
    const base = (spy.fixture as any).rpc
    ;(spy.fixture as any).rpc = async (name: string, args: unknown) => {
      if (name === "log_pipeline_run") throw new Error("rpc transport exploded")
      return base(name, args)
    }
    state.sb = spy.fixture

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, eventsFound: 0 })
  })
})

describe("pinnacle-sales-indexer — scan resilience (what the logged accounting hides)", () => {
  it("a non-OK /v1/events response holds the cursor and is flagged, exactly like a thrown one", async () => {
    // ⚠ INVERTED 2026-08-21, NOT deleted. This case used to assert
    //   expect(blocks_scanned).toBe(TARGET - CURSOR_START)
    // with a comment calling it "the silent-loss shape ... pinned so the
    // trade-off stays deliberate". It was not a trade-off: `fetchEventRange`
    // swallowed the non-OK into `[]`, the chunk read as GENUINELY EMPTY, the
    // per-chunk cursor write advanced over it, and nothing revisits a block
    // below the cursor. The passing assertion is what held that in place.
    //
    // The property that matters is that an HTTP failure and a thrown failure are
    // INDISTINGUISHABLE from here on — the case below drives the same scenario
    // through a throw and must produce the same outcome.
    fetchMock = installFetchMock(flowStubs({ eventsStatus: 502 }))
    const spy = install({ event_cursor: cursorFixture })

    const res = await POST(req())
    expect(res.status).toBe(200)

    const logs = logsOf(spy)
    expect(logs[0].p_extra.phase).toBe("no_sales")
    expect(logs[0].p_rows_found).toBe(0)
    // ⚠ blocks_scanned now reports what was READ. The old value was the range
    // the tick INTENDED to read — a measured-looking number for blocks nothing
    // ever fetched, which is precisely what made the loss invisible.
    expect(logs[0].p_extra.blocks_scanned).toBe(0)
    expect(logs[0].p_extra.partial_scan).toBe(true)
    expect(logs[0].p_extra.first_failed_chunk).toBe(CURSOR_START + 1)
    // Assert the ABSENCE of movement, not a cursor value.
    expect(logs[0].p_cursor_after).toBe(String(CURSOR_START))
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
  })

  it("a THROWN chunk fetch is isolated per chunk: the cursor holds at the last good chunk", async () => {
    // The per-chunk try/catch means one bad chunk cannot abort the tick. But it
    // also means lastChunkEnd does not advance for that chunk — pinned so the
    // cursor cannot silently jump a range that errored.
    fetchMock = installFetchMock(flowStubs({ eventsThrow: true }))
    const spy = install({ event_cursor: cursorFixture })

    const res = await POST(req())
    expect(res.status).toBe(200)

    const logs = logsOf(spy)
    expect(logs[0].p_extra.phase).toBe("no_sales")
    expect(logs[0].p_cursor_after).toBe(String(CURSOR_START))
    // Nothing was committed to the cursor row either.
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    // ⚠ "the cursor did not move" alone would still pass if the flag were
    // dropped, and the flag is the only thing that makes a held tick legible in
    // pipeline_runs — a held cursor with no flag reads as an idle chain.
    expect(logs[0].p_extra.partial_scan).toBe(true)
    expect(logs[0].p_extra.first_failed_chunk).toBe(CURSOR_START + 1)
  })

  it("a multi-chunk range walks every 250-block chunk and reports the full span", async () => {
    // range=750 -> 3 chunks, which is also the only path that exercises the
    // inter-chunk delay. Verifies the chunk loop advances the cursor to the far
    // end rather than stopping after the first chunk.
    // Sealed height must be well above the window or targetHeight clamps to it.
    fetchMock = installFetchMock(flowStubs({ events: [], sealedHeight: 5000 }))
    const spy = install({ event_cursor: cursorFixture })

    const res = await POST(req("?range=750"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cursor: CURSOR_START + 750 })

    const logs = logsOf(spy)
    expect(logs[0].p_extra.blocks_scanned).toBe(750)
    expect(logs[0].p_extra.chain_height).toBe(5000)
    expect(logs[0].p_cursor_after).toBe(String(CURSOR_START + 750))
  })

  it("an undecodable event payload is skipped without failing the tick", async () => {
    fetchMock = installFetchMock([
      {
        match: (url) => url.includes("/v1/blocks?height=sealed"),
        respond: () => ({ json: [{ header: { height: String(SEALED) } }] }),
      },
      jsonRoute("/v1/events", [
        {
          block_id: "b1",
          block_height: String(CURSOR_START + 10),
          block_timestamp: "2026-07-17T12:00:00Z",
          events: [
            {
              type: V2_DAPPER_LISTING_COMPLETED,
              transaction_id: "d".repeat(64),
              payload: "!!!not-base64-json!!!",
              event_index: 0,
            },
          ],
        },
      ]),
    ])
    const spy = install({ event_cursor: cursorFixture })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const logs = logsOf(spy)
    expect(logs[0].p_ok).toBe(true)
    expect(logs[0].p_rows_found).toBe(0)
    // The chunk itself succeeded, so the cursor DOES advance past the bad event.
    expect(logs[0].p_cursor_after).toBe(String(TARGET))
  })
})
