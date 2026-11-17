import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// POST/GET /api/email/subscribe — the preference upsert + confirmation send.
//
// The header of this route states a security rule outright: "The email is
// pinned to the signed-in user's account email — clients can't pass an
// arbitrary `email` field." Nothing tested it. If a body-supplied `email` ever
// reached the upsert, a signed-in user could subscribe (and then send a
// confirmation email to) any address they like, using our sending domain. That
// is the first thing pinned here.
//
// The rest is the confirmation-send ladder, which is deliberately NON-FATAL: an
// unsent email must still return ok:true with the reason on
// confirmation_email_error, because the preferences DID save. A regression that
// 500s here would lose a preference write over an email-provider blip.

const state = vi.hoisted(() => ({
  user: null as { email?: string } | null,
  row: { data: null as unknown, error: null as unknown },
  // Every write, in order. 2026-10-10: the route MERGES — an existing row gets
  // .update(only the provided fields).eq("email", session); a missing one gets
  // .insert(defaults + provided).
  upserted: [] as Record<string, unknown>[],
  writes: [] as Array<{ method: "update" | "insert"; row: Record<string, unknown> }>,
  eqs: [] as Array<[string, unknown]>,
  insertRow: { data: null as unknown, error: null as unknown },
  resend: { ok: true, status: 200, text: "sent", throws: null as string | null },
  resendCalls: [] as Array<{ headers: Record<string, string>; body: Record<string, unknown> }>,
}))

vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => state.user }))
vi.mock("@/lib/supabase", () => {
  const make = () => {
    const b: Record<string, unknown> = {}
    let mode: "read" | "update" | "insert" = "read"
    const self = () => b
    b.update = (row: Record<string, unknown>) => { mode = "update"; state.upserted.push(row); state.writes.push({ method: "update", row }); return self() }
    b.insert = (row: Record<string, unknown>) => { mode = "insert"; state.upserted.push(row); state.writes.push({ method: "insert", row }); return self() }
    b.eq = (c: string, v: unknown) => { state.eqs.push([c, v]); return self() }
    b.select = () => self()
    b.ilike = () => self()
    b.maybeSingle = async () => (mode === "insert" ? state.insertRow : state.row)
    return b
  }
  return { supabaseAdmin: { from: () => make() } }
})

process.env.NEXT_PUBLIC_SITE_URL = "https://site.test"

const { POST, GET } = await import("@/app/api/email/subscribe/route")

const postReq = (body: unknown, badJson = false) =>
  ({ json: async () => { if (badJson) throw new Error("bad json"); return body } }) as never

function stubResend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      state.resendCalls.push({
        headers: (init.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init.body)),
      })
      if (state.resend.throws) throw new Error(state.resend.throws)
      return {
        ok: state.resend.ok,
        status: state.resend.status,
        text: async () => state.resend.text,
      } as unknown as Response
    }),
  )
}

const lastUpsert = () => state.upserted.at(-1)!

beforeEach(() => {
  state.user = { email: "Trevor@Example.COM" }
  state.row = { data: { id: 1, email: "trevor@example.com", verified: true, verification_token: "tok" }, error: null }
  state.upserted = []
  state.writes = []
  state.eqs = []
  state.insertRow = { data: { id: 2, email: "trevor@example.com", verified: false, verification_token: "tok" }, error: null }
  state.resend = { ok: true, status: 200, text: "sent", throws: null }
  state.resendCalls = []
  process.env.RESEND_API_KEY = "re_test"
  stubResend()
})
afterEach(() => vi.unstubAllGlobals())

