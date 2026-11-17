import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
} from "./helpers/route-harness"

// Covers the three previously-0% admin bridge/diagnostic routes:
//   /api/admin/decode-tx                — Flow REST tx decoder (Quick-Buy fingerprint)
//   /api/admin/pinnacle-render-cache-fill — home-machine render-cache bridge
//   /api/admin/allday-unmapped-fill     — browser-relay unmapped-sales endpoint
// Auth guards + the validation/happy paths, with Supabase + Flow REST stubbed.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

const decodeTx = await import("@/app/api/admin/decode-tx/route")
const renderFill = await import("@/app/api/admin/pinnacle-render-cache-fill/route")
const unmappedFill = await import("@/app/api/admin/allday-unmapped-fill/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(url: string, opts: { method?: string; auth?: boolean; body?: unknown } = {}): NextRequest {
  const headers = new Headers()
  if (opts.auth !== false) headers.set("authorization", "Bearer test-ingest")
  if (opts.body !== undefined) headers.set("content-type", "application/json")
  return new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest"
  // decode-tx uses verifyAdminRequest, which accepts only RPC_ADMIN_TOKEN.
  process.env.RPC_ADMIN_TOKEN = "test-ingest"
  delete process.env.CRON_SECRET
  install({})
})

describe("GET /api/admin/decode-tx", () => {
  const TX = "a".repeat(64)

  it("401s without a token and 400s on a malformed tx id", async () => {
    expect((await decodeTx.GET(req(`https://t/api/admin/decode-tx?tx=${TX}`, { auth: false }))).status).toBe(401)
    expect((await decodeTx.GET(req("https://t/api/admin/decode-tx?tx=nope"))).status).toBe(400)
  })

  it("decodes a Dapper co-signed StorefrontV2 purchase from the Flow REST payload", async () => {
    const script = "import NFTStorefrontV2 from 0x4eb8a10cb9f87357\ntransaction {}"
    fetchMock = installFetchMock([
      jsonRoute("rest-mainnet.onflow.org", {
        script: Buffer.from(script, "utf8").toString("base64"),
        arguments: ["one", "two"],
        payer: "18eb4ee6b3c026d2",
        proposal_key: { address: "ead892083b3e2c6c" },
        authorizers: ["18eb4ee6b3c026d2", "abcdef0123456789"],
        result: {
          events: [
            { type: "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted" },
            { type: "A.0b2a3299cc857e29.TopShot.Deposit" },
            { type: "A.0b2a3299cc857e29.TopShot.Deposit" },
          ],
        },
      }),
    ])

    const res = await decodeTx.GET(req(`https://t/api/admin/decode-tx?tx=${TX}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      tx: TX,
      payer: "0x18eb4ee6b3c026d2",
      proposer: "0xead892083b3e2c6c",
      isDapperCoSigned: true,
      argCount: 2,
      purchasePath: { topshotMarketV3: false, storefrontV2: true, storefrontV1: false },
      eventCount: 3,
    })
    // Histogram is sorted by count desc — the double Deposit leads.
    expect(body.eventSummary[0]).toEqual({ type: "A.0b2a3299cc857e29.TopShot.Deposit", count: 2 })
    expect(body.scriptImports).toEqual(["import NFTStorefrontV2 from 0x4eb8a10cb9f87357"])
    // script only included with ?script=1
    expect(body.script).toBeUndefined()
  })

  it("502s with the spork hint when Flow REST rejects the tx", async () => {
    fetchMock = installFetchMock([jsonRoute("rest-mainnet.onflow.org", {}, { status: 404 })])
    const res = await decodeTx.GET(req(`https://t/api/admin/decode-tx?tx=${TX}`))
    expect(res.status).toBe(502)
    expect((await res.json()).hint).toContain("spork")
  })
})

describe("/api/admin/pinnacle-render-cache-fill", () => {
  const PNG_B64 = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(120),
  ]).toString("base64")

  it("GET returns the referenced-but-uncached render ids", async () => {
    install({
      trophy_moments: {
        data: [
          { thumbnail_url: "/api/public/pinnacle-image/render-abc-123" },
          { thumbnail_url: "/api/public/pinnacle-image/render-def-456" },
          { thumbnail_url: "https://other.example/x.png" },
        ],
        error: null,
      },
      pinnacle_render_cache: { data: [{ render_id: "render-def-456" }], error: null },
    })

    const res = await renderFill.GET(req("https://t/api/admin/pinnacle-render-cache-fill"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe("missing")
    expect(body.needed).toEqual(["render-abc-123"])
  })

  it("POST upserts a validated PNG for a referenced render and logs the pipeline run", async () => {
    const spy = install({
      trophy_moments: {
        data: [{ thumbnail_url: "/api/public/pinnacle-image/render-abc-123" }],
        error: null,
      },
      pinnacle_render_cache: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })

    const res = await renderFill.POST(
      req("https://t/api/admin/pinnacle-render-cache-fill", {
        method: "POST",
        body: { render_id: "render-abc-123", b64: PNG_B64 },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, render_id: "render-abc-123" })

    const upsert = spy.writes.pinnacle_render_cache?.find((w) => w.method === "upsert")
    expect(upsert?.rows[0]).toMatchObject({ render_id: "render-abc-123", mime: "image/png" })
    expect(spy.writes.pipeline_runs?.[0]?.rows[0]).toMatchObject({ pipeline: "pinnacle-render-cache-fill", ok: true })
  })

  it("POST rejects non-image bytes and unreferenced renders", async () => {
    install({
      trophy_moments: {
        data: [{ thumbnail_url: "/api/public/pinnacle-image/render-abc-123" }],
        error: null,
      },
    })

    const notImage = Buffer.alloc(128, 7).toString("base64")
    expect(
      (
        await renderFill.POST(
          req("https://t/api/admin/pinnacle-render-cache-fill", {
            method: "POST",
            body: { render_id: "render-abc-123", b64: notImage },
          }),
        )
      ).status,
    ).toBe(400)

    expect(
      (
        await renderFill.POST(
          req("https://t/api/admin/pinnacle-render-cache-fill", {
            method: "POST",
            body: { render_id: "render-not-pinned", b64: PNG_B64 },
          }),
        )
      ).status,
    ).toBe(422)
  })

  it("401s without a token on both methods", async () => {
    expect((await renderFill.GET(req("https://t/x", { auth: false }))).status).toBe(401)
    expect((await renderFill.POST(req("https://t/x", { method: "POST", auth: false, body: {} }))).status).toBe(401)
  })
})

describe("/api/admin/allday-unmapped-fill", () => {
  it("GET returns resolver targets from the RPC", async () => {
    const spy = install({
      "rpc:get_unmapped_resolver_targets": { data: [{ nft_id: "8675309" }, { nft_id: "1234567" }], error: null },
    })
    const res = await unmappedFill.GET(req("https://t/api/admin/allday-unmapped-fill?limit=50"))
    expect(res.status).toBe(200)
    expect((await res.json()).targets).toEqual(["8675309", "1234567"])
    expect(spy.rpcCalls[0]?.args).toMatchObject({ p_limit: 50 })
  })

  it("POST sanitizes rows (numeric ids only), resolves via the RPC, and summarizes", async () => {
    const spy = install({
      "rpc:resolve_unmapped_sales_for_collection": {
        data: { mapping_upserted: 2, promote_result: { promoted: 5 } },
        error: null,
      },
      pipeline_runs: { data: null, error: null },
    })

    const res = await unmappedFill.POST(
      req("https://t/api/admin/allday-unmapped-fill", {
        method: "POST",
        body: {
          rows: [
            { nft_id: "111", edition_external_id: "222", serial_number: 7 },
            { nft_id: "333", edition_external_id: "444", serial_number: null },
            { nft_id: "drop table sales", edition_external_id: "!!", serial_number: 1 }, // rejected
          ],
        },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ submitted: 3, valid: 2, mappings_written: 2, sales_promoted: 5 })

    const rpc = spy.rpcCalls.find((c) => c.name === "resolve_unmapped_sales_for_collection")
    expect((rpc?.args?.p_rows as unknown[]).length).toBe(2)
  })

  it("guards: 401 unauthed, 400 bad json / empty rows, 422 nothing valid", async () => {
    install({})
    expect((await unmappedFill.POST(req("https://t/x", { method: "POST", auth: false, body: {} }))).status).toBe(401)
    expect((await unmappedFill.POST(req("https://t/x", { method: "POST", body: { rows: [] } }))).status).toBe(400)
    expect(
      (
        await unmappedFill.POST(
          req("https://t/x", { method: "POST", body: { rows: [{ nft_id: "bad!", edition_external_id: "??" }] } }),
        )
      ).status,
    ).toBe(422)
  })
})
