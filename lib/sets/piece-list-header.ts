// A set's OWNED / MISSING list header (2026-11-14).
//
// The list-level row of a set carries a PREVIEW (Top Shot / All Day: the RPC's
// top-5 `missingPreview`), and the card or modal falls back to it when the
// per-set detail read fails. The header counted the array it was given, so a
// set missing 40 plays read "MISSING (5)" — the preview's length stated as the
// set's total. The header now states the TOTAL the server counted and says how
// many are listed when that is fewer.

export function pieceListHeader(label: "OWNED" | "MISSING", listed: number, total: number | null | undefined): string {
  const n = typeof total === "number" && Number.isFinite(total) && total >= listed ? total : listed
  return n > listed ? `${label} (${n} · SHOWING ${listed})` : `${label} (${listed})`
}

/** The copy shown above a preview the detail read could not replace. */
export const SET_DETAIL_PREVIEW_COPY =
  "Couldn't load this set's full list just now — showing a preview. Close and reopen to try again."
