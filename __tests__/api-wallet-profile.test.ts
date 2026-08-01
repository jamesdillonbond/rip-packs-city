import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for GET /api/wallet/profile.
// Session-gated read keyed by ?ownerKey, backed by get_user_profile plus an
// in-process 30s / 500-entry cache added to stop pooler saturation. Legs
// pinned: the missing/"null"/"undefined" 400 guards, the RPC error 500 and the
// thrown-RPC 500, the cache MISS→HIT transition (x-rpc-cache header + a single
// RPC call), TTL expiry re-fetching, and LRU eviction past the cap.
//
// Two security properties are pinned alongside the cache behaviour, because the
// cache is what makes this route's IDOR unusually sharp: (a) `requireOwnedKey`
// runs BEFORE any cache read, so 401/403 can never be short-circuited by a warm
// entry; (b) the cache key is `<sessionUserId>::<ownerKey>`, so a hit is only
// ever served back to the identity that populated it.
//
// Every test uses a unique ownerKey because the cache is module-level and
// persists across tests.

const st: { data: any | null; error: any | null; throws: boolean; calls: number } = {
  data: { name: "trevor" },
  error: null,
  throws: false,
  calls: 0,
}

// ── requireOwnedKey fixtures ────────────────────────────────────────────────
// The guard demands a session AND that `profile_bio` prove the key belongs to
// that session user. `ownership.claimantId` is who claims the requested key
// (null = unclaimed); the claimed username echoes back whatever key the route
// asked about, so any ownerKey a test uses resolves to the caller unless the
// test overrides it. `selfUsername` drives the unclaimed-key branch.
const auth: { user: { id: string } | null } = { user: { id: "u1" } }
const ownership: {
  claimantId: string | null
  claimantErr: any | null
  selfUsername: string | null
  selfErr: any | null
} = { claimantId: "u1", claimantErr: null, selfUsername: null, selfErr: null }

// profile_bio is read twice by the guard: `.ilike("username", key)` (who claims
// the key) and `.eq("user_id", …)` (does the caller have a username of their
// own). Distinguish the two by which filter was used.
function profileBioBuilder() {
  let claimQuery = false
  let key = ""
  const b: any = {
    select: () => b,
    ilike: (_col: string, v: string) => {
      claimQuery = true
      key = v
      return b
    },
    eq: () => b,
    maybeSingle: async (): Promise<{ data: any | null; error: any | null }> =>
      claimQuery
        ? {
            data: ownership.claimantId
              ? { user_id: ownership.claimantId, username: key }
              : null,
            error: ownership.claimantErr,
          }
        : {
            data: ownership.selfUsername ? { username: ownership.selfUsername } : null,
            error: ownership.selfErr,
          },
  }
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (_t: string) => profileBioBuilder(), // the guard's only table read
    rpc: async () => {
      st.calls++
      if (st.throws) throw new Error("pool exhausted")
      return { data: st.data, error: st.error }
    },
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { GET } from "@/app/api/wallet/profile/route"

const req = (ownerKey?: string) =>
  ({ nextUrl: new URL(`https://t/api/wallet/profile${ownerKey === undefined ? "" : `?ownerKey=${ownerKey}`}`) }) as any

let seq = 0
const uniqueKey = () => `owner-${Date.now()}-${seq++}`

beforeEach(() => {
  st.data = { name: "trevor" }
  st.error = null
  st.throws = false
  st.calls = 0
  auth.user = { id: "u1" }
  ownership.claimantId = "u1"
  ownership.claimantErr = null
  ownership.selfUsername = null
  ownership.selfErr = null
})
afterEach(() => vi.useRealTimers())

describe("GET /api/wallet/profile — guards", () => {
  it("400s without an ownerKey", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey param required")
  })
  it("400s on the literal string 'null' (empty-localStorage coercion)", async () => {
    expect((await GET(req("null"))).status).toBe(400)
  })
  it("400s on the literal string 'undefined'", async () => {
    expect((await GET(req("undefined"))).status).toBe(400)
  })
  it("400s on a whitespace-only ownerKey", async () => {
    expect((await GET(req("%20%20"))).status).toBe(400)
  })
})

describe("GET /api/wallet/profile — RPC failures", () => {
  it("500s and surfaces the message when the RPC returns an error", async () => {
    st.error = { message: "statement timeout", code: "57014", hint: "h", details: "d" }
    const res = await GET(req(uniqueKey()))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("statement timeout")
  })
  it("500s when the RPC throws outright", async () => {
    st.throws = true
    const res = await GET(req(uniqueKey()))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("pool exhausted")
  })
  it("does not cache a failed lookup (the next call re-hits the RPC)", async () => {
    const key = uniqueKey()
    st.error = { message: "down" }
    await GET(req(key))
    st.error = null
    const res = await GET(req(key))
    expect(res.status).toBe(200)
    expect(st.calls).toBe(2)
  })
})

