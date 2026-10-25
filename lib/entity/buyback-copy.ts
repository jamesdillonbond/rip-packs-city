// lib/entity/buyback-copy.ts
//
// The hover text on a sale bought by a collection's buyback wallet (2026-10-25).
// sales_market — every 30-day count, last-sale age and FMV input — excludes those
// purchases, so a sales table that lists them tags the row with this reason.
// A plain module: the edition table is a client component and the moment page a
// server one, and a server module must never read a value from a "use client" file
// (__tests__/server-never-reads-a-value-from-a-client-module.test.ts).

export const BUYBACK_TITLE =
  "Bought by the collection's buyback program. Not counted in 30-day sales, last-sale age or FMV."
