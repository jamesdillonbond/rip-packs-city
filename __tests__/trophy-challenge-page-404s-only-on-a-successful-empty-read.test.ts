import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// /trophy-challenges/<slug> answered HTTP 200 for ANY slug (a soft 404 — the
// shell rendered and only the client learned the challenge did not exist).
// The page now probes server-side. The property pinned here is the HONESTY
// split, not the 404 alone: ONLY a read that SUCCEEDED and returned NULL may
// become a 404. A failed, slow or unreadable read renders the board (whose
// client shows a retry notice) — it must never be published as "no such
// challenge".

vi.mock("@/lib/supabase", () => ({ supabase: {} }))

import { probeTrophyChallenge, CHALLENGE_PROBE_TIMEOUT_MS } from "@/lib/trophy/challenge-probe"

function db(result: Promise<{ data: unknown; error: unknown }>) {
  return { rpc: vi.fn(() => result) }
}

describe("probeTrophyChallenge", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it("a successful read returning NULL is 'missing' (the only 404 case)", async () => {
    const d = db(Promise.resolve({ data: null, error: null }))
    expect(await probeTrophyChallenge(d, "no-such")).toEqual({ kind: "missing" })
    expect(d.rpc).toHaveBeenCalledWith("get_trophy_challenge_entries", { p_slug: "no-such", p_limit: 1 })
  })

  it("an errored read is 'unknown', NOT 'missing'", async () => {
    const r = await probeTrophyChallenge(db(Promise.resolve({ data: null, error: { message: "boom" } })), "dame-time")
    expect(r.kind).toBe("unknown")
    expect(r.kind).not.toBe("missing")
  })

  it("a rejected read is 'unknown', NOT 'missing'", async () => {
    const r = await probeTrophyChallenge(db(Promise.reject(new Error("fetch failed"))), "dame-time")
    expect(r.kind).toBe("unknown")
  })

  it("a read that overruns its budget is 'unknown', NOT 'missing'", async () => {
    vi.useFakeTimers()
    try {
      const pending = probeTrophyChallenge(db(new Promise(() => {})), "dame-time")
      await vi.advanceTimersByTimeAsync(CHALLENGE_PROBE_TIMEOUT_MS + 1)
      expect((await pending).kind).toBe("unknown")
    } finally {
      vi.useRealTimers()
    }
  })

  it("an unreadable body is 'unknown' — not evidence of absence", async () => {
    const r = await probeTrophyChallenge(db(Promise.resolve({ data: { entries: [] }, error: null })), "dame-time")
    expect(r.kind).toBe("unknown")
  })

  it("a found challenge carries its title and tagline", async () => {
    const r = await probeTrophyChallenge(
      db(Promise.resolve({ data: { challenge: { title: "Dame Time", tagline: "Lillard only" }, entries: [] }, error: null })),
      "dame-time",
    )
    // entryCount added 2026-11-07 (the link preview's line); this payload has
    // no entry_count, so it is null — unknown, NOT 0.
    expect(r).toEqual({ kind: "found", title: "Dame Time", tagline: "Lillard only", entryCount: null })
  })

  it("carries the entry count when the payload has it", async () => {
    const r = await probeTrophyChallenge(
      db(Promise.resolve({ data: { challenge: { title: "Dame Time", tagline: null }, entries: [], entry_count: 5 }, error: null })),
      "dame-time",
    )
    expect(r).toMatchObject({ kind: "found", entryCount: 5 })
  })
})
