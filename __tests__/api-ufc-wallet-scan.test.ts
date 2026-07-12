import { describe, it, expect } from "vitest"

// Route integration test for POST /api/ufc-wallet-scan. Pins the pre-network
// guards: malformed JSON → 400, a non-0x wallet → 400, and (with a valid 0x
// wallet) a 500 because INGEST_SECRET_TOKEN is unconfigured in-test — all before
// any Supabase edge-function call. NOTE: the scan/enrich fan-out is out of scope.

import { POST } from "@/app/api/ufc-wallet-scan/route"

const req = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad"); return body } }) as any

describe("POST /api/ufc-wallet-scan", () => {
  it("400s on malformed JSON", async () => {
    expect((await POST(req(null, true))).status).toBe(400)
  })
  it("400s when the wallet is not 0x-prefixed", async () => {
    expect((await POST(req({ wallet: "curry" }))).status).toBe(400)
  })
  it("500s when INGEST_SECRET_TOKEN is unconfigured (valid 0x wallet)", async () => {
    const res = await POST(req({ wallet: "0xbd94cade097e50ac" }))
    expect(res.status).toBe(500)
  })
})
