import { describe, it, expect } from "vitest"
import { pageSource } from "./helpers/page-source"
import {
  fetchVerifiedWallets,
  VERIFIED_WALLETS_UNAVAILABLE,
} from "@/lib/wallet/verified-wallets"

// A failed wallet read must not tell a collector they have verified no wallets.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// /dashboard/history and /dashboard/packs each carried the SAME twenty-line
// loader, copy-pasted, with the same swallow:
//
//     const res = await fetch("/api/profile/saved-wallets", …)
//     if (!res.ok) { setWallets([]); return }
//
// and no error state anywhere, so a 503 rendered "No verified wallets yet —
// Verify a wallet from your dashboard, then come back here" with an "Open
// dashboard" button, to someone who had already done exactly that.
//
// ⚠ It is the ACTIONABILITY that makes this class worse than a wrong market
// number: the reader is the one person who knows the claim is false, has no way
// to tell that we know it too, and is being sent to redo work they finished.
//
// ⚠ TWO PATHS REACHED IT, and only one was visible in the diff. Both callers ran
// the fetch inside `try { … } finally { … }` with NO `catch`, so a thrown fetch
// escaped as an unhandled rejection while `wallets` sat at its `[]` initial
// value and the `finally` cleared the loading flag — a rendered outcome
// byte-identical to the non-2xx path. Fixing only the status check would have
// left the offline case making the same false claim.

const okBody = (wallets: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ wallets }),
})

describe("fetchVerifiedWallets — an outage is not an empty account", () => {
  it("reports ok:false on a non-2xx, even though the body parses", async () => {
    // The realistic failure: our own `lib/api-error.ts` builds a well-formed
    // JSON envelope, so the body parses fine and a `.catch` never fires.
    const res = {
      ok: false,
      status: 503,
      json: async () => ({ error: "Service temporarily unavailable", code: "unavailable" }),
    }
    const out = await fetchVerifiedWallets(async () => res as any)
    expect(out.ok).toBe(false)
    expect(out.wallets).toEqual([])
  })

  it("reports ok:false when the fetch THROWS, not an unhandled rejection", async () => {
    const out = await fetchVerifiedWallets(async () => {
      throw new TypeError("Failed to fetch")
    })
    expect(out.ok).toBe(false)
    expect(out.wallets).toEqual([])
  })

  it("reports ok:false on a 200 whose body is not the expected shape", async () => {
    // An error envelope arriving with a 200 would otherwise become a confident
    // "you have none" via `json.wallets ?? []`.
    const out = await fetchVerifiedWallets(async () => okBody(undefined) as any)
    expect(out.ok).toBe(false)
  })

  it("reports ok:false for a non-array ITERABLE — the one case the catch cannot hold", async () => {
    // ⚠ RECORDED BECAUSE A MUTATION SURVIVED, and the honest reading matters
    // more than the extra case. Deleting the `Array.isArray` guard does NOT red
    // the assertion above: measured, `for (const w of x)` THROWS for undefined,
    // null, a plain object and a number alike, so all of those land in the
    // catch and return ok:false anyway. For every shape our own routes can
    // produce, the guard is redundant behind the catch — and a comment claiming
    // it is what stops an error envelope becoming "you have none" would have
    // been wrong.
    //
    // What it uniquely owns is a STRING: `for (const w of "abc")` iterates
    // characters, every one fails the `verified_at` test, and the function
    // returns `{ wallets: [], ok: true }` — a silent false "you have none".
    // Kept and pinned because it is one line and the failure is silent, not
    // because our API is about to start returning one.
    const out = await fetchVerifiedWallets(async () => okBody("0xabc") as any)
    expect(out.ok).toBe(false)
  })

  it("a genuinely empty account is ok:true — the invitation must survive", async () => {
    // The other direction, and it matters: turning every empty result into
    // "couldn't load" would leave a brand-new user with no way forward, which
    // is the cry-wolf outcome this repo documents for `board-status.ts`.
    const out = await fetchVerifiedWallets(async () => okBody([]) as any)
    expect(out.ok).toBe(true)
    expect(out.wallets).toEqual([])
  })

  it("keeps EVERY saved wallet (verified or not), de-duplicated and lower-cased — 09-06, #59", async () => {
    const out = await fetchVerifiedWallets(
      async () =>
        okBody([
          { wallet_addr: "0xAAAAAAAAAAAAAAAA", verified_at: "2026-01-01T00:00:00Z" },
          { wallet_addr: "0xaaaaaaaaaaaaaaaa", verified_at: "2026-02-01T00:00:00Z" },
          { wallet_addr: "0xbbbbbbbbbbbbbbbb", verified_at: null }, // unverified
        ]) as any,
    )
    expect(out.ok).toBe(true)
    expect(out.wallets).toEqual([
      { wallet_addr: "0xaaaaaaaaaaaaaaaa", verified_at: "2026-01-01T00:00:00Z" },
      // An UNVERIFIED saved wallet is a wallet the history pages can read now —
      // the listing check has no data source, so "verified only" meant "nobody".
      { wallet_addr: "0xbbbbbbbbbbbbbbbb", verified_at: null },
    ])
  })

  it("the failure copy does not tell the reader to go verify a wallet", async () => {
    // The specific harm was not the absence of an error message — it was the
    // instruction to redo work. A future edit that reintroduces it reds here.
    expect(VERIFIED_WALLETS_UNAVAILABLE).not.toMatch(/verify|connect|add a wallet/i)
    expect(VERIFIED_WALLETS_UNAVAILABLE).toMatch(/says nothing about/i)
  })
})

