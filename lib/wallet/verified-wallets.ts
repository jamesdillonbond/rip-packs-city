// lib/wallet/verified-wallets.ts
//
// "Which wallets has this signed-in user SAVED?" (was: verified — see the 09-06
// note in fetchVerifiedWallets) — the client-side read
// behind the wallet selector on /dashboard/history and /dashboard/packs.
//
// ⚠ WHY IT IS SHARED. The identical twenty-line loader was copy-pasted into
// both pages, carrying the identical defect into both: a non-2xx did
// `setWallets([])` and returned, with no error state anywhere, so a failed read
// rendered
//
//     No verified wallets yet
//     … reads from your verified wallets. Verify a wallet from your
//     dashboard, then come back here.
//
// to a collector who HAS verified one. That is a claim about the reader's own
// account manufactured from our own outage, and — the part that makes this
// class worse than a wrong market number — it is ACTIONABLE: it sends them off
// to redo work they already did, and the "Open dashboard" button makes doing so
// one tap away.
//
// It is also the second copy-pasted instance of this exact shape found in two
// days (`lib/wallet/pinned-wallet.ts` covers /fast-break + /road-to-the-ring),
// which is why the remedy is one module rather than two edits. This repo has
// paid for the copy-paste version of a defect twice over already: 15 OG cards
// and 5 sales indexers.
//
// ⚠ NOT merged with `fetchPinnedWallet`. That one is a SERVER read of a single
// collection-scoped pin and deliberately does not require verification; this is
// a CLIENT fetch of every verified wallet across collections. Unifying them
// would silently start gating the game surfaces on verification — the same
// reason that module records for staying separate from `fetchBoundWallet`.

export interface VerifiedWallet {
  wallet_addr: string
  verified_at: string | null
}

export interface VerifiedWalletsResult {
  wallets: VerifiedWallet[]
  /**
   * ⚠ false ONLY when the read failed. A user who genuinely has verified no
   * wallet is `{ wallets: [], ok: true }` — the "verify a wallet" invitation is
   * exactly right for THEM, and suppressing it would leave them with no way
   * forward. The two states must never share a branch.
   */
  ok: boolean
}

/**
 * Every verified wallet on the signed-in user's account, de-duplicated by
 * address (lower-cased), in the order the API returned them.
 *
 * ⚠ Never throws. Both callers ran this inside `try { … } finally { … }` with
 * no `catch`, so a thrown fetch — an offline browser, a DNS blip — escaped as
 * an unhandled rejection while `wallets` stayed at its `[]` initial value and
 * `walletsLoading` was cleared by the `finally`. The rendered outcome was
 * byte-identical to the non-2xx path: the same false claim, reached a second
 * way. Returning `ok: false` for both is what collapses them.
 */
export async function fetchVerifiedWallets(
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedWalletsResult> {
  try {
    const res = await fetchImpl("/api/profile/saved-wallets", { cache: "no-store" })
    if (!res.ok) return { wallets: [], ok: false }
    const json = (await res.json()) as { wallets?: VerifiedWallet[] }
    // ⚠ A 200 whose body is not the expected shape is a FAILED read, not an
    // empty account. `json.wallets ?? []` alone would turn an error envelope
    // that happens to arrive with a 200 into a confident "you have none".
    if (!Array.isArray(json?.wallets)) return { wallets: [], ok: false }

    // 2026-09-06 (#59, decision delegated by Trevor): EVERY saved wallet, not
    // only the verified ones. Verification-by-listing lost its data source, so
    // "verified only" here meant "nobody" — the history routes now gate on
    // SAVED too. A verified wallet still sorts first so the badge keeps meaning.
    const seen = new Map<string, VerifiedWallet>()
    for (const w of json.wallets) {
      if (!w || typeof w.wallet_addr !== "string") continue
      const k = w.wallet_addr.toLowerCase()
      const verifiedAt = typeof w.verified_at === "string" ? w.verified_at : null
      const prev = seen.get(k)
      if (!prev) seen.set(k, { wallet_addr: k, verified_at: verifiedAt })
      else if (!prev.verified_at && verifiedAt) prev.verified_at = verifiedAt
    }
    return { wallets: Array.from(seen.values()), ok: true }
  } catch {
    return { wallets: [], ok: false }
  }
}

/**
 * The one line both pages show when the read failed.
 *
 * ⚠ It deliberately says nothing about whether the reader has wallets, because
 * we do not know — and it deliberately does not tell them to go verify one,
 * which is the specific harm the original copy caused.
 */
export const VERIFIED_WALLETS_UNAVAILABLE =
  "Couldn't load your wallets just now — this says nothing about which wallets you've saved. Try again shortly."
