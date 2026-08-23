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
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * Budget for the single-row lookup below.
 *
 * ⚠ Tighter than `BOARD_LIVE_TIMEOUT_MS` (8s) on purpose. This is one indexed
 * row keyed on `(user_id, collection_id)`, not a board aggregate — 8s of waiting
 * buys nothing a collector wants, and both callers have a real branch to show
 * instead. A number chosen to match a board's budget would be borrowed rather
 * than measured.
 */
const PINNED_WALLET_TIMEOUT_MS = 3_000

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
  let data: unknown
  try {
    // ⚠ BOUNDED. A query that is merely SLOW errors nowhere: supabase-js resolves
    // `{ data: null, error: null }` only when it finishes, so under DB saturation
    // this await simply never returns and BOTH pages hang on a streaming shell
    // that Vercel logs as a 200. Rejecting on the budget routes a slow read into
    // the `ok: false` branch this module already has and both callers already
    // render — the same trade `withBoardBudget` documents: we stop WAITING on the
    // query, we do not stop it.
    //
    // ⚠ The bound is deliberately the SAME failure as an error, not a third
    // state. "We could not read your pinned wallet" is the honest thing to say
    // for both, and a distinct `timedOut` flag would only tempt a caller into
    // treating one of them as "no wallet pinned" — which is the exact false claim
    // about the reader's own account this file was created to stop.
    const res = await withBoardBudget<{ data: unknown; error: { message: string } | null }>(
      db
        .from("saved_wallets")
        .select("wallet_addr, pinned_at")
        .eq("user_id", userId)
        .eq("collection_id", collectionId)
        .order("pinned_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      "pinned-wallet",
      PINNED_WALLET_TIMEOUT_MS,
      "wallet/",
    )
    if (res.error) {
      console.log("[pinned-wallet] read error:", res.error.message)
      return { wallet: null, ok: false }
    }
    data = res.data
  } catch (e) {
    console.log("[pinned-wallet] read bound:", e instanceof Error ? e.message : e)
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
