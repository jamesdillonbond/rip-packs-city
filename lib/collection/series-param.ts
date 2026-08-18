// Series display-label → server `series` query param resolver. Extracted from
// app/(collections)/[collection]/collection/page.tsx, where this exact block
// was DUPLICATED verbatim in two request builders (fetchPaginatedMoments +
// autoPaginate) — a drift hazard. One tested implementation removes it.
//
// Resolution order (byte-identical to the inline copies): first the dynamic
// per-collection options (label → seriesNumber), then a Top Shot hardcoded
// label→number fallback, else null (caller leaves the param unset).

import { ownLookup } from "@/lib/safe-lookup"

// ⚠ TOP SHOT HAS TWO LIVE LABEL CONVENTIONS FOR THE SAME on-chain series, and
// this fallback has to speak BOTH — otherwise it rescues nothing in exactly the
// case it exists for.
//
// Measured 2026-08-18 against the live DB:
//
//   on-chain | collection_series.display_label | repo constants
//        0-5 | Series 1..4 / Summer 2021       | same  (they AGREE)
//          6 | "Series 5"                      | "Series 2023-24"
//          7 | "Series 6"                      | "Series 2024-25"
//          8 | "Series 7"                      | "Series 2025-26"
//
// The Collection tab's filter is built from the DB labels (via
// /api/collection-series), while analytics/SEO/pack surfaces render the repo
// constants — so a persisted filter value can arrive here in EITHER spelling.
//
// ⚠ WHY THIS WAS A LIVE BUG, not a tidiness point. CollectionTabClient's options
// fetch swallows a failure (`r.ok ? r.json() : null`, `.catch(() => {})`), so on
// a failed read the dynamic options are EMPTY and every label falls through to
// this map. Before 2026-08-18 the three DB spellings were absent, so "Series 5"
// resolved to null, the caller left `series` unset, and the user got the FULL
// catalogue back while the UI still showed "Series 5" selected — a filter that
// silently did nothing. The three missing keys were precisely the three newest
// (and most-trafficked) series.
//
// ⚠ The two conventions are DISJOINT on the entries where they differ and
// IDENTICAL on the entries where they agree, so one flat map is unambiguous:
// "Series 5" can only mean on-chain 6. Verified against the live table — do not
// add a key without re-checking that, and do not "simplify" this back to one
// convention until the product decides which label wins (filed:
// docs/overnight/inbox/2026-08-18T0045Z-top-shot-series-6-7-8-have-two-different-display-labels-and-both-are-user-visible.md).
//
// ⚠ This map is TOP-SHOT-ONLY, as its name says. The 0↔1 series collision is
// Top-Shot-specific and a collection-blind remap silently dropped 385,734 rows
// on 2026-08-05. Nothing here may be applied to another collection.
const TOPSHOT_SERIES_LABEL_TO_NUM: Record<string, string> = {
  // Both conventions agree on these.
  "Series 1": "0",
  "Series 2": "2",
  "Summer 2021": "3",
  "Series 3": "4",
  "Series 4": "5",
  // Repo-constant spelling (analytics / SEO / pack surfaces).
  "Series 2023-24": "6",
  "Series 2024-25": "7",
  "Series 2025-26": "8",
  // collection_series.display_label spelling (the Collection tab's own filter).
  "Series 5": "6",
  "Series 6": "7",
  "Series 7": "8",
}

export function resolveSeriesParam(
  label: string,
  options: Array<{ label: string; seriesNumber: number }>
): string | null {
  const match = options.find((s) => s.label === label)
  if (match) return String(match.seriesNumber)
  // ownLookup: `label` is externally controlled (a filter value seeded from
  // localStorage / URL), so a crafted key like "toString" must NOT resolve an
  // Object.prototype member and defeat the `?? null` — that would stamp a
  // stringified function into the `series` query param.
  return ownLookup(TOPSHOT_SERIES_LABEL_TO_NUM, label) ?? null
}
