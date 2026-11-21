// scripts/lib/aptos-marketplace-fns.mjs — positive control for scripts/ufc-aptos-sales-ingest.mjs (2026-11-20).
//
// The UFC Aptos sales lane filters the Aptos indexer on a FIXED list of marketplace purchase entry
// functions (BUY_FNS). If a marketplace ships a new purchase function (markets_v3::buy…, a renamed
// accept-bid…), the lane keeps reporting ok with 0 sales — the same reading a quiet market gives.
// Measured 2026-11-20: every run since 11-17 saw `buys: 0` across ALL collections (not just UFC) over
// 3–7M versions per run, and nothing could tell a quiet market from a stale list.
//
// unknownPurchaseFns(seen, known) returns the entry functions the marketplaces were actually called
// through in the scanned range that look like a purchase (buy / accept / fill / purchase / sweep /
// take) and are NOT in the known list. Listing, unlisting, cancelling and bidding are not purchases.

const PURCHASE = /(^|_)(buy|accept|fill|purchase|sweep|take)/i

/** @param {string[]} seen entry_function_id_str values observed  @param {string[]} known the lane's BUY_FNS */
export function unknownPurchaseFns(seen, known) {
  const knownSet = new Set(known.map((f) => f.toLowerCase()))
  const out = new Set()
  for (const fn of seen) {
    if (!fn || knownSet.has(fn.toLowerCase())) continue
    // By the function NAME's verbs: "unlist_and_accept_collection_bid" is a purchase (accept) though it
    // starts with unlist; "place_bid" / "list_token" / "cancel_listing" carry no purchase verb.
    const name = fn.split("::").pop() ?? ""
    if (PURCHASE.test(name)) out.add(fn)
  }
  return [...out].sort()
}
