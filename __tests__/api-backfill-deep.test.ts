import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock } from "./helpers/route-harness"

// Deep-drive of POST /api/backfill — the cursor-driven TopShot sales backfill that
// builds its OWN service client (createClient) and walks GQL via raw fetch. Shallow
// suite pins the 401s only. Here we drive the real page loop and assert:
//   - the WRITE contract: a resolvable tx -> a sales insert (currency 'DUC') + the
//     backfill_state cursor/total advance; response totals;
//   - the status:'complete' short-circuit (no network);
//   - an empty GQL page marks the backfill complete;
//   - a 23505 sale insert is counted as a duplicate (not an error);
//   - a GQL failure is caught, parks backfill_state status='error', and returns ok:false.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

const { POST } = await import("@/app/api/backfill/route")

function tx(o: { price?: number; setID?: number; playID?: number } = {}) {
  return {
    id: "tx1",
    price: o.price ?? 12,
    updatedAt: "2026-06-01T10:00:00Z",
    txHash: "0x" + "a".repeat(64),
    moment: {
      id: "m1",
      flowId: "555",
      flowSerialNumber: "9",
      set: { id: "set-uuid", flowName: "Base", flowSeriesNumber: 5 },
      setPlay: { ID: "sp1", flowRetired: false, circulations: { circulationCount: 15000 } },
      parallelSetPlay: { setID: o.setID ?? 3, playID: o.playID ?? 45, parallelID: 0 },
      play: { id: "play-uuid", stats: { playerName: "Damian Lillard" } },
    },
  }
}
// Raw GQL envelope (this route fetches directly, so the top-level `data` is present).
function feed(txs: unknown[], rightCursor: string | null = null) {
  return {
    data: {
      searchMarketplaceTransactions: {
        data: { searchSummary: { pagination: { rightCursor }, data: [{ data: txs }] } },
      },
    },
  }
}
function install(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}
function req(): NextRequest {
  return new NextRequest("https://t/api/backfill", { method: "POST", headers: new Headers() })
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  delete process.env.INGEST_SECRET_TOKEN // token unset -> auth guard is skipped by design
})

describe("backfill — cursor page loop + write contract", () => {
  it("inserts a resolvable sale (currency DUC) and advances backfill_state", async () => {
    const spy = install({
      backfill_state: { data: { status: "running", cursor: null, total_ingested: 0 }, error: null },
      editions: { data: [{ id: "ed-1" }], error: null }, // upsertEdition finds existing
      sales: { error: null },
    })
    fetchMock = installFetchMock([
      { match: (u: string) => u.includes("nbatopshot.com"), respond: () => ({ json: feed([tx()]) }) },
    ])

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, totalThisRun: 1, duplicates: 0, pages: 1, totalOverall: 1 })

    const sale = (spy.writes.sales ?? []).flatMap((w) => w.rows)[0]
    expect(sale).toMatchObject({
      edition_id: "ed-1",
      serial_number: 9,
      price_usd: 12,
      currency: "DUC",
      marketplace: "topshot",
      nft_id: "555",
    })
    // Cursor loop persisted the running-state advance.
    const st = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows)
    expect(st.some((r) => r.total_ingested === 1)).toBe(true)
  })

  it("short-circuits when backfill_state is already complete (no network)", async () => {
    install({ backfill_state: { data: { status: "complete", total_ingested: 99 }, error: null } })
    fetchMock = installFetchMock([{ match: () => true, respond: () => ({ json: feed([]) }) }])

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, message: "Backfill already complete", totalIngested: 99 })
    expect(fetchMock.calls).toHaveLength(0)
  })

  it("marks the backfill complete when the GQL page is empty", async () => {
    const spy = install({
      backfill_state: { data: { status: "running", total_ingested: 5 }, error: null },
    })
    fetchMock = installFetchMock([
      { match: (u: string) => u.includes("nbatopshot.com"), respond: () => ({ json: feed([]) }) },
    ])

    const res = await POST(req())
    const body = await res.json()
    expect(body.message).toContain("no more transactions")
    expect(body.totalOverall).toBe(5)
    const st = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows)
    expect(st[0]).toMatchObject({ status: "complete" })
  })

  it("counts a 23505 sale insert as a duplicate, not a new row", async () => {
    install({
      backfill_state: { data: { status: "running", total_ingested: 0 }, error: null },
      editions: { data: [{ id: "ed-1" }], error: null },
      sales: { error: { code: "23505" } },
    })
    fetchMock = installFetchMock([
      { match: (u: string) => u.includes("nbatopshot.com"), respond: () => ({ json: feed([tx()]) }) },
    ])

    const res = await POST(req())
    const body = await res.json()
    expect(body.totalThisRun).toBe(0)
    expect(body.duplicates).toBe(1)
  })

  it("parks backfill_state status=error and returns ok:false on a GQL failure", async () => {
    const spy = install({
      backfill_state: { data: { status: "running", total_ingested: 0 }, error: null },
    })
    fetchMock = installFetchMock([
      { match: (u: string) => u.includes("nbatopshot.com"), respond: () => ({ status: 500, json: {} }) },
    ])

    const res = await POST(req())
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("GQL 500")
    const st = (spy.writes.backfill_state ?? []).flatMap((w) => w.rows)
    expect(st[0]).toMatchObject({ status: "error" })
  })
})
