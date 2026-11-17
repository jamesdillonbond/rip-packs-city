// A failed TROPHIES (or WALLETS) read inside the public-profile bundle must fail
// the bundle — never resolve to an empty case.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `getPublicProfile` destructured `error` from the bio read only. supabase-js
// RETURNS errors, so a failed `get_trophy_slab_data_by_username` resolved
// `{ data: null, error }`, became `trophies = []`, and four public surfaces —
// `/profile/[username]`, `/profile/[username]/trophy-case`, and both OG cards —
// published "No trophies pinned yet" out of a database error. That is the
// empty state that CONCLUDES, about a collector's own case, on the page they
// share. Found 2026-09-03 while re-QAing those surfaces' genuine empty state.
//
// ⚠ Assert the ABSENCE of the false claim (ok:true with trophies:[]), not just
// the presence of an error. And keep the mirror: a genuinely empty case is
// still ok:true with trophies:[] — over-correcting would make every new
// collector's page read as broken.

import { describe, it, expect, vi, beforeEach } from "vitest"

const maybeSingle = vi.fn()
const eqResult = vi.fn()
const rpc = vi.fn()

function chain() {
  const c: Record<string, unknown> = {}
  for (const k of ["select", "ilike", "eq", "order", "limit"]) c[k] = () => c
  c.maybeSingle = () => maybeSingle()
  c.then = (res: (v: unknown) => void) => eqResult().then(res)
  return c
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => chain(),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}))

let n = 0
const freshHandle = () => `collector${++n}`

import { getPublicProfile } from "@/lib/profile/public-profile"

const BIO = {
  username: "x",
  display_name: "X",
  tagline: null,
  favorite_team: null,
  twitter: null,
  discord: null,
  avatar_url: null,
  accent_color: "#E03A2F",
  equipped_border: null,
  equipped_banner: null,
}

beforeEach(() => {
  maybeSingle.mockReset()
  eqResult.mockReset()
  rpc.mockReset()
  // resolve → user id; bundle → bio
  maybeSingle
    .mockResolvedValueOnce({ data: { user_id: "u1" }, error: null })
    .mockResolvedValueOnce({ data: BIO, error: null })
  eqResult.mockResolvedValue({ data: [], error: null })
})

describe("getPublicProfile — a failed trophies read is not an empty case", () => {
  it("fails the bundle (ok:false, 500) when the trophies RPC errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "canceling statement due to statement timeout" } })

    const res = await getPublicProfile(freshHandle(), "test")

    expect(res.ok, "a database error must not resolve to trophies: []").toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.status).toBe(500)
    expect(res.status).not.toBe(404)
  })

  it("fails the bundle when the saved-wallets read errors", async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    eqResult.mockResolvedValue({ data: null, error: { message: "db down" } })

    const res = await getPublicProfile(freshHandle(), "test")

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.status).toBe(500)
  })

  it("CONTROL — a genuinely empty case is still ok:true with trophies: []", async () => {
    rpc.mockResolvedValue({ data: [], error: null })

    const res = await getPublicProfile(freshHandle(), "test")

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error("unreachable")
    expect(res.data.trophies).toEqual([])
    expect(res.data.wallets).toEqual([])
  })
})
