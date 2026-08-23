// lib/analytics/wallet-directory.ts
//
// The single read behind /analytics/wallets — the Flowty wallet directory.
//
// WHY IT MOVED OUT OF page.tsx. The `ok` contract below already existed and the
// page already branches on it: it used to return a bare `[]`, which rendered as
// "No wallet activity to display." — a positive claim about the loan book,
// manufactured from a database error.
//
// ⚠ THAT BRANCH WAS UNREACHABLE FROM THE FAILURE THAT ACTUALLY HAPPENS. The
// `try/catch` here catches a THROW; a read that merely HANGS throws nothing,
// because supabase-js resolves `{ data, error }` only when the query finishes.
// So the page waited on a streaming shell that Vercel logs as a 200. Same
// mechanism recorded for /[collection]/hot-floors and /[collection]/challenges.
//
// ⚠ And `app/**/page.tsx` is measured by NEITHER coverage gate, so nothing
// pinned the honest-vs-empty distinction. Extracting is what makes it testable.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import type { WalletDirectoryRow } from "@/lib/analytics-types"

/**
 * ⚠ The directory is an aggregate over the whole historical loan book, not a
 * keyed lookup, so it gets a board-sized budget rather than the 3s a single
 * indexed row gets. The page is `revalidate = 600`, so a cold entry performs it
 * inline and the reader waits on it.
 */
export const WALLET_DIRECTORY_TIMEOUT_MS = 8_000

/** `ok` answers *did the READ succeed*, never *were there wallets*. */
export interface WalletDirectoryResult {
  rows: WalletDirectoryRow[]
  ok: boolean
}

export async function loadWalletDirectory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = WALLET_DIRECTORY_TIMEOUT_MS,
): Promise<WalletDirectoryResult> {
  try {
    const { data, error } = await withBoardBudget<{
      data: unknown
      error: { message: string } | null
    }>(
      db.rpc("flowty_analytics_wallet_directory"),
      "wallet-directory",
      timeoutMs,
      "analytics/",
    )
    if (error) {
      console.log("[wallets/index] rpc_error", error.message)
      return { rows: [], ok: false }
    }
    // ⚠ A non-array payload is a SHAPE CHANGE, not an empty directory. The old
    // `(data ?? [])` would have rendered "No wallet activity to display." from a
    // payload we did not understand — the same family as `?? 0` on a count.
    if (data != null && !Array.isArray(data)) {
      console.log("[wallets/index] unexpected payload shape")
      return { rows: [], ok: false }
    }
    return {
      rows: ((data ?? []) as WalletDirectoryRow[]).map((r) => ({
        ...r,
        // ⚠ `|| 0` here is a PARSE fallback on a value the read returned, not a
        // divide-guard or a count default: the row exists and its principal is
        // non-numeric or absent. That is a different thing from manufacturing a
        // measurement, and the `ok` flag above still carries the read's outcome.
        borrower_principal_usd: Number(r.borrower_principal_usd) || 0,
        lender_principal_usd: Number(r.lender_principal_usd) || 0,
      })),
      ok: true,
    }
  } catch (e) {
    console.log("[wallets/index] error", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}
