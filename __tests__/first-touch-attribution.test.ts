import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildFirstTouch, parseFirstTouch, validateFirstTouch, FIRST_TOUCH_MAX_AFTER_SIGNUP_MS } from "@/lib/first-touch"

// 2026-11-09 (signup-wave remediation P2): first-touch attribution survives the
// magic-link tab (localStorage) and is stored on the account ONCE. Measured the
// same day: 15 signups in 7 days, 1 with a referrer on any of their rows.

const NOW = new Date("2026-11-09T22:00:00.000Z")
const CREATED = "2026-11-09T21:00:00.000Z"
const touch = (over: Record<string, unknown> = {}) => ({
  a: "utm_source=x&utm_campaign=wave&ref=https://t.co/abc",
  l: "/nba-top-shot/overview",
  t: "2026-11-09T20:30:00.000Z",
  v: "11111111-2222-3333-4444-555555555555",
  ...over,
})

describe("lib/first-touch", () => {
  it("builds a record with the path only and a capped attribution; direct is \"\" not null", () => {
    const r = buildFirstTouch(null, "/x", null, NOW)
    expect(r).toEqual({ a: "", l: "/x", t: NOW.toISOString(), v: null })
    expect(buildFirstTouch("z".repeat(900), "nope", "v", NOW).a).toHaveLength(512)
    expect(buildFirstTouch(null, "nope", null, NOW).l).toBe("/")
  })

  it("parses its own output and treats anything malformed as absent", () => {
    const r = buildFirstTouch("utm_source=x", "/a", "vid12345", NOW)
    expect(parseFirstTouch(JSON.stringify(r))).toEqual(r)
    expect(parseFirstTouch(null)).toBeNull()
    expect(parseFirstTouch("{")).toBeNull()
    expect(parseFirstTouch(JSON.stringify({ a: 1, l: "/", t: NOW.toISOString() }))).toBeNull()
    expect(parseFirstTouch(JSON.stringify({ a: "", l: "/", t: "not a date" }))).toBeNull()
  })

  it("accepts a pre-signup touch and maps it to the four columns", () => {
    const v = validateFirstTouch(touch(), CREATED, NOW)
    expect(v).toEqual({
      ok: true,
      row: {
        first_touch_attribution: "utm_source=x&utm_campaign=wave&ref=https://t.co/abc",
        first_touch_landing: "/nba-top-shot/overview",
        first_touch_at: "2026-11-09T20:30:00.000Z",
        first_touch_visitor_id: "11111111-2222-3333-4444-555555555555",
      },
    })
  })

  it("⚠ refuses a touch dated AFTER signup (beyond skew) — a later visit is not how they found us", () => {
    const late = new Date(Date.parse(CREATED) + FIRST_TOUCH_MAX_AFTER_SIGNUP_MS + 1000).toISOString()
    expect(validateFirstTouch(touch({ t: late }), CREATED, NOW)).toEqual({ ok: false, reason: "after_signup" })
    // within skew is fine
    const skew = new Date(Date.parse(CREATED) + 60_000).toISOString()
    expect(validateFirstTouch(touch({ t: skew }), CREATED, NOW).ok).toBe(true)
    // unknown account age cannot be checked → refused, never assumed
    expect(validateFirstTouch(touch(), null, NOW)).toEqual({ ok: false, reason: "after_signup" })
  })

  it("refuses future, malformed and whitespace/control payloads; drops a bad visitor id rather than storing it", () => {
    expect(validateFirstTouch(touch({ t: "2026-11-10T00:00:00Z" }), CREATED, NOW)).toEqual({ ok: false, reason: "future" })
    expect(validateFirstTouch(touch({ a: "has space" }), CREATED, NOW)).toEqual({ ok: false, reason: "malformed" })
    expect(validateFirstTouch(touch({ l: "no-slash" }), CREATED, NOW)).toEqual({ ok: false, reason: "malformed" })
    expect(validateFirstTouch(touch({ a: "x".repeat(513) }), CREATED, NOW)).toEqual({ ok: false, reason: "malformed" })
    expect(validateFirstTouch({}, CREATED, NOW)).toEqual({ ok: false, reason: "malformed" })
    const v = validateFirstTouch(touch({ v: "<script>" }), CREATED, NOW)
    expect(v.ok && v.row.first_touch_visitor_id).toBeNull()
  })
})

// ── the route ────────────────────────────────────────────────────────────

const st = vi.hoisted(() => ({
  user: null as null | { id: string; created_at?: string },
  ensureError: null as unknown,
  updateData: [{ id: "u1" }] as unknown[] | null,
  updateError: null as unknown,
  updates: [] as { row: unknown; filters: [string, string, unknown][] }[],
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!st.user) throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return st.user
  },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: () => Promise.resolve({ data: null, error: st.ensureError }),
      update: (row: unknown) => {
        const rec = { row, filters: [] as [string, string, unknown][] }
        st.updates.push(rec)
        const chain: any = {
          eq: (c: string, v: unknown) => { rec.filters.push(["eq", c, v]); return chain },
          is: (c: string, v: unknown) => { rec.filters.push(["is", c, v]); return chain },
          select: () => Promise.resolve({ data: st.updateData, error: st.updateError }),
        }
        return chain
      },
    }),
  },
}))

import { POST } from "@/app/api/profile/attribution/route"
const req = (body: unknown) => ({ json: async () => body }) as never

beforeEach(() => {
  st.user = { id: "u1", created_at: new Date(Date.now() - 3_600_000).toISOString() }
  st.ensureError = null
  st.updateData = [{ id: "u1" }]
  st.updateError = null
  st.updates = []
})

describe("POST /api/profile/attribution", () => {
  const fresh = () => touch({ t: new Date(Date.now() - 2 * 3_600_000).toISOString() })

  it("401s signed out", async () => {
    st.user = null
    expect((await POST(req(fresh()))).status).toBe(401)
  })

  it("⚠ writes ONLY where no first touch is on record (first write wins, in the WHERE)", async () => {
    const res = await POST(req(fresh()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored: true })
    expect(st.updates[0].filters).toContainEqual(["eq", "id", "u1"])
    expect(st.updates[0].filters).toContainEqual(["is", "first_touch_at", null])
  })

  it("stored:false is DERIVED from the write, when a first touch was already on record", async () => {
    st.updateData = []
    expect(await (await POST(req(fresh()))).json()).toEqual({ ok: true, stored: false })
  })

  it("400s a post-signup touch without writing", async () => {
    const res = await POST(req(touch({ t: new Date().toISOString() })))
    expect(res.status).toBe(400)
    expect((await res.json()).reason).toBe("after_signup")
    expect(st.updates).toHaveLength(0)
  })

  it("a FAILED write is an honest error (never ok/stored), so the client retries later", async () => {
    st.updateError = { code: "XX000", message: "boom" }
    const res = await POST(req(fresh()))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.ok).not.toBe(true)
    expect(body.stored).toBeUndefined()
  })
})
