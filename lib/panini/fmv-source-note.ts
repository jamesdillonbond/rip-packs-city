// lib/panini/fmv-source-note.ts
//
// The one sentence every Panini FMV surface carries about WHERE its prices
// come from (2026-11-09, signup-wave remediation P1: "add an on-platform sales
// only disclosure").
//
// Why it is needed: a Panini FMV is computed only from sales recorded on
// Panini's own platform. Measured 11-09, `panini_sales` holds four sale kinds,
// every one of them Panini's (Marketplace 578k, Auction 115k, Gallery 75k,
// Crypto 63k, all `source = nft_sales_data`, plus serial last-sale rows read
// from the same marketplace). A collector who watches prices elsewhere would
// otherwise read our number as a market-wide price, which it is not.
//
// The ~4-day lag clause is the same fact the concierge already states on every
// Panini answer (docs/strategy/collections/panini.md: sales reach RPC days
// after `sold_at`, p50 ~98 h on the 10-03..10-10 sample).
//
// ⛔ Do not add a confidence tier here: FMV confidence is internal (CLAUDE.md,
// concierge rule 3).
//
// One constant so the surfaces cannot drift apart; pinned in
// __tests__/panini-fmv-source-note.test.ts.

export const PANINI_FMV_SOURCE_NOTE =
  "Panini FMV comes only from sales on Panini's own platform (marketplace, auction, gallery and crypto sales). Trades made anywhere else aren't counted, and a new sale can take a few days to reach RPC."
