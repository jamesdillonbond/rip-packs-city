import { describe, it, expect, beforeEach, vi } from "vitest"

// Unit tests for lib/auth/owner-key-guard.ts — the shared IDOR guard for every
// route whose service-role query is scoped by a CLIENT-SUPPLIED `owner_key` /
// `ownerKey`. That value comes from localStorage, so it is a request param, not
// an identity; the guard proves it belongs to the session user via profile_bio
// (the only user_id <-> username bridge) and FAILS CLOSED on anything else.
//
// `owner_key` is POLYMORPHIC (measured on live data 2026-08-01): it holds an
// auth user UUID, a profile_bio username, OR a 0x-prefixed 16-hex Flow address
// (what localStorage `rpc_owner_key` actually carries once collection/page.tsx
// or SignInWithDapper overwrite it, and therefore what WalletHydrator sends).
// The guard bridges all three namespaces, cheapest-first.
//
// The contract pinned here:
//   no session                              -> 401
//   empty / non-string key                  -> 403      (no query at all)
//   key IS the caller's own user id         -> allowed  (Bridge 1, NO query)
//   address owned by the caller             -> allowed  (Bridge 2)
//   address owned by SOMEONE ELSE           -> 403      (Bridge 2 IDOR case)
//   address owned by several incl. caller   -> allowed  (membership, not equality)
//   address unclaimed                       -> falls through to the username rules
//   NON-address-shaped key                  -> never probes saved_wallets
//   key claimed by ANOTHER user             -> 403
//   key claimed by SELF (case-insensitive)  -> allowed
//   key unclaimed + caller has no username  -> allowed  (brand-new account)
//   key unclaimed + caller HAS a username   -> 403
//   DB error resolving ownership            -> 403      (never opens)

// `data` is typed `any | null` up front: a mock state initialised to a narrow
// type and then assigned null in an error case is the single most repeated
// TS2322 CI breakage in this repo. Every result object carries BOTH data and
// error, for the same reason (TS2741).
type MockResult = { data: any | null; error: any | null }

const state: {
  user: { id: string } | null
  // resolved by .ilike("username", key) — "who claims this key?"
  claimant: MockResult
  // resolved by .eq("user_id", user.id) — "does the caller have a username?"
  self: MockResult
  // resolved by saved_wallets.eq("wallet_addr", addr) — "who saved this wallet?"
  // A LIST (a wallet may legitimately be saved by several users), so `data` is
  // an array here — still typed `any | null` so an error case can assign null.
  savedWallets: MockResult
} = {
  user: { id: "user-1" },
  claimant: { data: null, error: null },
  self: { data: null, error: null },
  savedWallets: { data: [], error: null },
}

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

// The guard issues two distinct profile_bio reads. Rather than rely on call
// order, the builder records which filter was used and returns the matching
// fixture — so a refactor that reorders the lookups can't silently pass.
const calls: { table: string; filter: string | null; value: string | null }[] = []

vi.mock("@/lib/supabase", () => {
  const build = (table: string) => {
    let filter: string | null = null
    let value: string | null = null
    const resultFor = (): MockResult => {
      if (table === "saved_wallets") return state.savedWallets
      return filter === "ilike" ? state.claimant : state.self
    }
    const b: any = {
      select: () => b,
      ilike: (_col: string, val: string) => {
        filter = "ilike"
        value = val
        return b
      },
      eq: (_col: string, val: string) => {
        filter = "eq"
        value = val
        return b
      },
      maybeSingle: async () => {
        calls.push({ table, filter, value })
        return resultFor()
      },
      // The saved_wallets probe returns a LIST, so the guard awaits the builder
      // itself rather than calling .maybeSingle(). Making the builder thenable
      // is what lets that await resolve — and recording the call here is what
      // lets a test assert the table was (or, for the shape guard, was NOT)
      // touched.
      then: (onFulfilled: any, onRejected: any) => {
        calls.push({ table, filter, value })
        return Promise.resolve(resultFor()).then(onFulfilled, onRejected)
      },
    }
    return b
  }
  const client: any = { from: (t: string) => build(t) }
  return { supabase: client, supabaseAdmin: client }
})

