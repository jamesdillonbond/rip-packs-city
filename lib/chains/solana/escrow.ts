// lib/chains/solana/escrow.ts
//
// Magic Eden's listing escrow on Solana. When a Candy MLB card (or pack) is
// listed on Magic Eden, the asset moves to this wallet until it sells or is
// delisted, so DAS reports the ESCROW as its owner — not the collector who
// listed it.
//
// ⭐ IDENTIFIED 2026-09-25 ~11:40 PM PT (it had been filed on 09-24 as an
// "inventory-shaped wallet … ownership not proven"): of 1,916 Candy listings
// confirmed active in the last 12 h, 1,788 are on cards this wallet holds, and
// its 1,896 cards ≈ the whole active listing set; 14 of 14 non-treasury listed
// packs sit here too. It never trades because it is not a trader.
//
// 🚨 THE HARM IT CAUSED: the collection walk wrote each listed card to
// wallet_moments_cache under this wallet, and `purge_candy_wmc_ghost_rows`
// keeps ONE row per card — so 1,663 listed cards across up to 157 sellers were
// missing from their owners' portfolios, and a listed card's moment page named
// the escrow as its Owner. Listing a card on Top Shot does not remove it from
// the collector's account on this site; listing one on Candy did.
//
// ⚠ Base58 is case-sensitive — compare verbatim, never lowercase.
export const MAGIC_EDEN_SOLANA_ESCROW = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"

type SupabaseLike = {
  // The real client's builder generics do not fit a narrower structural type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any
}

export type EscrowAttribution<T> = {
  rows: T[]
  /** Escrow-held rows re-attributed to their listing's seller. */
  remapped: number
  /** Escrow-held rows left on the escrow (no active listing found). */
  unmatched: number
  /** Read error, if the listings lookup failed (rows are then returned unchanged). */
  error: string | null
}

/**
 * For every row the chain says the ESCROW owns, attribute it to the seller of
 * the card's active Magic Eden listing (the most recently seen one, if several).
 * A row with no active listing stays on the escrow — nothing is guessed. A
 * failed lookup returns the rows unchanged and says so.
 */
export async function attributeEscrowHeldToSellers<T extends { wallet_address: string; moment_id: string }>(
  supabase: SupabaseLike,
  rows: T[],
  table = "candy_listings",
  chunkSize = 200,
): Promise<EscrowAttribution<T>> {
  const held = [...new Set(rows.filter((r) => r.wallet_address === MAGIC_EDEN_SOLANA_ESCROW).map((r) => r.moment_id))]
  if (held.length === 0) return { rows, remapped: 0, unmatched: 0, error: null }

  const sellerByMint = new Map<string, { seller: string; seen: number }>()
  for (let i = 0; i < held.length; i += chunkSize) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select("token_mint, seller, last_seen_at")
        .in("token_mint", held.slice(i, i + chunkSize))
        .eq("is_active", true)
      if (error) return { rows, remapped: 0, unmatched: held.length, error: error.message ?? String(error) }
      for (const r of (data ?? []) as Array<{ token_mint: string; seller: string | null; last_seen_at: string | null }>) {
        if (!r.seller || r.seller === MAGIC_EDEN_SOLANA_ESCROW) continue
        const seen = r.last_seen_at ? Date.parse(r.last_seen_at) || 0 : 0
        const prior = sellerByMint.get(r.token_mint)
        if (!prior || seen > prior.seen) sellerByMint.set(r.token_mint, { seller: r.seller, seen })
      }
    } catch (e) {
      return { rows, remapped: 0, unmatched: held.length, error: e instanceof Error ? e.message : String(e) }
    }
  }

  let remapped = 0
  let unmatched = 0
  const out = rows.map((r) => {
    if (r.wallet_address !== MAGIC_EDEN_SOLANA_ESCROW) return r
    const s = sellerByMint.get(r.moment_id)
    if (!s) {
      unmatched++
      return r
    }
    remapped++
    return { ...r, wallet_address: s.seller }
  })
  return { rows: out, remapped, unmatched, error: null }
}

/** Hard cap on escrow-listed cards a per-wallet backfill re-reads from DAS. */
export const ESCROW_LISTED_READ_CAP = 200

export type EscrowListedMints = { mints: string[]; error: string | null; capped: boolean }

/**
 * #145: the token mints a wallet currently has LISTED on Magic Eden. While
 * listed, those cards sit in the escrow, so a DAS getAssetsByOwner walk of the
 * SELLER cannot see them — a per-wallet backfill must read them from the
 * listings table and attribute them back to the seller. A failed read returns
 * `error` (never an empty list dressed as "nothing listed").
 */
export async function listedMintsInEscrowForSeller(
  supabase: SupabaseLike,
  seller: string,
  table = "candy_listings",
): Promise<EscrowListedMints> {
  if (!seller || seller === MAGIC_EDEN_SOLANA_ESCROW) return { mints: [], error: null, capped: false }
  try {
    const { data, error } = await supabase
      .from(table)
      .select("token_mint")
      .eq("seller", seller)
      .eq("is_active", true)
      .order("token_mint", { ascending: true })
      .limit(ESCROW_LISTED_READ_CAP + 1)
    if (error) return { mints: [], error: error.message ?? String(error), capped: false }
    const all = [...new Set(((data ?? []) as Array<{ token_mint: string | null }>).map((r) => r.token_mint).filter((m): m is string => !!m))]
    return { mints: all.slice(0, ESCROW_LISTED_READ_CAP), error: null, capped: all.length > ESCROW_LISTED_READ_CAP }
  } catch (e) {
    return { mints: [], error: e instanceof Error ? e.message : String(e), capped: false }
  }
}
