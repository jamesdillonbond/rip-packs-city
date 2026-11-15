// lib/wallet/mark-verified.ts
//
// 2026-11-15: ONE verified flag. A Flow account proof (Trade Block wallet proof,
// signed trade-room side) proves the SOURCE account just as the listing challenge
// does, but until now it lived only in trade_block_wallets / trade_room_sides — so
// the wallet card still said "Verify", the public profile's ✓ VERIFIED never
// counted it, and the ownership rule (lib/wallet/wallet-owner.ts) did not see it.
// This stamps the collector's own saved_wallets rows for that account.
//
// Rules:
// - Only THIS user's rows, only rows not already verified (an earlier method wins
//   its record). A collector who never saved the account gets nothing written —
//   a proof is not a request to save a wallet.
// - NEVER THROWS and never fails the proof that called it: the outcome is returned
//   so the caller can log it. A failed write is `ok: false`, not "0 rows".

export type MarkVerifiedOutcome = { ok: true; updated: number } | { ok: false; error: string }

// saved_wallets_verification_method_check allows fcl_dapper | fcl_blocto | fcl_other |
// listing_challenge | owner_attested | wallet_signature. A Trade Block / trade-room proof
// is an FCL account proof from a NON-Dapper wallet (Flow Wallet), i.e. `fcl_other`.
// ⚠ Any other value violates the CHECK and the whole update fails (measured 11-15).
export const FLOW_ACCOUNT_PROOF = "fcl_other"

export async function markSavedWalletVerified(
  db: { from: (t: string) => any },
  userId: string,
  walletAddress: string,
  method: string = FLOW_ACCOUNT_PROOF,
): Promise<MarkVerifiedOutcome> {
  const addr = (walletAddress ?? "").trim().toLowerCase()
  if (!/^0x[0-9a-f]{16}$/.test(addr)) return { ok: false, error: "not a Flow address" }
  try {
    const { data, error } = await db
      .from("saved_wallets")
      .update({ verified_at: new Date().toISOString(), verification_method: method })
      .eq("user_id", userId)
      .in("wallet_addr", [addr, addr.slice(2)])
      .is("verified_at", null)
      .select("id")
    if (error) return { ok: false, error: String(error.message ?? error) }
    return { ok: true, updated: Array.isArray(data) ? data.length : 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
