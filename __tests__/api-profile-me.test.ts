import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/me.
// getCurrentUser()-gated but deliberately fail-SOFT: unauthenticated returns
// 200 { user: null } (never 401) so public pages can call it unconditionally.
// Pin the unauthenticated payload and an authed happy path enriched via
// allow_list + resolveDisplayName.

const state: {
  user: any
  allow: { data: any; error: any }
  saved: { data: any; error: any }
  bio: { data: any; error: any }
} = {
  user: null,
  allow: { data: null, error: null },
  saved: { data: null, error: null },
  bio: { data: null, error: null },
}

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) =>
      chain(() =>
        table === "saved_wallets" ? state.saved : table === "profile_bio" ? state.bio : state.allow
      ),
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

vi.mock("@/lib/user/resolveDisplayName", () => ({
  resolveDisplayName: async () => ({ display_name: "Trevor", source: "profile_bio" }),
}))

import { GET } from "@/app/api/profile/me/route"

beforeEach(() => {
  state.user = null
  state.allow = { data: null, error: null }
  state.saved = { data: null, error: null }
  state.bio = { data: null, error: null }
})

// ⚠ THE PUBLIC HANDLE WINS (2026-09-02, onboarding QA finding #2). `username`
// here is what ProfileClient compares against `/profile/<u>` to decide the
// viewer owns the page; until this read existed an address-path signup (no Top
// Shot name anywhere) got `username: null` while their profile existed, and the
// owner-only share block never rendered on their own page.
describe("GET /api/profile/me — profile_bio.username is the handle", () => {
  it("prefers the profile_bio handle over the allow_list and saved_wallets names", async () => {
    state.user = { id: "h1", email: "a@b.com" }
    state.bio = { data: { username: "qa0903" }, error: null }
    state.allow = { data: { username: "allowname", wallet_addr: "0xabc" }, error: null }
    state.saved = { data: { wallet_addr: "0xsaved", username: "topshotname" }, error: null }
    const body = await (await GET()).json()
    expect(body.user.username).toBe("qa0903")
    expect(body.user.wallet_addr).toBe("0xabc") // wallet still comes from the old chain
  })

  it("an address-path signup with a chosen handle and no Top Shot name answers the handle", async () => {
    state.user = { id: "h2", email: "a@b.com" }
    state.bio = { data: { username: "qa0903" }, error: null }
    state.allow = { data: null, error: null }
    state.saved = { data: { wallet_addr: "0xsaved", username: null }, error: null }
    const body = await (await GET()).json()
    expect(body.user.username).toBe("qa0903")
    expect(body.user.identity_degraded).toBe(false)
  })

  it("a blank handle does not mask the fallbacks", async () => {
    state.user = { id: "h3", email: "a@b.com" }
    state.bio = { data: { username: "   " }, error: null }
    state.saved = { data: { wallet_addr: "0xsaved", username: "topshotname" }, error: null }
    const body = await (await GET()).json()
    expect(body.user.username).toBe("topshotname")
  })

  it("a failed profile_bio read is degraded, not a known absence", async () => {
    state.user = { id: "h4", email: "a@b.com" }
    state.bio = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }
    const body = await (await GET()).json()
    expect(body.user.identity_degraded).toBe(true)
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })
})

