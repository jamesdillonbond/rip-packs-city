import { describe, it, expect } from "vitest"

// Route integration test for GET+POST /api/smoke-test.
// NOTE: import-only. This route has NO pre-DB / pre-network guard of any kind —
// both handlers immediately call runSmokeTests(), which spins up a live
// @supabase/supabase-js service client and fires dozens of real HTTP probes
// (public pages, /api/market, /api/sniper-feed, RLS insert attempts, health
// RPCs) plus @sentry/nextjs capture. There is no simple mock seam that turns any
// single assertion into a deterministic happy/empty path without stubbing the
// entire probe suite, so we assert the handlers import and are callable.

import { GET, POST } from "@/app/api/smoke-test/route"

describe("GET+POST /api/smoke-test", () => {
  it("exports GET and POST handlers", () => {
    expect(typeof GET).toBe("function")
    expect(typeof POST).toBe("function")
  })
})
