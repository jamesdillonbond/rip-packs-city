import { describe, it, expect, vi, beforeEach } from "vitest"
import { refreshAllDayWalletLocks } from "@/lib/allday-lock"

// Unit test for the All Day on-chain lock diff. Locked All Day moments leave the
// wallet's on-chain collection, so anything cached but NOT returned on-chain is
// locked. We mock Flow REST (one window) and a chainable Supabase stub.

// Encode a Cadence [[UInt64]] result the way Flow REST returns it: a
// quote-wrapped base64 of the JSON-CDC envelope.
function flowRestBody(ids: string[]): string {
  const envelope = {
    type: "Array",
    value: ids.map((id) => ({
      type: "Array",
      value: [
        { type: "UInt64", value: id },
        { type: "UInt64", value: "1" },
        { type: "UInt64", value: "1" },
      ],
    })),
  }
  const b64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64")
  return JSON.stringify(b64) // adds the surrounding quotes the helper strips
}

function makeSupabase(cacheRows: Array<{ moment_id: string; is_locked: boolean }>) {
  const updates: Array<Record<string, unknown>> = []
  const sb: any = {
    _updates: updates,
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    in: () => sb,
    update: (payload: Record<string, unknown>) => {
      updates.push(payload)
      return sb
    },
    then: (resolve: any) => resolve({ data: cacheRows, error: null }),
  }
  return sb
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("refreshAllDayWalletLocks", () => {
  it("marks cached-but-not-on-chain moments as locked and stamps every row", async () => {
    // On-chain (unlocked) returns only m1; m2 is cached but absent → locked.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(flowRestBody(["m1"]), { status: 200 }))
    )
    const sb = makeSupabase([
      { moment_id: "m1", is_locked: false },
      { moment_id: "m2", is_locked: false },
    ])

    const r = await refreshAllDayWalletLocks("0xabc", sb)

    expect(r.total_cached).toBe(2)
    expect(r.unlocked_onchain).toBe(1)
    expect(r.marked_locked).toBe(1) // m2
    expect(r.marked_unlocked).toBe(0)
    // A lock flip write + the freshness stamp both carry lock_checked_at.
    expect(sb._updates.some((u: any) => u.is_locked === true && u.lock_checked_at)).toBe(true)
    expect(sb._updates.some((u: any) => u.lock_checked_at && u.is_locked === undefined)).toBe(true)
  })

  it("unlocks a stale-locked moment that is back on-chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(flowRestBody(["m1"]), { status: 200 }))
    )
    const sb = makeSupabase([{ moment_id: "m1", is_locked: true }])
    const r = await refreshAllDayWalletLocks("0xabc", sb)
    expect(r.marked_unlocked).toBe(1)
    expect(r.marked_locked).toBe(0)
  })
})
