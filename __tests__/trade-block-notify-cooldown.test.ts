import { describe, it, expect, vi } from "vitest"
import { memorySupabase } from "./helpers/memory-supabase"
import { notifyBlock } from "@/lib/trade-block/notify"

// 2026-11-07 review: Trade Block notices had no durable per-recipient budget, so
// propose → withdraw → propose on one listing emailed the lister once per cycle.
// The trade room fixed this class on 11-04 (CISO M2); the block now mirrors it:
// a budget per (notice, actor, recipient), and a counter that cannot be read is
// a SKIP, never a send.

const LISTER = "aaaaaaaa-0000-4000-8000-000000000001"
const PROPOSER = "bbbbbbbb-0000-4000-8000-000000000002"

function setup() {
  const m = memorySupabase({ profile_bio: [{ user_id: PROPOSER, username: "prop_er" }], email_subscribers: [] })
  const send = vi.fn(async () => ({ ok: true, id: "e1" }) as never)
  const deps = { send, lookupEmail: async () => "lister@example.test", log: () => {} }
  return { m, send, deps }
}

describe("notifyBlock — per-recipient cooldown", () => {
  it("sends while the budget allows (control)", async () => {
    const { m, send, deps } = setup()
    const out = await notifyBlock(m.db, LISTER, PROPOSER, "proposal" as never, { listingCode: "abc" }, { ...deps, cooldown: async () => true })
    expect(out.status).toBe("sent")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("skips — and sends nothing — once the budget is spent", async () => {
    const { m, send, deps } = setup()
    const out = await notifyBlock(m.db, LISTER, PROPOSER, "proposal" as never, { listingCode: "abc" }, { ...deps, cooldown: async () => false })
    expect(out).toEqual({ status: "skipped", reason: "cooldown" })
    expect(send).not.toHaveBeenCalled()
  })

  it("a counter that THROWS is a skip, never a send", async () => {
    const { m, send, deps } = setup()
    const out = await notifyBlock(m.db, LISTER, PROPOSER, "proposal" as never, { listingCode: "abc" }, { ...deps, cooldown: async () => { throw new Error("rpc down") } })
    expect(out).toEqual({ status: "skipped", reason: "cooldown" })
    expect(send).not.toHaveBeenCalled()
  })

  it("the default counter keys the budget on notice × actor × recipient", async () => {
    const { m, send, deps } = setup()
    const calls: Array<Record<string, unknown>> = []
    ;(m.db as unknown as { rpc: unknown }).rpc = async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, ...args })
      return { data: { allowed: true, count: 1 }, error: null }
    }
    await notifyBlock(m.db, LISTER, PROPOSER, "proposal" as never, { listingCode: "abc" }, deps)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ fn: "bump_anon_action_rate", p_bucket: "trade_block_notice:proposal", p_limit: 3, p_window_secs: 3600 })
    expect(send).toHaveBeenCalledTimes(1)
  })
})
