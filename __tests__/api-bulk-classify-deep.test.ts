import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock } from "./helpers/route-harness"

// Deep-drive of GET /api/bulk-classify — the SSE moment-classifier. The shallow
// suite only pins the fail-closed 401 (module-const INGEST_TOKEN empty at import).
// Here we set the env BEFORE the dynamic import so the token is live, then drive
// the background streamer end-to-end and assert:
//   - the WRITE contract: a moment with lastPurchasePrice>0 -> moment_acquisitions
//     update {acquisition_method:'marketplace', buy_price, acquired_date, source};
//     a moment with only createdAt -> date-only update on BOTH moment_acquisitions
//     and wallet_moments_cache;
//   - the terminal 'done' summary counters (processed/marketplace/datesFilled/errors);
//   - a GQL abort/timeout is classified as timeouts++ (not an error, no write);
//   - a GQL non-200 degrades to errors++ (never a write);
//   - a Supabase read failure surfaces as a streamed {status:'error'} line;
//   - the 16-char-hex wallet guard (400).
//
// The offset>=total and mid-run TIMEOUT early-return paths are now covered
// (see the "early-return terminal paths" block below). They used to
// double-close the writer (explicit writer.close() before `return`, then the
// `finally` closing it AGAIN → ERR_INVALID_STATE unhandled rejection, exit 1);
// the route was fixed to close once in the `finally`, so these paths now stream
// their terminal line and end cleanly.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

// Module consts (INGEST_TOKEN / TS_GQL / TS_PROXY_SECRET) are captured at import —
// set env FIRST, then import.
process.env.INGEST_SECRET_TOKEN = "ingest-secret"
process.env.TS_PROXY_URL = "https://ts-proxy.test/graphql"
process.env.TS_PROXY_SECRET = "psecret"
const { GET } = await import("@/app/api/bulk-classify/route")

const WALLET_HEX = "bd94cade097e50ac"
const WALLET = "0x" + WALLET_HEX

function req(opts: { token?: string; wallet?: string; offset?: number } = {}): NextRequest {
  const p = new URLSearchParams()
  if (opts.token !== undefined) p.set("token", opts.token)
  if (opts.wallet !== undefined) p.set("wallet", opts.wallet)
  if (opts.offset !== undefined) p.set("offset", String(opts.offset))
  return new NextRequest("https://t/api/bulk-classify?" + p.toString())
}

type MomentEntry = { status?: number; data?: Record<string, unknown> }
function momentStub(map: Record<string, MomentEntry>) {
  return {
    match: (url: string) => url.includes("ts-proxy.test"),
    respond: (_url: string, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body ?? "{}"))?.variables?.momentId
      const entry = map[id]
      if (!entry) return { status: 404, json: {} }
      if (entry.status && entry.status !== 200) return { status: entry.status, json: {} }
      return { json: { data: { getMintedMoment: { data: entry.data } } } }
    },
  }
}

async function collect(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
})

