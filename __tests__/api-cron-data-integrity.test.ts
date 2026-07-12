import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/cron/data-integrity.
// Fail-closed auth: the GET handler requires Bearer INGEST_SECRET_TOKEN exactly
// and 401s otherwise before any integrity/security check. Token is read at
// REQUEST time. The checks run INLINE (no after()), so the success path is
// driven by a chainable @supabase/supabase-js stub (the route calls createClient
// itself) plus an inert sendOpsAlert. Fixtures are shaped to a clean/healthy DB
// (0 security violations, 100% FMV coverage, fresh badges) so the body is
// status:"ok" with issue_count:0. We pin the guard, then assert the clean body.

const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "is", "not"]) s[m] = () => s
  s.single = async () => ({ data: { updated_at: new Date().toISOString() }, error: null })
  s.maybeSingle = async () => ({ data: { updated_at: new Date().toISOString() }, error: null })
  s.rpc = async (name: string) => {
    if (name === "get_fmv_coverage") {
      return {
        data: [{ slug: "nba_top_shot", editions: 100, fmv_editions: 100, coverage_pct: 100 }],
        error: null,
      }
    }
    // check_public_security_invariants → no violations.
    return { data: [], error: null }
  }
  // Terminal awaited reads (editions count queries) resolve to healthy counts.
  s.then = (resolve: any) => resolve({ data: [], error: null, count: 0 })
  return s
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))
vi.mock("@/lib/ops-alert", () => ({ sendOpsAlert: async () => ({ suppressed: false }) }))

import { GET } from "@/app/api/cron/data-integrity/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/data-integrity"),
  }) as any

const savedIngest = process.env.INGEST_SECRET_TOKEN
const url = "https://t/api/cron/data-integrity"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("GET /api/cron/data-integrity — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/cron/data-integrity — success path (inline checks, clean DB)", () => {
  it("200s with status:'ok' and issue_count:0 on a healthy DB", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.issue_count).toBe(0)
    expect(body.issues).toEqual([])
    expect(body.stats.security_invariant_violations).toBe(0)
    expect(body.stats.fmv_coverage_pct).toBe(100)
    expect(typeof body.checked_at).toBe("string")
  })
})
