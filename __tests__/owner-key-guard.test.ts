import { describe, it, expect, beforeEach, vi } from "vitest"

// Unit tests for lib/auth/owner-key-guard.ts — the shared IDOR guard for every
// route whose service-role query is scoped by a CLIENT-SUPPLIED `owner_key` /
// `ownerKey`. That value comes from localStorage, so it is a request param, not
// an identity; the guard proves it belongs to the session user via profile_bio
// (the only user_id <-> username bridge) and FAILS CLOSED on anything else.
//
// The contract pinned here:
//   no session                              -> 401
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
} = {
  user: { id: "user-1" },
  claimant: { data: null, error: null },
  self: { data: null, error: null },
}

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

// The guard issues two distinct profile_bio reads. Rather than rely on call
// order, the builder records which filter was used and returns the matching
// fixture — so a refactor that reorders the lookups can't silently pass.
const calls: { table: string; filter: string | null }[] = []

vi.mock("@/lib/supabase", () => {
  const build = (table: string) => {
    let filter: string | null = null
    const b: any = {
      select: () => b,
      ilike: (_col: string, _val: string) => {
        filter = "ilike"
        return b
      },
      eq: (_col: string, _val: string) => {
        filter = "eq"
        return b
      },
      maybeSingle: async () => {
        calls.push({ table, filter })
        return filter === "ilike" ? state.claimant : state.self
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