function installSb(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

describe("bulk-classify — classification write contract", () => {
  it("classifies a marketplace buy and fills a date-only moment, writing both tables", async () => {
    const spy = installSb({
      moment_acquisitions: { data: [{ nft_id: "111" }, { nft_id: "222" }], error: null },
      wallet_moments_cache: { data: null, error: null },
    })
    fetchMock = installFetchMock([
      momentStub({
        "111": { data: { flowId: "111", lastPurchasePrice: 50, createdAt: "2026-01-01T00:00:00Z" } },
        "222": { data: { flowId: "222", lastPurchasePrice: null, createdAt: "2026-02-02T00:00:00Z" } },
      }),
    ])

    const res = await GET(req({ token: "ingest-secret", wallet: WALLET }))
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
    const lines = await collect(res)

    const done = lines.find((l) => l.status === "done")
    expect(done).toMatchObject({
      total: 2,
      processed: 2,
      marketplace: 1,
      datesFilled: 2,
      timeouts: 0,
      errors: 0,
      nextOffset: null,
      remaining: 0,
    })

    // Marketplace acquisition update carries the full classification payload.
    const acqWrites = (spy.writes.moment_acquisitions ?? []).flatMap((w) => w.rows)
    const mk = acqWrites.find((r) => r.acquisition_method === "marketplace")
    expect(mk).toMatchObject({
      acquisition_method: "marketplace",
      buy_price: 50,
      acquired_date: "2026-01-01T00:00:00Z",
      source: "bulk_classify",
    })
    // Date-only side also touched wallet_moments_cache.acquired_at.
    const wmc = (spy.writes.wallet_moments_cache ?? []).flatMap((w) => w.rows)
    expect(wmc.some((r) => r.acquired_at === "2026-01-01T00:00:00Z" || r.acquired_at === "2026-02-02T00:00:00Z")).toBe(true)
  })

  it("classifies a GQL abort/timeout as a timeout (not an error) and writes nothing", async () => {
    const spy = installSb({ moment_acquisitions: { data: [{ nft_id: "111" }], error: null } })
    fetchMock = installFetchMock([
      {
        match: (url: string) => url.includes("ts-proxy.test"),
        respond: () => {
          const e = new Error("aborted")
          e.name = "TimeoutError"
          throw e
        },
      },
    ])

    const res = await GET(req({ token: "ingest-secret", wallet: WALLET }))
    const lines = await collect(res)
    const done = lines.find((l) => l.status === "done")
    expect(done).toMatchObject({ processed: 1, timeouts: 1, errors: 0, marketplace: 0 })
    expect(spy.writes.moment_acquisitions ?? []).toHaveLength(0)
  })

  it("counts a GQL non-200 as an error and writes nothing", async () => {
    const spy = installSb({ moment_acquisitions: { data: [{ nft_id: "999" }], error: null } })
    fetchMock = installFetchMock([momentStub({ "999": { status: 500 } })])

    const res = await GET(req({ token: "ingest-secret", wallet: WALLET }))
    const lines = await collect(res)
    const done = lines.find((l) => l.status === "done")
    expect(done).toMatchObject({ processed: 1, marketplace: 0, datesFilled: 0, errors: 1 })
    expect(spy.writes.moment_acquisitions ?? []).toHaveLength(0)
  })

  it("streams a {status:'error'} line when the initial Supabase read fails", async () => {
    installSb({ moment_acquisitions: { data: null, error: { message: "db exploded" } } })
    fetchMock = installFetchMock([momentStub({})])

    const res = await GET(req({ token: "ingest-secret", wallet: WALLET }))
    const lines = await collect(res)
    const err = lines.find((l) => l.status === "error")
    expect(String(err?.error)).toContain("db exploded")
  })

  it("400s on a wallet that is not 16-char hex (before the stream opens)", async () => {
    installSb({})
    fetchMock = installFetchMock([momentStub({})])
    const res = await GET(req({ token: "ingest-secret", wallet: "0xnothex" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("16-char hex")
  })
})

// These paths regression-guard the double-close fix: each used to emit its
// terminal line and then crash the process with an ERR_INVALID_STATE unhandled
// rejection. A clean collect() (stream ends without throwing) is the assertion
// that the writer is now closed exactly once.
describe("bulk-classify — early-return terminal paths (double-close fix)", () => {
  it("emits a 'done' with processed:0 when offset >= total, closing once", async () => {
    installSb({ moment_acquisitions: { data: [{ nft_id: "111" }], error: null } })
    fetchMock = installFetchMock([momentStub({})])

    // total = 1, requestedOffset = 5 -> offset>=total early return.
    const res = await GET(req({ token: "ingest-secret", wallet: WALLET, offset: 5 }))
    const lines = await collect(res)
    const done = lines.find((l) => l.status === "done")
    expect(done).toMatchObject({ total: 1, processed: 0, nextOffset: null, remaining: 0 })
    // The 'started' line reports the requested offset back.
    expect(lines.find((l) => l.status === "started")).toMatchObject({ offset: 5 })
  })

  it("emits a 'timeout' terminal line when the wall-clock budget trips, closing once", async () => {
    installSb({ moment_acquisitions: { data: [{ nft_id: "111" }, { nft_id: "222" }], error: null } })
    fetchMock = installFetchMock([momentStub({})])

    // The route calls Date.now() once for startTime, then again in the loop's
    // budget check. Force the second call past the 55s TIME_LIMIT so the very
    // first batch trips the timeout branch (processed:0) before any GQL work.
    let calls = 0
    const now = vi.spyOn(Date, "now").mockImplementation(() => (++calls <= 1 ? 1_000_000 : 1_060_000))
    try {
      const res = await GET(req({ token: "ingest-secret", wallet: WALLET }))
      const lines = await collect(res)
      const to = lines.find((l) => l.status === "timeout")
      expect(to).toMatchObject({ total: 2, processed: 0, nextOffset: 0, remaining: 2 })
      // No terminal 'done' — the run short-circuited on the budget.
      expect(lines.find((l) => l.status === "done")).toBeUndefined()
    } finally {
      now.mockRestore()
    }
  })
})