describe("POST /api/email/subscribe — the email is the SESSION's, never the body's", () => {
  it("ignores a body-supplied email and writes the lower-cased account email", async () => {
    // existing row: the update is keyed on the SESSION email and carries no email field
    await POST(postReq({ email: "victim@elsewhere.test", digest_weekly: true }))
    expect(state.eqs).toContainEqual(["email", "trevor@example.com"])
    expect(JSON.stringify(state.eqs)).not.toContain("victim")
    expect(lastUpsert().email).toBeUndefined()
    // new row: the insert carries the account email, normalized
    state.row = { data: null, error: null }
    await POST(postReq({ email: "victim@elsewhere.test" }))
    expect(lastUpsert().email).toBe("trevor@example.com")
  })

  it("sends the confirmation to the account email too, not the body's", async () => {
    state.row = { data: { id: 1, email: "trevor@example.com", verified: false, verification_token: "tok" }, error: null }
    await POST(postReq({ email: "victim@elsewhere.test" }))
    expect(state.resendCalls[0].body.to).toEqual(["trevor@example.com"])
  })

  it("401s without a session or without an email on it", async () => {
    state.user = null
    expect((await POST(postReq({}))).status).toBe(401)
    state.user = {}
    expect((await POST(postReq({}))).status).toBe(401)
    state.user = null
    expect((await GET()).status).toBe(401)
  })

  it("400s on an unparseable body", async () => {
    expect((await POST(postReq(null, true))).status).toBe(400)
  })
})

describe("POST /api/email/subscribe — preference defaults + type guards", () => {
  it("a NEW subscriber with an empty body gets digest-only with the standard discount floor", async () => {
    state.row = { data: null, error: null } // no existing row → insert
    await POST(postReq({}))
    expect(state.writes.at(-1)?.method).toBe("insert")
    expect(lastUpsert()).toMatchObject({
      digest_weekly: true,
      deal_alerts: false,
      badge_alerts: false,
      portfolio_alerts: false,
      deal_min_discount: 20,
      deal_max_price: null,
      deal_tiers: null,
      collection_ids: null,
      wallet_address: null,
      // Re-subscribing must clear a prior unsubscribe.
      unsubscribed_at: null,
    })
  })

  it("accepts explicit values, including a false digest and a 0 discount", async () => {
    await POST(postReq({
      digest_weekly: false, deal_alerts: true, badge_alerts: true, portfolio_alerts: true,
      deal_min_discount: 0, deal_max_price: 25, deal_tiers: ["RARE"],
      collection_ids: ["c1"], wallet_address: "0xabc",
    }))
    expect(lastUpsert()).toMatchObject({
      digest_weekly: false, deal_alerts: true, deal_min_discount: 0, deal_max_price: 25,
      deal_tiers: ["RARE"], collection_ids: ["c1"], wallet_address: "0xabc",
    })
  })

  it("rejects wrong-typed values back to their defaults rather than storing them", async () => {
    state.row = { data: null, error: null } // new row, so the defaults apply
    await POST(postReq({
      deal_min_discount: "20", deal_max_price: "cheap", deal_tiers: "RARE", collection_ids: "c1",
    }))
    expect(lastUpsert()).toMatchObject({
      deal_min_discount: 20, deal_max_price: null, deal_tiers: null, collection_ids: null,
    })
  })

  it("500s on an upsert error and on an upsert that returns no row", async () => {
    state.row = { data: null, error: { message: "subscribers table down" } }
    const err = await POST(postReq({}))
    expect(err.status).toBe(500)
    expect((await err.json()).error).not.toContain("subscribers table down")

    state.row = { data: null, error: null }
    state.insertRow = { data: null, error: null } // the insert fallback returns nothing either
    const none = await POST(postReq({}))
    expect(none.status).toBe(500)
    expect((await none.json()).error).toBe("upsert returned no row")
  })
})

