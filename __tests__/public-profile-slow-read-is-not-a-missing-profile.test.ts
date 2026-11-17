// A public-profile read that OVERRUNS must answer 503, never 404.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `getPublicProfile` already separated the two answers that look identical
// downstream: `idErr` (the database answered with an error) is 500, and `!idRow`
// (there is no such username) is 404. What it had no way to reach was the
// third: the database did not answer at all.
//
// ⚠ That gap is not academic on this module. Both callers are public and one of
// them is `/profile/[username]`, a page collectors SHARE. 404 is the single
// status that asserts the profile does not exist — publishing it out of a
// timeout tells a visitor a named collector is not on the platform, which is a
// claim about someone else's account manufactured from our outage.
//
// ⚠ The assertions below are on the STATUS, not on the message. A test that
// checked only "some error came back" would pass on a 404, which is the exact
// defect.

import { describe, it, expect, vi, beforeEach } from "vitest"

// A `profile_bio` chain whose terminal call never settles within the budget.
const hang = () => new Promise(() => {})

const maybeSingle = vi.fn()
const eqResult = vi.fn()

function chain() {
  const c: Record<string, unknown> = {}
  for (const k of ["select", "ilike", "eq", "order", "limit"]) c[k] = () => c
  c.maybeSingle = () => maybeSingle()
  // `.eq()` terminates the saved_wallets read, so it must be awaitable too.
  c.then = (res: (v: unknown) => void) => eqResult().then(res)
  return c
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => chain(),
    rpc: () => Promise.resolve({ data: [] }),
  },
}))

// `cache()` from React memoises on arguments, so every case needs its own
// username or the second assertion reads the first one's answer.
let n = 0
const freshHandle = () => `collector${++n}`

import { getPublicProfile } from "@/lib/profile/public-profile"

beforeEach(() => {
  maybeSingle.mockReset()
  eqResult.mockReset()
  eqResult.mockResolvedValue({ data: [], error: null })
})

describe("getPublicProfile — a read that did not answer is not a missing profile", () => {
  it("answers 503 when the username resolve overruns", async () => {
    maybeSingle.mockImplementation(hang)

    const res = await getPublicProfile(freshHandle(), "test")

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.status, "a read we could not finish is not a missing profile").toBe(503)
    // Assert the ABSENCE of the false claim as well as the presence of the
    // right one — 404 is the whole reason this file exists.
    expect(res.status).not.toBe(404)
  }, 20_000)

  it("CONTROL — a genuinely unknown username is still 404", async () => {
    // The branch the bound must not swallow: we asked, and the answer is "none".
    maybeSingle.mockResolvedValue({ data: null, error: null })

    const res = await getPublicProfile(freshHandle(), "test")

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.status).toBe(404)
  })

  it("CONTROL — a driver error is still 500", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } })

    const res = await getPublicProfile(freshHandle(), "test")

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.status).toBe(500)
  })

  it("CONTROL — an empty username is still 400, so the bound did not swallow validation", async () => {
    const res = await getPublicProfile("   ", "test")

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.status).toBe(400)
  })
})
