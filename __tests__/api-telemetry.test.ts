import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/telemetry. A beacon endpoint that always
// returns 204 (bad JSON, missing/invalid feature, and valid inserts alike) so
// telemetry never surfaces as a UI error. Identity resolves to "anon" in-test
// (getCurrentUser swallows the missing cookie). The insert is fire-and-forget.
// Mocks supabaseAdmin so the .from().insert().then() chain is a no-op.

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({ insert: () => ({ then: (cb: any) => cb({ error: null }) }) }) },
}))

import { POST } from "@/app/api/telemetry/route"

const req = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad"); return body } }) as any

describe("POST /api/telemetry", () => {
  it("204s on malformed JSON", async () => {
    expect((await POST(req(null, true))).status).toBe(204)
  })
  it("204s when the feature is missing/blank", async () => {
    expect((await POST(req({}))).status).toBe(204)
    expect((await POST(req({ feature: "   " }))).status).toBe(204)
  })
  it("204s on a valid telemetry beacon", async () => {
    expect((await POST(req({ feature: "opened-sniper", metadata: { a: 1 } }))).status).toBe(204)
  })
})
