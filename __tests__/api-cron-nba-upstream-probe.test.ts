import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// The temporary #8 probe: can Vercel's egress reach the free NBA sources? It must record what it
// saw (status / size / ESPN game count, never a body) in ONE pipeline_runs row, and a fetch that
// fails is a RESULT to record, not a crash.

const logged: any[] = []
vi.mock("@/lib/pipeline/terminal-run", () => ({ logTerminalRun: async (o: any) => { logged.push(o); return true } }))

let GET: any
beforeEach(async () => {
  logged.length = 0
  process.env.CRON_SECRET = "c"
  ;({ GET } = await import("@/app/api/cron/nba-upstream-probe/route"))
})
afterEach(() => vi.unstubAllGlobals())

const req = (auth?: string) => makeReq({ url: "https://t/api/cron/nba-upstream-probe", auth })

describe("GET /api/cron/nba-upstream-probe", () => {
  it("401s without the cron secret and records nothing", async () => {
    expect((await GET(req())).status).toBe(401)
    expect(logged).toHaveLength(0)
  })

  it("records each upstream's status, and ESPN's game count", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("espn")
        ? new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 })
        : new Response("Access Denied", { status: 403 })))
    const res = await GET(req("Bearer c"))
    expect(res.status).toBe(200)
    expect(logged).toHaveLength(1)
    expect(logged[0].pipeline).toBe("nba-upstream-probe")
    expect(logged[0].extra.espn).toMatchObject({ status: 200, games: 3 })
    expect(logged[0].extra.nba_schedule.status).toBe(403)
    expect(logged[0].extra.nba_today.status).toBe(403)
  })

  it("a fetch that throws is recorded as status null, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed") }))
    const res = await GET(req("Bearer c"))
    expect(res.status).toBe(200)
    expect(logged[0].extra.espn).toMatchObject({ status: null, error: "TypeError" })
  })
})