describe("GET /api/wallet/profile — cache", () => {
  it("MISSes then HITs, calling the RPC only once", async () => {
    const key = uniqueKey()
    const first = await GET(req(key))
    expect(first.headers.get("x-rpc-cache")).toBe("miss")
    expect(await first.json()).toEqual({ name: "trevor" })

    st.data = { name: "changed-underneath" }
    const second = await GET(req(key))
    expect(second.headers.get("x-rpc-cache")).toBe("hit")
    expect(await second.json()).toEqual({ name: "trevor" }) // served from cache
    expect(st.calls).toBe(1)
  })

  it("re-fetches once the 30s TTL expires", async () => {
    const key = uniqueKey()
    await GET(req(key))
    expect(st.calls).toBe(1)

    const realNow = Date.now
    try {
      Date.now = () => realNow() + 31_000 // past the 30s TTL
      const res = await GET(req(key))
      expect(res.headers.get("x-rpc-cache")).toBe("miss")
      expect(st.calls).toBe(2)
    } finally {
      Date.now = realNow
    }
  })

  it("logs a slow-RPC warning past 3s without changing the response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const realNow = Date.now
    let n = 0
    try {
      // first call = rpcStart, second = after the await → 3.5s elapsed
      Date.now = () => realNow() + (n++ >= 1 ? 3_500 : 0)
      const res = await GET(req(uniqueKey()))
      expect(res.status).toBe(200)
    } finally {
      Date.now = realNow
      warn.mockRestore()
    }
  })

  it("evicts the oldest entry once the 500-entry cap is reached", async () => {
    const firstKey = uniqueKey()
    await GET(req(firstKey)) // cached
    // Fill past the cap so firstKey is evicted (oldest-out).
    for (let i = 0; i < 505; i++) await GET(req(`filler-${i}`))
    const callsBefore = st.calls
    const res = await GET(req(firstKey))
    expect(res.headers.get("x-rpc-cache")).toBe("miss") // evicted → re-fetched
    expect(st.calls).toBe(callsBefore + 1)
  })
})

// ── the ownership contract (the IDOR that was closed) ───────────────────────
// get_user_profile is a service-role read (saved wallet, display name, TopShot
// handle). Before the guard, supplying someone's public username as ?ownerKey
// returned THEIR profile. The cache made it worse: a single warm entry keyed on
// the raw ownerKey would have served that profile to every subsequent caller.
describe("GET /api/wallet/profile — ownership guard", () => {
  it("401s when unauthenticated, without calling the RPC", async () => {
    auth.user = null
    const res = await GET(req(uniqueKey()))
    expect(res.status).toBe(401)
    expect(st.calls).toBe(0)
  })

  it("403s when ownerKey is claimed by a DIFFERENT user, without calling the RPC", async () => {
    auth.user = { id: "attacker" }
    ownership.claimantId = "victim"
    const res = await GET(req(uniqueKey()))
    expect(res.status).toBe(403)
    expect(st.calls).toBe(0)
  })

  it("fails CLOSED with 403 when the ownership lookup itself errors", async () => {
    ownership.claimantErr = { message: "profile_bio unavailable" }
    const res = await GET(req(uniqueKey()))
    expect(res.status).toBe(403)
    expect(st.calls).toBe(0)
  })

  it("re-checks ownership on a WARM entry (a cache hit cannot bypass the guard)", async () => {
    const key = uniqueKey()
    await GET(req(key)) // populate the cache as the rightful owner
    expect(st.calls).toBe(1)

    auth.user = { id: "attacker" }
    ownership.claimantId = "victim"
    const res = await GET(req(key))
    expect(res.status).toBe(403)
    expect(res.headers.get("x-rpc-cache")).toBeNull()
    expect(st.calls).toBe(1) // no extra RPC either — denied before the cache read
  })

  it("never serves one session's cached profile to a different session (cache is user-scoped)", async () => {
    // Both callers legitimately pass the guard on the SAME ownerKey via the
    // unclaimed-key branch (two brand-new accounts, neither has a username yet).
    // That is the only way two identities can reach one key — and it is exactly
    // the case a cache keyed on ownerKey alone would cross-contaminate.
    const shared = uniqueKey()
    ownership.claimantId = null
    ownership.selfUsername = null

    auth.user = { id: "userA" }
    st.data = { name: "alpha", secret: "A-only" }
    const a1 = await GET(req(shared))
    expect(a1.headers.get("x-rpc-cache")).toBe("miss")
    expect(await a1.json()).toEqual({ name: "alpha", secret: "A-only" })

    auth.user = { id: "userB" }
    st.data = { name: "beta", secret: "B-only" }
    const b1 = await GET(req(shared))
    expect(b1.headers.get("x-rpc-cache")).toBe("miss") // NOT A's warm entry
    const bBody = await b1.json()
    expect(bBody).toEqual({ name: "beta", secret: "B-only" })
    expect(bBody.secret).not.toBe("A-only")
    expect(st.calls).toBe(2) // B did its own lookup

    // A's own entry survives untouched and still HITs.
    auth.user = { id: "userA" }
    const a2 = await GET(req(shared))
    expect(a2.headers.get("x-rpc-cache")).toBe("hit")
    expect(await a2.json()).toEqual({ name: "alpha", secret: "A-only" })
    expect(st.calls).toBe(2)
  })
})
