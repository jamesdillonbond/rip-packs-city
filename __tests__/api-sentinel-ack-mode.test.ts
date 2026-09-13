import { describe, it, expect, beforeEach, vi } from "vitest"

// CRON-30S ack mode for POST /api/sentinel?ack=1.
//
// WHY THIS EXISTS. The sentinel's own measured wall is 62.4s avg / 162.4s max
// (pipeline_runs, 21 completed runs, read 2026-09-12). cron-job.org aborts at
// 30s, marks the run FAILED, and auto-disables the entry after enough of those —
// the exact class that silently killed nine entries for two days on 2026-09-10
// (register #76). So the cron-job.org caller passes ?ack=1, gets 202 at once,
// and the sweep runs to completion in after() on the same invocation.
//
// The thing worth pinning is NOT that a 202 comes back — it is that the 202
// carries NO VERDICT. A dispatch receipt that rendered as an all-clear would be
// the same lie as a failed read rendering as an answer. If someone ever adds
// `status` or `checks_run` to this response "so the caller can see it", these
// tests go red, and they should: the answer lives in pipeline_runs and in the
// notification channels, never in the ack body.

const afterCalls: Array<(...a: any[]) => any> = []

vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>()
  return {
    ...mod,
    after: (fn: any) => {
      afterCalls.push(fn)
    },
  }
})

import { NextRequest } from "next/server"
import { POST } from "@/app/api/sentinel/route"

const TOKEN = "test-sentinel-token"

function post(url: string, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest(url, { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  afterCalls.length = 0
})

describe("POST /api/sentinel?ack=1 (CRON-30S)", () => {
  it("202s immediately and hands the sweep to after()", async () => {
    const res = await POST(post("https://t/api/sentinel?ack=1", `Bearer ${TOKEN}`))
    expect(res.status).toBe(202)
    expect(afterCalls).toHaveLength(1)
    expect(typeof afterCalls[0]).toBe("function")
  })

  it("⚠ the 202 body carries NO verdict — it is a receipt, not an all-clear", async () => {
    const res = await POST(post("https://t/api/sentinel?ack=1", `Bearer ${TOKEN}`))
    const body = await res.json()
    // Exact key set: anything added here is a verdict a caller could misread.
    expect(Object.keys(body).sort()).toEqual(["accepted", "mode"])
    expect(body).toEqual({ accepted: true, mode: "ack" })
    for (const k of ["status", "checks", "checks_run", "critical", "warn", "ok", "notifications"]) {
      expect(body).not.toHaveProperty(k)
    }
  })

  it("⚠ the Bearer guard runs BEFORE the ack dispatch — no token, no sweep", async () => {
    const res = await POST(post("https://t/api/sentinel?ack=1", "Bearer wrong"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
    expect(afterCalls).toHaveLength(0)
  })

  it("401s in ack mode with no authorization header at all", async () => {
    const res = await POST(post("https://t/api/sentinel?ack=1"))
    expect(res.status).toBe(401)
    expect(afterCalls).toHaveLength(0)
  })

  it("only the exact value ack=1 dispatches — ack=0 / ack=true do not", async () => {
    // The ack branch is decided SYNCHRONOUSLY, before the route's first await,
    // so we can fire the call and inspect after() without ever awaiting the
    // fall-through — which would otherwise sit on live Supabase forever. The
    // dangling promise is caught so a rejected live path cannot fail the run.
    for (const q of ["ack=0", "ack=true", "ack="]) {
      afterCalls.length = 0
      void POST(post(`https://t/api/sentinel?${q}`, `Bearer ${TOKEN}`)).catch(() => {})
      await Promise.resolve()
      expect(afterCalls, `?${q} must not dispatch`).toHaveLength(0)
    }
  })
})

describe("the sentinel route's own budget", () => {
  it("⚠ maxDuration still covers the measured 162.4s worst case", async () => {
    const mod: any = await import("@/app/api/sentinel/route")
    expect(mod.maxDuration).toBeGreaterThanOrEqual(180)
  })
})