describe("both dashboard pages branch on the failure BEFORE the empty state", () => {
  // ⚠ Asserted at source. The ordering is the whole fix — a `walletsFailed`
  // branch placed after `wallets.length === 0` is dead code, and every runtime
  // assertion above would still pass with it there.
  //
  // ⚠ Contiguity, not indexOf-ordering. The vacuous-ordering trap recorded
  // twice already in this repo bites when EITHER needle recurs, and
  // `wallets.length === 0` is not guaranteed unique in a 700-line page.
  // ⚠ DIRECTORIES, not `page.tsx`. Both pages have since been split into a thin
  // shell plus a sibling `*Client.tsx`, which moved every needle below out of
  // `page.tsx` (walletsFailed: 3 hits in the client, 1 in the shell) and reddened
  // this guard on a refactor that changed no behaviour. `pageSource` reads the
  // page as a unit so the assertions keep their full strength either way — the
  // contiguity regex still holds because the branch lives wholly in one file.
  const PAGES = ["app/dashboard/history", "app/dashboard/packs"]

  it.each(PAGES)("%s: walletsFailed is checked immediately before the empty branch", (rel) => {
    const src = pageSource(rel)
    expect(src).toContain(") : walletsFailed ? (")
    // The failure branch's closing ternary arm runs straight into the empty one.
    expect(src).toMatch(/\) : walletsFailed \? \([\s\S]{0,900}?\) : wallets\.length === 0 \? \(/)
  })

  it.each(PAGES)("%s: reads through the shared module, not its own fetch", (rel) => {
    const src = pageSource(rel)
    expect(src).toContain("fetchVerifiedWallets")
    // The copy-pasted loader must not come back. Both pages legitimately fetch
    // other endpoints, so this is scoped to the saved-wallets call itself.
    expect(src).not.toMatch(/fetch\(\s*["']\/api\/profile\/saved-wallets["']/)
  })
})

// ── The stored address is chain-scoped (2026-09-20) ─────────────────────────
//
// ⚠ `k` here is not only a dedupe key — it is STORED as `wallet_addr` and is
// what the selector on /dashboard/history and /dashboard/packs then queries
// with. It folded to lower case, so a saved Candy wallet would have been
// DESTROYED AT THE SOURCE: base58 is case-sensitive, and the pages downstream
// cannot tell a destroyed key from a wallet that holds nothing. That is this
// file's own defect class — a failed read rendering as a fact — reached by a
// different route.
//
// ⚠ LATENT, NOT LIVE. Measured 2026-09-20: `saved_wallets` holds 135 rows, 0
// non-hex, 0 with any uppercase. It fires on the first Candy wallet saved.
describe("fetchVerifiedWallets — the address it stores survives the round trip", () => {
  const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"

  it("returns a base58 address verbatim, not folded", async () => {
    const out = await fetchVerifiedWallets(
      async () => okBody([{ wallet_addr: CANDY, verified_at: null }]) as any,
    )
    expect(out.ok).toBe(true)
    expect(out.wallets.map((w) => w.wallet_addr)).toEqual([CANDY])
    // The assertion that would have failed before: the folded form is a
    // different string, and it is the one that used to be stored.
    expect(out.wallets[0].wallet_addr).not.toBe(CANDY.toLowerCase())
  })

  it("keeps two base58 addresses differing only in case as two wallets", async () => {
    const other = CANDY.slice(0, -1) + "k"
    const out = await fetchVerifiedWallets(
      async () =>
        okBody([
          { wallet_addr: CANDY, verified_at: null },
          { wallet_addr: other, verified_at: null },
        ]) as any,
    )
    expect(out.wallets).toHaveLength(2)
  })

  it("hex no-change arm: still folds Flow and still dedupes on the folded form", async () => {
    const out = await fetchVerifiedWallets(
      async () =>
        okBody([
          { wallet_addr: "0xBD94CADE097E50AC", verified_at: null },
          { wallet_addr: "0xbd94cade097e50ac", verified_at: "2026-01-01" },
        ]) as any,
    )
    expect(out.wallets).toHaveLength(1)
    expect(out.wallets[0].wallet_addr).toBe("0xbd94cade097e50ac")
    expect(out.wallets[0].verified_at).toBe("2026-01-01")
  })
})
