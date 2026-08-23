// A pinned-wallet read that HANGS must not render as "you have not connected a
// wallet".
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `fetchPinnedWallet` already distinguished a failed read (`ok: false`) from a
// genuinely unpinned account (`{ wallet: null, ok: true }`) — that distinction
// is the module's whole reason for existing, and both callers (`/fast-break`,
// `/road-to-the-ring`) branch on it.
//
// ⚠ But it could only reach `ok: false` from an ERROR, and the failure this
// class actually produces is not an error. Under DB saturation the await simply
// does not return: supabase-js resolves `{ data, error }` only when the query
// finishes, so a slow read errors NOWHERE. Both pages are `force-dynamic`, so
// the reader gets a streaming shell that never completes — which Vercel logs as
// a 200. That is the "200-but-broken-DOM" shape in its latency form, and it is
// the fourth occurrence of the unbounded-server-read class.
//
// The bound routes a slow read into the branch that already existed, so the two
// assertions worth making are:
//
//   1. a read that overruns resolves `ok: false` — NOT `{ wallet: null, ok: true }`,
//      which is the false claim about the reader's own account;
//   2. a read that is merely SLOW BUT INSIDE the budget still resolves normally,
//      so the bound cannot be satisfied by a function that always fails.
//
// ⚠ (2) is the control that makes (1) mean something. Without it a stub that
// returned `ok: false` unconditionally would pass, and this file would report
// coverage for a module that had stopped working entirely.

import { describe, it, expect } from "vitest"
import { fetchPinnedWallet } from "@/lib/wallet/pinned-wallet"

const USER = "11111111-1111-1111-1111-111111111111"
const COLLECTION = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

/**
 * A `saved_wallets` query stub whose `maybeSingle()` settles after `delayMs`.
 *
 * Every builder method returns `this`, matching the real chain, so the module
 * under test is exercised through its actual call shape rather than a shortcut.
 */
function slowDb(delayMs: number, result: { data: unknown; error: { message: string } | null }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => new Promise((resolve) => setTimeout(() => resolve(result), delayMs)),
  }
  return { from: () => chain }
}

describe("fetchPinnedWallet — a slow read is not an unpinned account", () => {
  it("resolves ok:false when the read overruns its budget", async () => {
    // 3s budget; this read would take a minute.
    const res = await fetchPinnedWallet(USER, COLLECTION, slowDb(60_000, { data: null, error: null }))

    expect(res.ok, "an overrun read must report FAILURE").toBe(false)
    // ⚠ Assert the ABSENCE of the false claim, not just the presence of a flag:
    // `{ wallet: null, ok: true }` is what tells a collector who HAS pinned a
    // wallet to go connect one.
    expect(
      res.wallet === null && res.ok === true,
      "must never resolve as a genuine 'no wallet pinned'",
    ).toBe(false)
  }, 15_000)

  it("CONTROL — a read inside the budget still resolves normally", async () => {
    const res = await fetchPinnedWallet(
      USER,
      COLLECTION,
      slowDb(10, { data: { wallet_addr: "0xAABBCCDDEEFF0011" }, error: null }),
    )

    expect(res.ok).toBe(true)
    expect(res.wallet).toBe("0xaabbccddeeff0011")
  })

  it("CONTROL — a genuinely unpinned account is still ok:true", async () => {
    // The branch the bound must not swallow: we asked, and the answer is "none".
    const res = await fetchPinnedWallet(USER, COLLECTION, slowDb(10, { data: null, error: null }))

    expect(res).toEqual({ wallet: null, ok: true })
  })

  it("CONTROL — a driver error is still ok:false", async () => {
    const res = await fetchPinnedWallet(
      USER,
      COLLECTION,
      slowDb(10, { data: null, error: { message: "canceling statement due to statement timeout" } }),
    )

    expect(res).toEqual({ wallet: null, ok: false })
  })
})
