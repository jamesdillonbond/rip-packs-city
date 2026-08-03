// lib/pinnacle/serialisation.ts
//
// Which Disney Pinnacle edition types are serialised.
//
// THE PROBLEM THIS SOLVES
//   72% of Pinnacle rows in wallet_moments_cache have a NULL serial_number, and
//   the wallet table rendered every one of them as a bare em-dash in BOTH the
//   "Serial" and "Serial est." columns. That reads as missing data -- as though we
//   failed to index something -- when it is nothing of the kind: most Pinnacle
//   editions are simply not serialised at all. Rendering a gap where there is no
//   gap is the same class of dishonesty as rendering a price where there is no
//   market: it invites the reader to draw a false conclusion.
//
// MEASURED LIVE 2026-08-02 (pinnacle_editions x wallet_moments_cache)
//   Serialised edition types -- every edition of these types is 100% serialised,
//   with ZERO null serials across 14,077 wallet rows:
//     Limited Edition          55 editions with holdings, 11,911 rows, 0 null
//     Limited Event Edition    20 editions with holdings,  1,999 rows, 0 null
//     Legendary Edition         4 editions with holdings,    166 rows, 0 null
//     Genesis Edition           1 edition  with holdings,      1 row,  0 null
//   Never-serialised edition types -- ZERO serials across 36,678 wallet rows:
//     Open Edition            345 editions, 32,363 rows, all null
//     Open Event Edition       48 editions,  2,280 rows, all null
//     Starter Edition          34 editions,  2,035 rows, all null
//   NOT ONE edition is mixed. Serialisation is a property of the edition TYPE,
//   which is exactly why a type-keyed predicate is correct and a per-row
//   "is the serial null?" check is not -- the latter cannot tell "not serialised"
//   apart from "we failed to index the serial".
//
// DO NOT USE pinnacle_editions.is_serialized FOR THIS.
//   It is wrong. Measured the same day: 188 "Open Edition" rows and 32
//   "Open Event Edition" rows carry is_serialized = true while holding 22,597
//   wallet rows with a null serial between them. It is written from the on-chain
//   `edition.isLimited` flag by the metadata backfill and does not mean what its
//   name suggests. edition_type is the reliable predicate.

/** Pinnacle edition types that carry a serial number on every mint. */
export const SERIALISED_PINNACLE_EDITION_TYPES: ReadonlySet<string> = new Set([
  "Limited Edition",
  "Limited Event Edition",
  "Legendary Edition",
  "Genesis Edition",
])

/**
 * Edition types we have positively confirmed carry no serials. Kept explicit
 * rather than treating "not in the serialised set" as unserialised, so a brand
 * new edition type upstream lands in the "cannot say" branch above instead of
 * being silently labelled unserialised.
 */
export const KNOWN_UNSERIALISED_PINNACLE_EDITION_TYPES: ReadonlySet<string> = new Set([
  "Open Edition",
  "Open Event Edition",
  "Starter Edition",
])

/**
 * Is this Pinnacle edition type serialised?
 *
 * Returns null when the edition type is unknown to us (absent, or a value that
 * has not been seen before). Null means "we cannot say", and callers MUST fall
 * back to the old neutral rendering rather than asserting "not serialised" --
 * claiming an edition has no serials when a new type has appeared upstream would
 * be a fresh false statement, which is the thing this module exists to prevent.
 */
export function isSerialisedEditionType(editionType: string | null | undefined): boolean | null {
  if (editionType == null) return null
  const t = editionType.trim()
  if (!t) return null
  if (SERIALISED_PINNACLE_EDITION_TYPES.has(t)) return true
  if (KNOWN_UNSERIALISED_PINNACLE_EDITION_TYPES.has(t)) return false
  return null
}