// 2026-10-10 — INVERTED. The route used to upsert a FULL row, so any field the
// caller omitted was reset: the settings page never sends wallet_address, so
// every save wiped the digest wallet, and a save after a failed settings load
// wrote the form's defaults over every real preference. An existing row now
// gets ONLY the provided fields.
describe("POST /api/email/subscribe — an existing row is MERGED, never reset", () => {
  it("does not touch fields the caller omitted (wallet_address, filters, tiers)", async () => {
    await POST(postReq({ deal_alerts: true }))
    const w = state.writes.at(-1)!
    expect(w.method).toBe("update")
    expect(w.row).toEqual({ deal_alerts: true, unsubscribed_at: null })
    for (const k of ["wallet_address", "deal_tiers", "collection_ids", "deal_min_discount", "digest_weekly"]) {
      expect(k in w.row).toBe(false)
    }
  })

  it("an explicit null still clears a field", async () => {
    await POST(postReq({ wallet_address: null, deal_tiers: null }))
    expect(state.writes.at(-1)!.row).toMatchObject({ wallet_address: null, deal_tiers: null })
  })

  it("a concurrent insert (23505) merges into the row that won", async () => {
    state.row = { data: null, error: null }
    state.insertRow = { data: null, error: { code: "23505", message: "duplicate key" } }
    const res = await POST(postReq({ deal_alerts: true }))
    // the retry update also finds nothing in this stub → no row → 500, but the
    // sequence must be update → insert → update, never a full overwrite
    expect(state.writes.map((w) => w.method)).toEqual(["update", "insert", "update"])
    expect(res.status).toBe(500)
  })
})

describe("POST /api/email/subscribe — the confirmation ladder is non-fatal", () => {
  const unverified = () => {
    state.row = { data: { id: 9, email: "trevor@example.com", verified: false, verification_token: "tok 123" }, error: null }
  }

  it("sends a confirmation for an unverified row and reports it", async () => {
    unverified()
    const body = await (await POST(postReq({}))).json()
    expect(body).toMatchObject({ ok: true, id: 9, verified: false, confirmation_email_sent: true, confirmation_email_error: null })

    const call = state.resendCalls[0]
    expect(call.headers.Authorization).toBe("Bearer re_test")
    expect(call.body.from).toContain("noreply@rippackscity.com")
    // The token is URL-ENCODED into the link — a raw space would break it.
    expect(String(call.body.html)).toContain("https://site.test/api/email/confirm?token=tok%20123")
    expect(String(call.body.text)).toContain("tok%20123")
  })

  it("skips the send entirely for an already-verified row", async () => {
    const body = await (await POST(postReq({}))).json()
    expect(body).toMatchObject({ verified: true, confirmation_email_sent: false, confirmation_email_error: null })
    expect(state.resendCalls).toHaveLength(0)
  })

  it("still saves the preferences when the key is missing, when Resend 4xxs, and when the call throws", async () => {
    unverified()
    delete process.env.RESEND_API_KEY
    let body = await (await POST(postReq({}))).json()
    expect(body.ok).toBe(true)
    expect(body.confirmation_email_error).toBe("RESEND_API_KEY not set")
    expect(state.resendCalls).toHaveLength(0)

    process.env.RESEND_API_KEY = "re_test"
    state.resend = { ok: false, status: 422, text: "domain not verified", throws: null }
    body = await (await POST(postReq({}))).json()
    expect(body.ok).toBe(true)
    expect(body.confirmation_email_error).toContain("Resend HTTP 422")
    expect(body.confirmation_email_error).toContain("domain not verified")

    state.resend = { ok: true, status: 200, text: "", throws: "socket hang up" }
    body = await (await POST(postReq({}))).json()
    expect(body.ok).toBe(true)
    expect(body.confirmation_email_error).toBe("socket hang up")
    // In every failure mode the preference write still happened.
    expect(state.upserted).toHaveLength(3)
  })
})

describe("GET /api/email/subscribe", () => {
  it("returns the subscriber row for the session email", async () => {
    const body = await (await GET()).json()
    expect(body).toMatchObject({ ok: true, subscriber: { email: "trevor@example.com" } })
  })

  it("returns a null subscriber (not a 404) when the account has never subscribed", async () => {
    state.row = { data: null, error: null }
    expect(await (await GET()).json()).toEqual({ ok: true, subscriber: null })
  })

  it("500s on a read error", async () => {
    state.row = { data: null, error: { message: "read down" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("read down")
  })
})
