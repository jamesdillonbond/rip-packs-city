// The two Top-Shot hub reads — /[collection]/hot-floors and
// /[collection]/challenges — extracted out of their `page.tsx` files.
//
// ── WHY THEY MOVED, AND WHY THIS FILE EXISTS ────────────────────────────────
// Both pages ALREADY had the right honesty branch: "Couldn't load hot floors
// right now" is rendered separately from "No sweeps detected in the last 3
// days", and the same for challenges. Those are different claims — one about US,
// one about THE MARKET — and only the second may be made from a read that
// succeeded.
//
// ⚠ Neither branch was reachable from the failure DB saturation actually
// produces. The pages wrapped their read in `try/catch`, which catches a THROW —
// and a read that merely HANGS throws nothing: supabase-js resolves
// `{ data, error }` only when the query finishes. So the document never
// completed, and Vercel logged a 200. **A try/catch around an unbounded await is
// not error handling for this class**, which is the reason worth recording.
//
// ⚠ And nothing pinned any of it: `app/**/page.tsx` is measured by NEITHER
// coverage gate, so the branches existed on the strength of review alone.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchHotFloors } from "@/lib/hot-floors/fetchers"
import { fetchActiveChallenges } from "@/lib/challenges/hub-fetchers"

/** An rpc that resolves with `payload`. */
const okDb = (payload: unknown) => ({ rpc: async () => ({ data: payload, error: null }) })
/** An rpc that returns a driver error. */
const errDb = (message: string) => ({ rpc: async () => ({ data: null, error: { message } }) })
/** An rpc that never settles. */
const hangDb = () => ({ rpc: () => new Promise(() => {}) })

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("fetchHotFloors", () => {
  it("a hung read reports ok:false — not a quiet three days", async () => {
    const res = await fetchHotFloors(hangDb(), 500)

    expect(res.ok, "an overrun read must report FAILURE").toBe(false)
    // ⚠ The absence of the false claim. `{ editions: [], ok: true }` is what
    // renders "No sweeps detected in the last 3 days" — a statement about the
    // market, made from our outage.
    expect(res.editions.length === 0 && res.ok === true).toBe(false)
  })

  it("a driver error reports ok:false", async () => {
    const res = await fetchHotFloors(errDb("canceling statement due to statement timeout"), 500)

    expect(res).toEqual({ editions: [], ok: false })
  })

  it("CONTROL — genuinely no sweeps is still ok:true", async () => {
    // The branch the bound must not swallow: three quiet days is a normal state
    // and the page is entitled to say so.
    const res = await fetchHotFloors(okDb({ editions: [] }), 500)

    expect(res).toEqual({ editions: [], ok: true })
  })

  it("CONTROL — a successful read returns its rows", async () => {
    const res = await fetchHotFloors(okDb({ editions: [{ external_id: "1:2" }] }), 500)

    expect(res.ok).toBe(true)
    expect(res.editions).toHaveLength(1)
  })

  it("a payload whose `editions` is not an array is a SHAPE CHANGE, not an empty result", async () => {
    // ⚠ `data?.editions ?? []` — the form this replaced — would publish "no
    // sweeps" from a payload we did not understand. Same family as `?? 0` on a
    // count: a default that manufactures a measurement nobody made.
    const res = await fetchHotFloors(okDb({ editions: { oops: true } }), 500)

    expect(res.ok).toBe(false)
  })

  it("a missing `editions` key is still an empty ANSWER", async () => {
    // ⚠ The other side of the line above, and it matters: absent is not
    // malformed. An RPC that answered with no key has told us there is nothing,
    // and treating that as an outage would put a false error banner on a quiet
    // day — the cry-wolf outcome lib/insights/board-status.ts warns about.
    const res = await fetchHotFloors(okDb({}), 500)

    expect(res).toEqual({ editions: [], ok: true })
  })
})

describe("fetchActiveChallenges", () => {
  it("a hung read reports ok:false — not 'no active challenges'", async () => {
    const res = await fetchActiveChallenges(hangDb(), 500)

    expect(res.ok).toBe(false)
    expect(res.challenges.length === 0 && res.ok === true).toBe(false)
  })

  it("a driver error reports ok:false", async () => {
    const res = await fetchActiveChallenges(errDb("boom"), 500)

    expect(res).toEqual({ challenges: [], ok: false })
  })

  it("CONTROL — Top Shot genuinely running none is still ok:true", async () => {
    const res = await fetchActiveChallenges(okDb({ challenges: [] }), 500)

    expect(res).toEqual({ challenges: [], ok: true })
  })

  it("CONTROL — a successful read returns its rows", async () => {
    const res = await fetchActiveChallenges(okDb({ challenges: [{ challengeId: "c1" }] }), 500)

    expect(res.ok).toBe(true)
    expect(res.challenges).toHaveLength(1)
  })

  it("a non-array `challenges` is a SHAPE CHANGE, not an empty result", async () => {
    const res = await fetchActiveChallenges(okDb({ challenges: "nope" }), 500)

    expect(res.ok).toBe(false)
  })
})
