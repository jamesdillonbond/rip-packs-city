import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/fmv-recalc (POST + GET alias) — the FMV
// pipeline whose silent stall (2026-05-25) shipped green because nothing drove
// its success path. Token gate: Bearer INGEST_SECRET_TOKEN or CRON_SECRET, read
// at REQUEST time. Fail-closed priority — 500 when the secret is unset, 401 on
// no / wrong token, and 200 "FMV recalc triggered" once authed. The paginated
// sweep runs inside after() (stubbed no-op) and the resume-cursor read hits a
// chainable Supabase stub, so the immediate ack is observable without DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
const sbChain: any = {
  select: () => sbChain,
  eq: () => sbChain,
  order: () => sbChain,
  limit: () => sbChain,
  maybeSingle: async () => ({ data: null, error: null }),
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))

import { POST, GET } from "@/app/api/fmv-recalc/route"

const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET
const url = "https://t/api/fmv-recalc"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  delete process.env.CRON_SECRET
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("POST /api/fmv-recalc — auth guards", () => {
  it("500s when INGEST_SECRET_TOKEN is not set (fail-closed misconfig)", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("INGEST_SECRET_TOKEN not set")
  })

  it("401s with no authorization header", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer nope" }))).status).toBe(401)
  })

  it("GET alias enforces the same auth (401 without a token)", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
  })
})

describe("POST /api/fmv-recalc — success path (immediate ack, sweep deferred)", () => {
  it("200s and reports 'FMV recalc triggered' with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("FMV recalc triggered")
    expect(typeof body.triggeredAt).toBe("string")
  })

  it("also accepts CRON_SECRET as the bearer token", async () => {
    process.env.CRON_SECRET = "test-cron-secret"
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
  })
})

// 2026-11-07 review: an "auth debug" line logged 8 characters of the ingest secret
// (and of the caller's bearer) on every request; and a failed cursor read silently
// restarted the sweep at page 0.
describe("POST /api/fmv-recalc — no token in the logs; a failed cursor read does not guess", () => {
  it("logs no part of the expected secret or of the presented bearer", async () => {
    const lines: string[] = []
    const spies = (["log", "warn", "error", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")) }),
    )
    try {
      await POST(makeReq({ url, auth: "Bearer attacker-chosen-string" }))
      await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
    const all = lines.join("\n")
    expect(all).not.toContain("test-ing")
    expect(all).not.toContain("attacker")
  })

  it("a FAILED cursor read is a retryable 503 — never a silent restart at offset 0", async () => {
    const orig = sbChain.maybeSingle
    sbChain.maybeSingle = async () => ({ data: null, error: { message: "canceling statement due to statement timeout" } })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ retryable: true })
    } finally {
      sbChain.maybeSingle = orig
      err.mockRestore()
    }
  })
})

