import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// /api/profile/top-movers runs get_top_movers ONCE PER SAVED WALLET, sequentially.
// Before 2026-09-03 nothing bounded the calls or their number, so a collector
// with more wallets waited longer without limit until the platform killed the
// function — no body, so TopMoversCard's honest failure branch (it discriminates
// on res.ok) was unreachable. The fix is ONE total deadline per request, each
// read bounded by what is LEFT of it, checked BEFORE each call.
//
// ⚠ These cases pin the TOTAL, not a per-read bound: a per-read bound of N still
// lets ten wallets run 10·N, and the "six slow wallets must STOP" case below is
// the one that separates the two. Fake timers drive the clock; the mocked reads
// resolve on (faked) setTimeout so each one has a real duration.

const st: { user: any; single: any; wallets: any; moverMs: number | ((addr: string) => number); calls: string[] } = {
  user: null,
  single: { data: { user_id: "u1" }, error: null },
  wallets: { data: [], error: null },
  moverMs: 0,
  calls: [],
}

function later<T>(ms: number, v: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(v), ms))
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      ilike: () => b,
      maybeSingle: () => (st.single instanceof Promise ? st.single : Promise.resolve(st.single)),
    }
    return b
  }
  const client: any = {
    from: () => build(),
    rpc: (fn: string, params: any) => {
      if (fn === "get_user_saved_wallets") return st.wallets instanceof Promise ? st.wallets : Promise.resolve(st.wallets)
      st.calls.push(params.p_wallet)
      const ms = typeof st.moverMs === "function" ? st.moverMs(params.p_wallet) : st.moverMs
      const body = {
        data: {
          gainers: [{ edition_id: "g-" + params.p_wallet, player_name: "P", set_name: "S", current_fmv: 10, past_fmv: 5, delta: 5, pct_change: 100 }],
          losers: [],
        },
        error: null,
      }
      return ms > 0 ? later(ms, body) : Promise.resolve(body)
    },
  }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => st.user }))

import { GET, TOP_MOVERS_TOTAL_BUDGET_MS } from "@/app/api/profile/top-movers/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const sixWallets = () => ({
  data: [1, 2, 3, 4, 5, 6].map((i) => ({ wallet_addr: "0x" + String(i).repeat(16), username: null, collection_id: null, collection_slug: null, nickname: null, cached_fmv_usd: null })),
  error: null,
})

/** Run GET while draining the fake clock until it settles or `maxMs` elapses. */
async function run(url: string, maxMs = TOP_MOVERS_TOTAL_BUDGET_MS * 4) {
  let settled: Response | null = null
  const p = GET(req(url)).then((r) => { settled = r; return r })
  let elapsed = 0
  while (!settled && elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(1_000)
    elapsed += 1_000
  }
  return { res: await p, elapsedMs: elapsed }
}

beforeEach(() => {
  vi.useFakeTimers()
  st.user = null
  st.single = { data: { user_id: "u1" }, error: null }
  st.wallets = { data: [], error: null }
  st.moverMs = 0
  st.calls = []
})
afterEach(() => { vi.useRealTimers() })

describe("/api/profile/top-movers — one TOTAL budget", () => {
  it("no-change control: six FAST wallets still answer 200 with merged movers", async () => {
    st.wallets = sixWallets()
    const { res } = await run("https://t/api/profile/top-movers?ownerKey=trevor")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(st.calls.length).toBe(6)
    expect(body.gainers.length).toBe(5) // top 5 of six merged
    expect(body.meta).toBeUndefined()
  })

  it("the budget is TOTAL, not per read: six wallets × 10 s must STOP, not finish", async () => {
    st.wallets = sixWallets()
    st.moverMs = 10_000
    const { res, elapsedMs } = await run("https://t/api/profile/top-movers?ownerKey=trevor")
    expect(res.status).toBeGreaterThanOrEqual(500)
    // Two reads fit (20 s); the third starts with 5 s left and is cut at 25 s.
    // A PER-READ bound of 25 s would have let all six run (60 s) and answered 200.
    expect(st.calls.length).toBe(3)
    expect(elapsedMs).toBeLessThanOrEqual(TOP_MOVERS_TOTAL_BUDGET_MS + 1_000)
    const body = await res.json()
    expect(body.gainers).toBeUndefined() // never a partial list dressed as the whole
  })

  it("the deadline is checked BEFORE each call: an exhausted budget refuses even an instant read", async () => {
    // Two reads of exactly half the budget each leave 0 ms; the remaining
    // four are instant. Deleting the pre-call check lets them run (an instant
    // promise beats a 1 ms timer) and answers 200 on a request that overran.
    st.wallets = sixWallets()
    const half = TOP_MOVERS_TOTAL_BUDGET_MS / 2
    st.moverMs = (addr) => (addr.startsWith("0x1") || addr.startsWith("0x2") ? half : 0)
    const { res } = await run("https://t/api/profile/top-movers?ownerKey=trevor")
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(st.calls.length).toBe(2)
  })

  it("a single read that never answers is cut at the budget with a 5xx, not a platform kill", async () => {
    st.wallets = { data: [sixWallets().data[0]], error: null }
    st.moverMs = 10 * TOP_MOVERS_TOTAL_BUDGET_MS
    const { res, elapsedMs } = await run("https://t/api/profile/top-movers?ownerKey=trevor")
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(elapsedMs).toBeLessThanOrEqual(TOP_MOVERS_TOTAL_BUDGET_MS + 1_000)
  })

  it("the saved-wallets read and the owner resolve share the same budget", async () => {
    st.wallets = new Promise(() => {}) // never resolves
    const a = await run("https://t/api/profile/top-movers?ownerKey=trevor")
    expect(a.res.status).toBeGreaterThanOrEqual(500)
    expect(a.elapsedMs).toBeLessThanOrEqual(TOP_MOVERS_TOTAL_BUDGET_MS + 1_000)

    st.wallets = sixWallets()
    st.single = new Promise(() => {})
    const b = await run("https://t/api/profile/top-movers?ownerKey=trevor")
    expect(b.res.status).toBeGreaterThanOrEqual(500)
    expect(b.elapsedMs).toBeLessThanOrEqual(TOP_MOVERS_TOTAL_BUDGET_MS + 1_000)
    // and it never claimed the collector does not exist
    const body = await b.res.json()
    expect(body?.meta?.owner_not_found).toBeUndefined()
  })
})
