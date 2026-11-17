// lib/wallet-indexed.ts
//
// "Has RPC EVER walked this wallet?" — the discriminator between a wallet that
// holds nothing and a wallet we never looked at (known-issues #237, 2026-11-08).
//
// The estate's counts conflate the two: get_wallet_intel_summary counts
// wallet_moments_cache rows, so a never-indexed wallet answers a COMPLETE
// OBJECT OF ZEROS that reads exactly like an indexed empty one. Three states,
// never two: unknown (never walked) · indexed-empty · indexed-with-rows.
//
// Evidence, from the writers' own records, any one of which is enough:
//   1. a wallet_moments_cache row in ANY collection (a walk wrote it), or
//   2. a wmc_clean_walks row — the record a COMPLETE walk leaves, which also
//      exists for a wallet whose walk found nothing.
// Not used: seeded_wallets.last_refreshed_per_collection ("we checked", written
// even on skipped / timed-out runs — see lib/chains/flow/wallet-backfill-helpers.ts).
//
// A failed read is `ok:false` — never "not indexed", which is itself a claim.
// So is an address this helper cannot judge (not a Flow address).

import { normalizeFlowAddress } from "@/lib/address"

export type WalletIndexState = { ok: true; indexed: boolean } | { ok: false; error: unknown }

type RowsResult = { data: unknown; error: unknown }

/** Flow wallets only; `client` must be able to read both tables (service role). */
export async function walletIndexState(client: any, wallet: string): Promise<WalletIndexState> {
  const addr = normalizeFlowAddress(wallet)
  // Not a Flow address (a Candy Solana key, a username): this helper cannot
  // tell, so it says it does not know — never "not indexed".
  if (!addr) return { ok: false, error: new Error("not a Flow address") }

  // An EXISTENCE read (one row), not a count: a whale's cache holds 100k+ rows.
  const any = async (table: string): Promise<{ ok: true; found: boolean } | { ok: false; error: unknown }> => {
    const r = (await client.from(table).select("wallet_address").eq("wallet_address", addr).limit(1)) as RowsResult
    if (r.error) return { ok: false, error: r.error }
    if (!Array.isArray(r.data)) return { ok: false, error: new Error(`${table}: no rows array`) }
    return { ok: true, found: r.data.length > 0 }
  }

  try {
    const cache = await any("wallet_moments_cache")
    if (!cache.ok) return cache
    if (cache.found) return { ok: true, indexed: true }

    const walks = await any("wmc_clean_walks")
    if (!walks.ok) return walks
    return { ok: true, indexed: walks.found }
  } catch (e) {
    return { ok: false, error: e }
  }
}
