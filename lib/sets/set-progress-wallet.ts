// The wallet gate every Flow set-progress route shares (2026-11-14).
//
// Two defects, found first on /api/sets-db and then on its siblings (All Day,
// UFC, Pinnacle): the Sets tab passes ?wallet= through VERBATIM — it may be a
// Dapper/Top Shot USERNAME or an un-prefixed hex address — and the RPCs match
// `wallet_address = lower(p_wallet)`. Zero rows, so every set read "0%" for a
// collector who may own most of them. And a valid address RPC never walked
// also has zero rows: "0% of every set" is then a claim nothing measured.
//
// Flow only. A Solana (Candy) key is not a Flow address and has no username
// path; /api/candy-set-progress keeps its own verbatim handling.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { normalizeFlowAddress } from "@/lib/address"
import { walletIndexState } from "@/lib/wallet-indexed"
import { resolveTopShotUsernameCacheAware } from "@/lib/chains/flow/topshot-username-resolve"

export type SetProgressWallet = { ok: true; wallet: string } | { ok: false; response: NextResponse }

export const WALLET_NOT_FOUND_COPY = "We couldn't find a Flow wallet for that username. Try the 0x address."
export const WALLET_NOT_INDEXED_COPY =
  "This wallet hasn't been scanned yet. Open it on the Collection tab to start a scan, then come back."

/**
 * An address (0x-prefixed or not, any case) → its canonical 0x form; anything
 * else is looked up as a username. An unknown username is a 404, never a 0%; a
 * failed LOOKUP throws, so the caller's catch reports it as a failure.
 */
export async function resolveSetProgressWallet(input: string): Promise<SetProgressWallet> {
  const direct = normalizeFlowAddress(input)
  if (direct) return { ok: true, wallet: direct }
  const r = await resolveTopShotUsernameCacheAware(supabaseAdmin as never, input)
  if (!r.found) {
    if (r.reason === "topshot_gql_error") throw new Error(`username lookup failed: ${r.detail ?? ""}`)
    return {
      ok: false,
      response: NextResponse.json({ error: WALLET_NOT_FOUND_COPY, code: "wallet_not_found" }, { status: 404 }),
    }
  }
  const wallet = normalizeFlowAddress(r.walletAddress)
  if (!wallet) throw new Error("username resolved to a non-Flow address")
  return { ok: true, wallet }
}

/**
 * Call when the wallet owns NOTHING in the collection. Returns a 409
 * `wallet_not_indexed` response when RPC never walked the wallet, or null when
 * it did (an indexed wallet holding none of the collection: 0% is then true).
 * A failed check THROWS — "not indexed" is a claim too.
 */
export async function notScannedResponse(wallet: string): Promise<NextResponse | null> {
  const idx = await walletIndexState(supabaseAdmin, wallet)
  if (!idx.ok) throw idx.error instanceof Error ? idx.error : new Error("wallet index check failed")
  if (idx.indexed) return null
  return NextResponse.json(
    { error: WALLET_NOT_INDEXED_COPY, code: "wallet_not_indexed", retryable: false },
    { status: 409 },
  )
}

/**
 * The Candy (Solana) form of {@link notScannedResponse}. `walletIndexState` is
 * Flow-only, so a base58 key is judged here, VERBATIM (case-sensitive): the
 * caller already knows the wallet holds no Candy rows, so the only evidence of a
 * walk is the wmc_clean_walks stamp a complete Candy walk leaves (written since
 * 2026-11-14 by lib/candy/refresh-wallet.ts). A failed read THROWS.
 */
export async function notScannedCandyResponse(wallet: string, candyCollectionId: string): Promise<NextResponse | null> {
  const { data, error } = await (supabaseAdmin as any)
    .from("wmc_clean_walks")
    .select("wallet_address")
    .eq("wallet_address", wallet)
    .eq("collection_id", candyCollectionId)
    .limit(1)
  if (error) throw new Error(`wmc_clean_walks read failed: ${error.message ?? String(error)}`)
  if (!Array.isArray(data)) throw new Error("wmc_clean_walks: no rows array")
  if (data.length > 0) return null
  return NextResponse.json(
    { error: WALLET_NOT_INDEXED_COPY, code: "wallet_not_indexed", retryable: false },
    { status: 409 },
  )
}
