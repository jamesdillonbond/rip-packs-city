import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { boardUnavailable } from "@/lib/insights/board-error"

// Unit coverage for the publishable failure response shared by every public
// /insights board route.
//
// WHY THIS FILE. The route fixtures all inject a GENERIC error (`{message:"boom"}`),
// which classifies as "internal" → 500. The case that actually happens in
// production — a statement timeout under disk-IO saturation — is the one none of
// them drive, and it is the one where the old code did the most damage: it
// published Postgres's own "canceling statement due to statement timeout" to
// anonymous visitors, and to the concierge, which forwards `json.error` straight
// into the model's tool result.
//
// Three properties are pinned here because a regression in any of them is
// invisible from the route tests:
//   1. no driver text is ever published,
//   2. a timeout is a RETRYABLE 503 with Retry-After (not a hard 500), and
//   3. the failure carries Cache-Control: no-store — these routes set a PUBLIC
//      edge cache (s-maxage 300..3600) on success, so a cacheable 503 would pin
//      a momentary blip into a sustained outage for every visitor.

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const TIMEOUT_TEXT = "canceling statement due to statement timeout"

describe("boardUnavailable", () => {
  it("classifies a Postgres statement timeout as a retryable 503", async () => {
    const res = boardUnavailable({ code: "57014", message: TIMEOUT_TEXT }, "insights/squeeze")
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("30")
    const body = await res.json()
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
    expect(body.error).not.toContain("canceling statement")
    expect(body.error).not.toContain("statement timeout")
  })

  it("never publishes the driver message, whatever the shape", async () => {
    const shapes: unknown[] = [
      { code: "57014", message: TIMEOUT_TEXT },        // PostgrestError
      new Error(TIMEOUT_TEXT),                          // thrown Error
      TIMEOUT_TEXT,                                     // bare string
      { message: 'relation "topshot_squeeze_board" does not exist', code: "42P01" },
    ]
    for (const err of shapes) {
      const body = await boardUnavailable(err, "insights/squeeze").json()
      expect(JSON.stringify(body)).not.toContain("canceling statement")
      expect(JSON.stringify(body)).not.toContain("topshot_squeeze_board")
    }
  })

  it("classifies a BARE STRING timeout as 503, not a generic 500", async () => {
    // lib/supabase-paginate returns `error` as a plain string, so four routes
    // (market, topshot-pack-market, allday-pack-market, allday-pack-reality)
    // hand us one. safeApiError's message reader only understands Error objects
    // and objects with `.message`, so without normalization this silently fell
    // through to "internal" and a timeout was reported as a hard 500.
    const res = boardUnavailable(TIMEOUT_TEXT, "insights/market")
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("timeout")
  })

  it("reports a missing relation as unavailable (503), not as the caller's fault", async () => {
    const res = boardUnavailable({ code: "42P01", message: "relation does not exist" }, "insights/deals")
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("unavailable")
  })

  it("falls back to a generic 500 for an unrecognized failure", async () => {
    const res = boardUnavailable({ message: "boom" }, "insights/trophies")
    expect(res.status).toBe(500)
    expect(res.headers.get("Retry-After")).toBeNull()
    const body = await res.json()
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
    expect(body.error).not.toContain("boom")
  })

  it("uses the caller's fallback copy for an unclassified failure", async () => {
    const body = await boardUnavailable({ message: "boom" }, "insights/trophies", "Trophies are offline.").json()
    expect(body.error).toBe("Trophies are offline.")
  })

  it("marks every failure no-store so a 503 is never edge-cached", async () => {
    for (const err of [{ code: "57014", message: TIMEOUT_TEXT }, { message: "boom" }]) {
      expect(boardUnavailable(err, "insights/squeeze").headers.get("Cache-Control")).toBe("no-store")
    }
  })

  it("logs the detail server-side so the failure stays diagnosable", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    boardUnavailable({ code: "57014", message: TIMEOUT_TEXT }, "insights/squeeze")
    expect(spy).toHaveBeenCalledOnce()
    const logged = String(spy.mock.calls[0]?.[0] ?? "")
    expect(logged).toContain("public/insights/squeeze")
    // the detail the RESPONSE withholds must still reach the log
    expect(logged).toContain("57014")
    expect(logged).toContain("canceling statement")
  })
})
