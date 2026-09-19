import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// The GET arm of /api/cron/panini-ingest: the walk ORDER the residential Panini runner uses.
//
// WHY THIS FILE EXISTS, AND WHY THE `complete` FLAG IS THE THING IT PINS.
// The runner classifies an enumerated psku as a BRAND-NEW discovery when it is absent from this
// response, and walks brand-new discoveries FIRST (a card with no row has no price at all). That
// test is only sound when the response is the COMPLETE catalogue. The first version of this route
// returned the stalest 1,000 — under which every RECENTLY WALKED edition is also absent, so it
// reads as "brand new" and gets promoted to the front of the queue. The grid surfaces the most
// actively listed cards, i.e. the ones walked most recently, so that would have put hundreds of
// already-fresh editions ahead of the stale backlog the whole change exists to drain.
//
// ⭐ The durable shape: an "absent from the list" test is only as good as the list's COMPLETENESS,
// and a bound chosen for the reader's convenience silently redefines what absence means. So the
// route must never claim `complete` when it paged off or trimmed anything, and these cases fail
// if it ever does.

const st = vi.hoisted(() => ({
  total: 1003 as number,
  pageCalls: [] as Array<[number, number]>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: null, error: null }),
    from: () => {
      const b: any = {
        select: () => b,
        order: () => b,
        range: async (from: number, to: number) => {
          st.pageCalls.push([from, to])
          const size = to - from + 1
          const rows = []
          for (let i = from; i < Math.min(from + size, st.total); i++) {
            rows.push({
              external_id: `packcard-2332_1_${i}_1`,
              // Ascending age index doubles as the stalest-first assertion below.
              last_seen_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
            })
          }
          return { data: rows, error: null }
        },
      }
      return b
    },
  },
}))

let GET: any
beforeEach(async () => {
  vi.resetModules()
  st.total = 1003
  st.pageCalls = []
  process.env.INGEST_SECRET_TOKEN = "tok"
  ;({ GET } = await import("@/app/api/cron/panini-ingest/route"))
})

const req = (qs = "", auth: string | null = "Bearer tok") =>
  makeReq({ url: `https://t/api/cron/panini-ingest${qs}`, method: "GET", ...(auth ? { auth } : {}) })

describe("GET /api/cron/panini-ingest — walk order", () => {
  it("401s without the ingest token", async () => {
    expect((await GET(req("", null))).status).toBe(401)
    expect((await GET(req("", "Bearer wrong"))).status).toBe(401)
  })

  it("returns the WHOLE catalogue, stalest first, and says so", async () => {
    const j = await (await GET(req())).json()
    expect(j.count).toBe(1003)
    expect(j.pskus).toHaveLength(1003)
    expect(j.order).toBe("last_seen_at_asc")
    // Paged past the 1,000-row PostgREST cap rather than being clamped by it (#71).
    expect(st.pageCalls.length).toBeGreaterThan(1)
    expect(j.complete).toBe(true)
    expect(j.truncated).toBe(false)
    // Stalest first: the first psku is the oldest last_seen_at, the last is the newest.
    expect(new Date(j.oldest_last_seen_at).getTime())
      .toBeLessThan(new Date(j.newest_returned_last_seen_at).getTime())
  })

  it("⚠ a TRIMMED list is never `complete` — this is the defect that shipped and was caught", async () => {
    const j = await (await GET(req("?limit=5"))).json()
    expect(j.count).toBe(5)
    expect(j.pskus).toHaveLength(5)
    // The rows themselves are still the stalest — the flag is about COMPLETENESS, not order.
    expect(j.complete).toBe(false)
    // A caller that promotes "absent from pskus" to the front of its queue must not do so here.
    expect(j.complete).not.toBe(true)
  })

  it("a catalogue larger than maxPages reports truncated, not a silent short list", async () => {
    st.total = 25_000 // 20 pages x 1,000 is the helper's ceiling
    const j = await (await GET(req())).json()
    expect(j.count).toBe(20_000)
    expect(j.truncated).toBe(true)
    expect(j.complete).toBe(false)
  })
})
