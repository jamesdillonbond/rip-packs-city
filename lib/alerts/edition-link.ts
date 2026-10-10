// Alerts-page display helpers — extracted verbatim from app/alerts/page.tsx so
// the alert-type label map and the edition-link builder are exercised by the
// primary coverage gate (which measures lib/** but NOT the app/** page layer).
// All pure. This is display-side only; the server-side alert DELIVERY digest
// formatting lives separately in lib/alerts/format.ts.

export type FmvAlertType = "price_below" | "fmv_below" | "fmv_above" | "discount_above"

// Threshold-aware label for each FMV/price alert type.
export const FMV_ALERT_LABEL: Record<FmvAlertType, (t: number) => string> = {
  price_below: (t) => `Ask ≤ $${t}`,
  fmv_below: (t) => `FMV ≤ $${t}`,
  fmv_above: (t) => `FMV ≥ $${t}`,
  discount_above: (t) => `Ask ≥ ${t}% below FMV`,
}

// collection UUID -> entity-page URL slug (the editions+fmv_snapshots
// collections the watch button is offered on). An ABSENT collection keeps the
// nba-top-shot default (/api/alerts stores Top Shot when none is sent). An
// UNMAPPED one gets NO link: until 2026-10-09 it fell back to nba-top-shot, so
// "View" opened the Top Shot edition that happened to share the key —
// substitution, a different subject under the alert's own name.
export const COLLECTION_URL_SLUG: Record<string, string> = {
  "95f28a17-224a-4025-96ad-adf8a4c63bfd": "nba-top-shot",
  "dee28451-5d62-409e-a1ad-a83f763ac070": "nfl-all-day",
  "06248cc4-b85f-47cd-af67-1855d14acd75": "laliga-golazos",
  // Canonical "ufc" (the app nav + sitemap + fromDbSlug slug), NOT the
  // "ufc-strike" alias — an alert link must resolve to the same canonical
  // edition URL the crawler indexes, not a duplicate.
  "9b4824a8-736d-4a96-b450-8dcc0c46b023": "ufc",
  // Candy MLB editions render on the shared /[collection]/edition page (the
  // same href app/api/candy-set-progress builds via lib/entity-href).
  "209ade70-32c5-4470-bc7c-4793d660f713": "candy-mlb",
}

export function editionHref(a: { collection_id: string | null; edition_key: string }): string | null {
  const slug =
    a.collection_id == null || a.collection_id === ""
      ? "nba-top-shot"
      : Object.prototype.hasOwnProperty.call(COLLECTION_URL_SLUG, a.collection_id.toLowerCase())
        ? COLLECTION_URL_SLUG[a.collection_id.toLowerCase()]
        : null
  return slug ? `/${slug}/edition/${encodeURIComponent(a.edition_key)}` : null
}
