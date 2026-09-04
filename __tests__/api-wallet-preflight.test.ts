import { describe, it, expect, afterEach, vi } from "vitest"

// Route integration test for GET /api/wallet-preflight. Read-only on-chain
// diagnostic: three pre-network 400 guards (invalid address / unknown collection
// / out-of-range count), then a Flow REST script call whose base64 JSON-Cadence
// result is decoded + flattened. Beyond the guards this drives the success path
// (exercising the flattenJsonCadence type branches — Bool/UInt/UFix64/Path/
// Optional/Array/Dictionary/Struct — plus the storage-MB derivations) and every
// upstream failure mode (fetch throw / non-ok / bad JSON / non-object shape).

import { GET } from "@/app/api/wallet-preflight/route"

const req = (u: string) => ({ url: u }) as any
const ADDR = "0xbd94cade097e50ac"
const good = (extra = "") => `https://t/api/wallet-preflight?address=${ADDR}&collection=topshot${extra}`

// Flow REST /scripts returns the result as a JSON string wrapping a base64 blob
// of the JSON-Cadence value. Reproduce that envelope.
function flowRestBody(cadence: unknown): string {
  const b64 = Buffer.from(JSON.stringify(cadence), "utf8").toString("base64")
  return JSON.stringify(b64) // the outer quotes the route strips
}

function stubFlow(body: string, ok = true, status = 200) {
  const f = vi.fn(async () => ({ ok, status, text: async () => body }))
  vi.stubGlobal("fetch", f as any)
  return f
}

// A preflight Struct whose fields exercise many flattener branches.
const PREFLIGHT_STRUCT = {
  type: "Struct",
  value: {
    id: "s.Preflight",
    fields: [
      { name: "storageUsed", value: { type: "UInt64", value: "1048576" } }, // 1 MB
      { name: "storageCapacity", value: { type: "UInt64", value: "2097152" } }, // 2 MB
      { name: "storageHeadroom", value: { type: "UInt64", value: "524288" } }, // 0.5 MB
      { name: "hasCollection", value: { type: "Bool", value: true } },
      { name: "ratio", value: { type: "UFix64", value: "1.5" } },
      { name: "note", value: { type: "Optional", value: null } },
      { name: "counts", value: { type: "Array", value: [{ type: "UInt32", value: "3" }] } },
      {
        name: "meta",
        value: { type: "Dictionary", value: [{ key: { type: "String", value: "k" }, value: { type: "String", value: "v" } }] },
      },
      { name: "colPath", value: { type: "Path", value: { domain: "public", identifier: "MomentCollection" } } },
    ],
  },
}

describe("GET /api/wallet-preflight — input guards", () => {
  it("400s on a missing/invalid address", async () => {
    expect((await GET(req("https://t/api/wallet-preflight"))).status).toBe(400)
    expect((await GET(req("https://t/api/wallet-preflight?address=nope"))).status).toBe(400)
  })
  it("400s on an unknown collection", async () => {
    expect((await GET(req(`https://t/api/wallet-preflight?address=${ADDR}&collection=nope`))).status).toBe(400)
  })
  it("400s on an out-of-range count", async () => {
    expect((await GET(req(good("&count=0")))).status).toBe(400)
    expect((await GET(req(good("&count=5000")))).status).toBe(400)
  })
})

describe("GET /api/wallet-preflight — Flow REST success path", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("decodes + flattens the preflight struct and derives storage-MB fields", async () => {
    stubFlow(flowRestBody(PREFLIGHT_STRUCT))
    const res = await GET(req(good()))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      address: ADDR,
      collection: "topshot",
      collectionPath: "/public/MomentCollection",
      // flattened cadence fields
      storageUsed: 1048576,
      hasCollection: true,
      ratio: 1.5, // UFix64 → float
      note: null, // Optional(null)
      counts: [3], // Array<UInt32>
      meta: { k: "v" }, // Dictionary
      colPath: "/public/MomentCollection", // Path
      // derived MB
      storageUsedMB: 1,
      storageCapacityMB: 2,
      storageHeadroomMB: 0.5,
    })
    expect(typeof body.fetchedAt).toBe("string")
  })
})

describe("GET /api/wallet-preflight — upstream failure modes", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("502s when the Flow REST request throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }) as any)
    const res = await GET(req(good()))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Flow REST request failed/)
  })

  it("502s when the BODY read rejects after the headers arrived (the signal stays live for the body)", async () => {
    // The 09-03 body-outside-catch class: an AbortSignal attached to the fetch also
    // times out the body read. Before the fix this rejected outside the try and the
    // route threw — a 500 where a 502 was owed.
    const err = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => { throw err } })) as any)
    const res = await GET(req(good()))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Flow REST body read failed/)
  })

  it("502s on a non-ok HTTP response", async () => {
    stubFlow("upstream error", false, 500)
    const res = await GET(req(good()))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/HTTP 500/)
  })

  it("502s when the decoded body is not valid JSON", async () => {
    // base64 of a non-JSON string
    const b64 = Buffer.from("this is not json", "utf8").toString("base64")
    stubFlow(JSON.stringify(b64))
    const res = await GET(req(good()))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/parse Flow response as JSON/)
  })

  it("502s when the flattened value is not an object (unexpected shape)", async () => {
    // A bare String flattens to "x" — not the expected struct object
    stubFlow(flowRestBody({ type: "String", value: "x" }))
    const res = await GET(req(good()))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Unexpected JSON-Cadence shape/)
  })
})