describe("GET /api/profile/me", () => {
  it("returns { user: null } with no-store when unauthenticated (fail-soft, no 401)", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect((await res.json()).user).toBeNull()
  })

  it("returns the enriched identity for an authed user", async () => {
    state.user = { id: "u1", email: "a@b.com", created_at: "2026-01-01" }
    state.allow = { data: { username: "trevor", wallet_addr: "0xabc" }, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.id).toBe("u1")
    expect(body.user.username).toBe("trevor")
    expect(body.user.wallet_addr).toBe("0xabc")
    expect(body.user.display_name).toBe("Trevor")
    expect(body.user.display_name_source).toBe("profile_bio")
  })

  // The load-bearing open-door fallback (route lines 47-55): self-serve signups
  // after 2026-07-20 have no allow_list row, so wallet_addr must come from
  // saved_wallets — the field the Pro badge + concierge key on.
  it("falls back to saved_wallets when there is no allow_list row", async () => {
    state.user = { id: "u2", email: "c@d.com", created_at: "2026-08-01" }
    state.allow = { data: null, error: null } // open-door signup: no allow_list row
    state.saved = { data: { wallet_addr: "0xsaved", username: "savedname" }, error: null }
    const res = await GET()
    const body = await res.json()
    expect(body.user.wallet_addr).toBe("0xsaved")
    expect(body.user.username).toBe("savedname")
  })

  it("keeps the allow_list username but takes wallet_addr from saved_wallets when the allow_list wallet is null", async () => {
    state.user = { id: "u4", email: "e@f.com" }
    state.allow = { data: { username: "allowuser", wallet_addr: null }, error: null }
    state.saved = { data: { wallet_addr: "0xfromsaved", username: "savedbackup" }, error: null }
    const res = await GET()
    const body = await res.json()
    expect(body.user.username).toBe("allowuser") // username ?? saved keeps the left side
    expect(body.user.wallet_addr).toBe("0xfromsaved")
  })

  it("skips the allow_list lookup entirely for a user with no email, using saved_wallets", async () => {
    state.user = { id: "u3", email: null }
    // allow_list is never queried (guarded by `if (user.email)`); if it were, this
    // stale row would leak through — asserting it does NOT proves the skip.
    state.allow = { data: { username: "should-not-appear", wallet_addr: "0xshould-not" }, error: null }
    state.saved = { data: { wallet_addr: "0xnoemail", username: "noemail" }, error: null }
    const res = await GET()
    const body = await res.json()
    expect(body.user.email).toBeNull()
    expect(body.user.wallet_addr).toBe("0xnoemail")
    expect(body.user.username).toBe("noemail")
  })

  it("resolves wallet_addr and username to null when neither allow_list nor saved_wallets has one", async () => {
    state.user = { id: "u5", email: "g@h.com" }
    state.allow = { data: null, error: null }
    state.saved = { data: null, error: null }
    const res = await GET()
    const body = await res.json()
    expect(body.user.wallet_addr).toBeNull()
    expect(body.user.username).toBeNull()
    // CONTROL: genuinely absent is NOT degraded. Without this, identity_degraded
    // being always-true would satisfy every test below and mean nothing.
    expect(body.user.identity_degraded).toBe(false)
  })
})

// ⚠ "YOU HAVE NO WALLET ON FILE" vs "WE COULD NOT READ WHETHER YOU DO".
// Both lookups swallowed `error`, and supabase-js RETURNS errors rather than
// throwing, so a failed read resolved `{ data: null, error }` and this route
// answered 200 with `wallet_addr: null` — asserting an absence about the
// reader's OWN ACCOUNT that it had not established.
//
// Why it bites: wallet_addr is what the Pro badge keys on
// (useSessionOwner -> useProStatus(walletAddr) -> isPro:false), so a failed read
// takes the badge away from a paying member. And the 200 made it UNDETECTABLE —
// DashboardClient carries a `meFailed` flag for exactly this case and it never
// fired, because the request had not failed.
describe("GET /api/profile/me — a failed lookup is not a known absence", () => {
  const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" }

  it("flags identity_degraded when the allow_list read fails", async () => {
    state.user = { id: "u6", email: "g@h.com" }
    state.allow = { data: null, error: TIMEOUT }
    state.saved = { data: null, error: null }
    const body = await (await GET()).json()
    expect(body.user.identity_degraded).toBe(true)
  })

  it("flags identity_degraded when the saved_wallets fallback fails", async () => {
    state.user = { id: "u7", email: "g@h.com" }
    state.allow = { data: null, error: null }
    state.saved = { data: null, error: TIMEOUT }
    const body = await (await GET()).json()
    expect(body.user.identity_degraded).toBe(true)
  })

  it("still reports the signed-in fact, which IS known — it must not render as anon", async () => {
    // getCurrentUser() succeeded, so "signed in" is established even though the
    // enrichment is not. Returning 5xx here would make a signed-in reader render
    // as ANON on every public board that calls this unconditionally — trading a
    // quiet false claim for a louder one.
    state.user = { id: "u8", email: "g@h.com" }
    state.allow = { data: null, error: TIMEOUT }
    state.saved = { data: null, error: TIMEOUT }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user).not.toBeNull()
    expect(body.user.id).toBe("u8")
  })

  it("does not leak the driver message into the response", async () => {
    state.user = { id: "u9", email: "g@h.com" }
    state.allow = { data: null, error: TIMEOUT }
    state.saved = { data: null, error: null }
    const body = await (await GET()).json()
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("CONTROL: a successful enriched read is not degraded", async () => {
    state.user = { id: "u10", email: "g@h.com" }
    state.allow = { data: { username: "whale", wallet_addr: "0xabc" }, error: null }
    state.saved = { data: null, error: null }
    const body = await (await GET()).json()
    expect(body.user.wallet_addr).toBe("0xabc")
    expect(body.user.identity_degraded).toBe(false)
  })
})
