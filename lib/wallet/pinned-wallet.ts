// lib/wallet/pinned-wallet.ts
//
// "Which Top Shot wallet has this signed-in user pinned?" — the read behind the
// connect-wallet gate on /fast-break and /road-to-the-ring.
//
// ⚠ WHY IT IS SHARED. The identical eight-line query was copy-pasted into both
// pages, carrying the identical defect into both: neither destructured `error`,
// so a failed read left `walletRow` undefined and the page rendered
// ConnectWalletCard — telling a collector who HAS pinned a wallet to go connect
// one. That is a claim about the reader's own account manufactured from our
// outage, and it is the third surface in one sweep to make it (/my-teams told
// the same collector they follow no teams). This repo has already paid for the
// copy-paste version of a defect twice over: 15 OG cards and 5 sales indexers.
//
// ⚠ NOT merged with `lib/fan-teams/fetchers.ts::fetchBoundWallet`, deliberately.
// That one filters on `verified_at IS NOT NULL` and spans collections; this one
// filters on a specific `collection_id` and does not require verification. They
// answer different questions and the game surfaces would silently start gating
// on verification if they were unified.

import { supabaseAdmin } from "@/lib/supabase"

/** A Flow address is exactly 16 hex digits. */
const FLOW_ADDR_RE = /^0x[a-f0-9]{16}$/i

export interface PinnedWallet {
  wallet: string | null
  /**
   * ⚠ false ONLY when the read failed. A user who has genuinely pinned no
   * wallet is `{ wallet: null, ok: true }` — the connect-wallet card is the
   * right thing to show THEM, and suppressing it would leave them stuck.
   */
  ok: boolean
}

/**
 * The user's most-recently-pinned wallet for one collection.
 *
 * ⚠ A malformed stored address resolves to `{ wallet: null, ok: true }`, not to
 * a failure: we asked and got an answer, the answer just is not usable. Passing
 * it through would thread a non-address into a Cadence/RPC call downstream.
 */
export async function fetchPinnedWallet(
  userId: string,
  collectionId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<PinnedWallet> {
  const { data, error } = await db
    .from("saved_wallets")
    .select("wallet_addr, pinned_at")
    .eq("user_id", userId)
    .eq("collection_id", collectionId)
    .order("pinned_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.log("[pinned-wallet] read error:", error.message)
    return { wallet: null, ok: false }
  }
  const candidate = (data as { wallet_addr?: unknown } | null)?.wallet_addr ?? null
  return {
    wallet: typeof candidate === "string" && FLOW_ADDR_RE.test(candidate)
      ? candidate.toLowerCase()
      : null,
    ok: true,
  }
}
