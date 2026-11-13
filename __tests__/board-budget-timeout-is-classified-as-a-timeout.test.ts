import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { __marker: "service-role" } }))

import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { apiErrorResponse } from "@/lib/api-error"
import { RPC_READ_TIMEOUT_CODE } from "@/lib/api/bounded-read"

// 2026-11-13. `withBoardBudget` is a PAGE helper, but six API routes bound their
// reads with it too (profile/top-movers, profile/collector-identities,
// players/follow, profile/account, two Panini walk crons) and hand the rejection
// to `apiErrorResponse`. Its rejection was a bare Error — no code — and its
// message ("read exceeded 8000ms") matches none of the timeout tokens, so the
// route answered OUR OWN bound firing as `internal`, non-retryable, status 500.
// Vercel, 7 d to 11-13: `[api/profile/top-movers] code=internal detail=[…]
// read exceeded 24935ms` and `[api/profile/collector-identities] code=internal
// detail=[…panini_owner_summary] read exceeded 8000ms`. Same defect the
// 2026-09-04 note in lib/api-error.ts records for `boundedRead`.

async function overrun(): Promise<unknown> {
  try {
    await withBoardBudget(new Promise<never>(() => {}), "slow_read", 10, "api/test/")
  } catch (err) {
    return err
  }
  throw new Error("withBoardBudget resolved a read that never settles")
}

describe("a withBoardBudget overrun reaches an API caller as a TIMEOUT", () => {
  it("rejects with the shared read-timeout code", async () => {
    const err = (await overrun()) as { code?: unknown; message?: unknown }
    expect(err.code).toBe(RPC_READ_TIMEOUT_CODE)
    expect(String(err.message)).toMatch(/^\[api\/test\/slow_read\] read exceeded 10ms$/)
  })

  it("is NOT answered as a permanent internal 500 by apiErrorResponse", async () => {
    const res = apiErrorResponse(await overrun(), "api/test")
    const body = (await res.json()) as { code: string; retryable: boolean }
    expect(res.status).not.toBe(500)
    expect(body.code).not.toBe("internal")
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
  })

  it("leaves a read that settles in time untouched (control)", async () => {
    await expect(withBoardBudget(Promise.resolve("ok"), "fast", 1_000)).resolves.toBe("ok")
    await expect(withBoardBudget(Promise.reject(new Error("boom")), "fail", 1_000)).rejects.toThrow("boom")
  })
})