import { requireOwnedKey } from "@/lib/auth/owner-key-guard"

async function bodyOf(res: Response) {
  return JSON.parse(await res.text())
}

beforeEach(() => {
  state.user = { id: "user-1" }
  state.claimant = { data: null, error: null }
  state.self = { data: null, error: null }
  state.savedWallets = { data: [], error: null }
  calls.length = 0
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("requireOwnedKey — unauthenticated", () => {
  it("returns 401 when there is no session", async () => {
    state.user = null
    const res = await requireOwnedKey("trevor")
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(401)
    expect(await bodyOf(res as Response)).toEqual({ error: "Authentication required" })
  })

  it("checks the session BEFORE touching the database", async () => {
    state.user = null
    await requireOwnedKey("trevor")
    expect(calls).toHaveLength(0)
  })
})

// Helper: which tables did the guard actually touch?
const tablesTouched = () => calls.map((c) => c.table)
const savedWalletCalls = () => calls.filter((c) => c.table === "saved_wallets")

describe("requireOwnedKey — Bridge 1: the key IS the caller's user id", () => {
  // Every row in portfolio_snapshots is keyed by the auth user UUID, so this is
  // the live shape for that surface. It is a pure string compare — the WHOLE
  // point of the fast path is that it costs no query, so that is asserted.
  it("allows when the key equals the session user id, WITHOUT any DB query", async () => {
    state.user = { id: "3f6d1c2e-9b40-4a11-8c77-2e5b0d9a1f33" }
    const res = await requireOwnedKey("3f6d1c2e-9b40-4a11-8c77-2e5b0d9a1f33")
    expect(res).not.toBeInstanceOf(Response)
    expect((res as { user: { id: string } }).user.id).toBe(
      "3f6d1c2e-9b40-4a11-8c77-2e5b0d9a1f33",
    )
    expect(calls).toHaveLength(0)
  })

  it("compares the user id case-insensitively (and trims), still without a query", async () => {
    state.user = { id: "3F6D1C2E-9B40-4A11-8C77-2E5B0D9A1F33" }
    const res = await requireOwnedKey("  3f6d1c2e-9b40-4a11-8c77-2e5b0d9a1f33  ")
    expect(res).not.toBeInstanceOf(Response)
    expect(calls).toHaveLength(0)
  })

  it("does NOT short-circuit for a different user's id (falls through to the claim rules)", async () => {
    state.user = { id: "user-1" }
    state.claimant = { data: null, error: null }
    state.self = { data: { username: "trevor" }, error: null }
    const res = await requireOwnedKey("user-2")
    expect((res as Response).status).toBe(403)
    // it really did fall through and consult profile_bio
    expect(tablesTouched()).toContain("profile_bio")
  })
})

describe("requireOwnedKey — Bridge 2: the key is a Flow wallet address", () => {
  const ADDR = "0xbd94cade097e50ac"

  it("allows an address saved by the caller", async () => {
    state.savedWallets = { data: [{ user_id: "user-1" }], error: null }
    const res = await requireOwnedKey(ADDR)
    expect(res).not.toBeInstanceOf(Response)
    expect((res as { user: { id: string } }).user.id).toBe("user-1")
    // resolved on saved_wallets alone — profile_bio is never consulted
    expect(savedWalletCalls()).toHaveLength(1)
    expect(tablesTouched()).not.toContain("profile_bio")
  })

  it("lowercases a mixed-case address before probing saved_wallets", async () => {
    state.savedWallets = { data: [{ user_id: "user-1" }], error: null }
    const res = await requireOwnedKey("  0xBD94CADE097E50AC  ")
    expect(res).not.toBeInstanceOf(Response)
    expect(savedWalletCalls()[0]?.value).toBe(ADDR)
  })

  it("returns 403 when the address is saved by a DIFFERENT user (the IDOR case)", async () => {
    state.savedWallets = { data: [{ user_id: "user-2" }], error: null }
    const res = await requireOwnedKey(ADDR)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(403)
    expect(await bodyOf(res as Response)).toEqual({ error: "Forbidden" })
    // a claimed-by-someone-else address is decided here; it must NOT get a
    // second bite at the apple through the username branch
    expect(tablesTouched()).not.toContain("profile_bio")
  })

  it("allows when several users saved the address and the caller is one of them", async () => {
    // Membership, not equality — pinning someone else's wallet is supported, so
    // more than one saved_wallets row per address is legitimate.
    state.savedWallets = {
      data: [{ user_id: "user-9" }, { user_id: "user-1" }, { user_id: "user-7" }],
      error: null,
    }
    const res = await requireOwnedKey(ADDR)
    expect(res).not.toBeInstanceOf(Response)
    expect((res as { user: { id: string } }).user.id).toBe("user-1")
  })

  it("returns 403 when several users saved the address and the caller is NOT one", async () => {
    state.savedWallets = {
      data: [{ user_id: "user-9" }, { user_id: "user-7" }],
      error: null,
    }
    expect(((await requireOwnedKey(ADDR)) as Response).status).toBe(403)
  })

  it("fails CLOSED with 403 when the saved_wallets lookup errors", async () => {
    state.savedWallets = { data: null, error: { message: "boom", code: "57014" } }
    const res = await requireOwnedKey(ADDR)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(403)
    // an error must not be retried through the username branch either
    expect(tablesTouched()).not.toContain("profile_bio")
  })

  it("returns 403 for an UNCLAIMED address when the caller already has a username", async () => {
    state.savedWallets = { data: [], error: null }
    state.claimant = { data: null, error: null }
    state.self = { data: { username: "trevor" }, error: null }
    const res = await requireOwnedKey(ADDR)
    expect((res as Response).status).toBe(403)
    // it fell through to the username rules rather than deciding on the address
    expect(tablesTouched()).toContain("profile_bio")
  })

  it("allows an UNCLAIMED address for a brand-new caller with no username", async () => {
    state.savedWallets = { data: [], error: null }
    state.claimant = { data: null, error: null }
    state.self = { data: null, error: null }
    const res = await requireOwnedKey(ADDR)
    expect(res).not.toBeInstanceOf(Response)
    expect((res as { user: { id: string } }).user.id).toBe("user-1")
  })

  it("treats a null row set the same as an empty one (falls through, does not open)", async () => {
    state.savedWallets = { data: null, error: null }
    state.claimant = { data: null, error: null }
    state.self = { data: { username: "trevor" }, error: null }
    expect(((await requireOwnedKey(ADDR)) as Response).status).toBe(403)
  })

  it("ignores rows with a null user_id (an unattributable row is not a claim)", async () => {
    state.savedWallets = { data: [{ user_id: null }], error: null }
    state.claimant = { data: null, error: null }
    state.self = { data: { username: "trevor" }, error: null }
    expect(((await requireOwnedKey(ADDR)) as Response).status).toBe(403)
    expect(tablesTouched()).toContain("profile_bio")
  })
})

describe("requireOwnedKey — Bridge 2 shape guard", () => {
  // Only address-SHAPED keys may be resolved through saved_wallets. If a
  // username could reach that probe, a user could be authorized by a row they
  // do not own, so the regex is load-bearing: pin that non-addresses never
  // touch the table at all.
  const NOT_ADDRESSES = [
    "trevor",                     // plain username
    "0xbd94cade097e50a",          // 15 hex — too short
    "0xbd94cade097e50acd",        // 17 hex — too long
    "bd94cade097e50ac",           // missing 0x
    "0xbd94cade097e50aZ",         // non-hex character
    "0x%",                        // wildcard probe
    "3f6d1c2e-9b40-4a11-8c77-2e5b0d9a1f33", // a UUID (someone else's)
  ]

  for (const key of NOT_ADDRESSES) {
    it(`never probes saved_wallets for ${JSON.stringify(key)}`, async () => {
      state.savedWallets = { data: [{ user_id: "user-1" }], error: null }
      state.claimant = { data: null, error: null }
      state.self = { data: { username: "trevor" }, error: null }
      const res = await requireOwnedKey(key)
      // resolved purely through the username rules -> 403, and crucially the
      // wallet fixture (which WOULD have allowed) was never consulted
      expect((res as Response).status).toBe(403)
      expect(savedWalletCalls()).toHaveLength(0)
    })
  }
})

describe("requireOwnedKey — claimed keys", () => {
  it("returns 403 when the key is claimed by ANOTHER user (the IDOR case)", async () => {
    state.claimant = { data: { user_id: "user-2", username: "trevor" }, error: null }
    const res = await requireOwnedKey("trevor")
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(403)
    expect(await bodyOf(res as Response)).toEqual({ error: "Forbidden" })
  })

  it("allows the caller when the key is claimed by SELF", async () => {
    state.claimant = { data: { user_id: "user-1", username: "trevor" }, error: null }
    const res = await requireOwnedKey("trevor")
    expect(res).not.toBeInstanceOf(Response)
    expect((res as { user: { id: string } }).user.id).toBe("user-1")
  })

  it("matches the claim case-insensitively (and ignores surrounding whitespace)", async () => {
    state.claimant = { data: { user_id: "user-1", username: "Trevor" }, error: null }
    const res = await requireOwnedKey("  TREVOR  ")
    expect(res).not.toBeInstanceOf(Response)
    expect((res as { user: { id: string } }).user.id).toBe("user-1")
  })

  it("does NOT accept a wildcard ilike match as a claim", async () => {
    // PostgREST treats % as a wildcard, so "tre%" can match "trevor". The guard
    // re-compares the returned username exactly, so this is not ownership —
    // it falls through to the unclaimed branch, where the caller's own username
    // rejects it.
    state.claimant = { data: { user_id: "user-1", username: "trevor" }, error: null }
    state.self = { data: { username: "trevor" }, error: null }
    const res = await requireOwnedKey("tre%")
    expect((res as Response).status).toBe(403)
  })
})

describe("requireOwnedKey — unclaimed keys", () => {
  it("allows a brand-new caller who has not claimed a username yet", async () => {
    state.claimant = { data: null, error: null }
    state.self = { data: null, error: null } // no profile_bio row at all
    const res = await requireOwnedKey("brand-new-key")
    expect(res).not.toBeInstanceOf(Response)
    expect((res as { user: { id: string } }).user.id).toBe("user-1")
  })

  it("allows a caller whose profile_bio row exists but has an empty username", async () => {
    state.claimant = { data: null, error: null }
    state.self = { data: { username: "   " }, error: null }
    const res = await requireOwnedKey("brand-new-key")
    expect(res).not.toBeInstanceOf(Response)
  })

  it("returns 403 when the caller ALREADY has a username of their own", async () => {
    state.claimant = { data: null, error: null }
    state.self = { data: { username: "trevor" }, error: null }
    const res = await requireOwnedKey("somebody-elses-key")
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(403)
    expect(await bodyOf(res as Response)).toEqual({ error: "Forbidden" })
  })
})

describe("requireOwnedKey — fails closed", () => {
  it("returns 403 when the claimant lookup errors", async () => {
    state.claimant = { data: null, error: { message: "boom", code: "PGRST116" } }
    const res = await requireOwnedKey("trevor")
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(403)
  })

  it("returns 403 when the caller's own profile lookup errors", async () => {
    state.claimant = { data: null, error: null }
    state.self = { data: null, error: { message: "boom" } }
    const res = await requireOwnedKey("trevor")
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(403)
  })

  it("returns 403 for an empty / non-string key rather than querying with it", async () => {
    expect(((await requireOwnedKey("")) as Response).status).toBe(403)
    expect(((await requireOwnedKey("   ")) as Response).status).toBe(403)
    expect(((await requireOwnedKey(undefined as unknown as string)) as Response).status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})
