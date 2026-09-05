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
import {
  fetchActiveChallenges,
  fetchChallengeFeed,
  CHALLENGE_FEED_STALE_DAYS,
} from "@/lib/challenges/hub-fetchers"

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

// ── /analytics/wallets ──────────────────────────────────────────────────────
//
// Same extraction, same mechanism, and the same defect at the end of it. The
// page's `ok` contract already existed — it used to return a bare `[]`, which
// rendered "No wallet activity to display.", a positive claim about the loan
// book manufactured from a database error — and it was equally unreachable from
// a hang, for the reason at the top of this file.

import { loadWalletDirectory } from "@/lib/analytics/wallet-directory"

describe("loadWalletDirectory", () => {
  it("a hung read reports ok:false — not an empty loan book", async () => {
    const res = await loadWalletDirectory(hangDb(), 500)

    expect(res.ok).toBe(false)
    expect(res.rows.length === 0 && res.ok === true).toBe(false)
  })

  it("a driver error reports ok:false", async () => {
    const res = await loadWalletDirectory(errDb("boom"), 500)

    expect(res).toEqual({ rows: [], ok: false })
  })

  it("CONTROL — a genuinely empty directory is still ok:true", async () => {
    const res = await loadWalletDirectory(okDb([]), 500)

    expect(res).toEqual({ rows: [], ok: true })
  })

  it("CONTROL — a successful read coerces its principals and keeps ok:true", async () => {
    // ⚠ Also pins the `|| 0` coercion as a PARSE fallback on a row the read
    // returned, which is a different thing from defaulting a missing measurement.
    const res = await loadWalletDirectory(
      okDb([{ wallet: "0x1", borrower_principal_usd: "12.5", lender_principal_usd: null }]),
      500,
    )

    expect(res.ok).toBe(true)
    expect(res.rows[0].borrower_principal_usd).toBe(12.5)
    expect(res.rows[0].lender_principal_usd).toBe(0)
  })

  it("a non-array payload is caught by the SHAPE GUARD, not by `.map` throwing", async () => {
    // ⚠ THIS ASSERTION IS ON THE LOG LINE, AND THAT IS DELIBERATE. An earlier
    // draft asserted only `ok === false` — and mutating the shape guard away
    // still PASSED it, because the very next statement is `.map()`, which throws
    // on a non-array and lands in the same catch. The outcome was identical, so
    // the test proved nothing about the guard.
    //
    // ⚠ Unlike hot-floors and challenges, where the payload is RETURNED rather
    // than mapped and a missing guard silently yields "empty", here the guard is
    // defence-in-depth: it makes the failure explicit and stops depending on an
    // incidental `.map` for correctness. Pinning the message is the only way to
    // tell the two paths apart, so a future refactor that drops the guard reds.
    const logs: string[] = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "))
    })

    const res = await loadWalletDirectory(okDb({ oops: true }), 500)

    expect(res.ok).toBe(false)
    expect(logs.join("\n")).toContain("unexpected payload shape")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fetchChallengeFeed — THE THIRD STATE the read cannot see.
//
// The page already separated "the read failed" from "there are genuinely none".
// Both are about the READ. Neither can see that the thing which FEEDS the table
// is dead — `ingest-topshot-challenges` has answered HTTP 530 on every run since
// 2026-08-29 — while the table still looks fresh, because
// `refresh_challenge_costs` re-prices the existing rows on its own cadence.
//
// ⚠ The defect was a FORWARD-LOOKING promise: "When Top Shot runs a Set-Locking
// or Crafting Challenge, it'll show up here." With the ingest dead that cannot
// be kept, and it is the canon's "empty state that CONCLUDES rather than
// reports".
// ─────────────────────────────────────────────────────────────────────────────

/** A `from()` chain resolving to `rows`, matching supabase-js's builder shape. */
function fromDb(rows: unknown, error: { message: string } | null = null) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "gt", "order", "limit"]) b[m] = () => b
  ;(b as { then: unknown }).then = (res: (v: unknown) => unknown) => res({ data: rows, error })
  return { from: () => b }
}
/** A `from()` chain that never settles. */
function fromHangDb() {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "gt", "order", "limit"]) b[m] = () => b
  ;(b as { then: unknown }).then = () => {}
  return { from: () => b }
}

const NOW = new Date("2026-09-05T01:30:00Z")

describe("fetchChallengeFeed", () => {
  it("a feed that succeeded TODAY is current", async () => {
    const res = await fetchChallengeFeed(fromDb([{ day: "2026-09-05" }]), 500, NOW)
    expect(res).toEqual({ state: "current", lastOkDay: "2026-09-05" })
  })

  it("🚨 a feed whose last success is the REAL one (2026-08-28) is stale", async () => {
    // The production value at the time of writing: eight days dead.
    const res = await fetchChallengeFeed(fromDb([{ day: "2026-08-28" }]), 500, NOW)
    expect(res.state).toBe("stale")
    expect(res.lastOkDay).toBe("2026-08-28")
  })

  it("the boundary is CHALLENGE_FEED_STALE_DAYS, and one missed daily tick is NOT stale", async () => {
    // A 1-day bar would flip the page's copy on ordinary noise. Pin both sides
    // of the threshold rather than the spelling of the constant.
    const inside = new Date(NOW.getTime() - (CHALLENGE_FEED_STALE_DAYS - 1) * 86_400_000)
    const outside = new Date(NOW.getTime() - (CHALLENGE_FEED_STALE_DAYS + 1) * 86_400_000)
    const day = (d: Date) => d.toISOString().slice(0, 10)
    expect((await fetchChallengeFeed(fromDb([{ day: day(inside) }]), 500, NOW)).state).toBe("current")
    expect((await fetchChallengeFeed(fromDb([{ day: day(outside) }]), 500, NOW)).state).toBe("stale")
  })

  it("a feed that has NEVER succeeded is stale, not unknown", async () => {
    // The strongest form of dead must not hide behind the softest copy.
    const res = await fetchChallengeFeed(fromDb([]), 500, NOW)
    expect(res).toEqual({ state: "stale", lastOkDay: null })
  })

  it("a FAILED freshness read is unknown — never current", async () => {
    // Returning "current" here would restore the promise out of a failed read,
    // which is the defect this function exists to remove, one level up.
    const res = await fetchChallengeFeed(fromDb(null, { message: "boom" }), 500, NOW)
    expect(res.state).toBe("unknown")
  })

  it("a HUNG freshness read is unknown, and does not hang the page", async () => {
    // Bounded like every other read here: a probe taken for a caption must not
    // be able to take the page down.
    const res = await fetchChallengeFeed(fromHangDb(), 200, NOW)
    expect(res.state).toBe("unknown")
  })
})
