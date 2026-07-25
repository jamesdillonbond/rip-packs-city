// Shared currency / count formatters.
//
// Semantics:
//   null / undefined / NaN  → em-dash ("—")  — data is genuinely missing
//   0                       → "$0"            — real, computed zero
//   positive / negative     → "$X,XXX.XX" / "-$X,XXX.XX" with thousands

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  if (value === 0) return "$0"
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(Number(value)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return sign + "$" + abs
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  return Number(value).toLocaleString("en-US")
}

// ── Enum / slug → display label ─────────────────────────────────────────────
//
// Raw snake_case metadata (pack_type, tier, edition_kind, event_kind …) leaks
// straight into JSX in several places. CSS `text-transform: capitalize` does NOT
// rescue it — underscores are not word boundaries, so `in_season_premium`
// renders as the literal "In_season_premium" (shipped live on the Golazos pack
// pages until 2026-07-25). Humanise in JS instead.
//
// Underscores and whitespace are treated as word separators; hyphens are left
// intact on purpose (they appear inside legitimate names/slugs). Each word is
// Title Cased, so `IN_SEASON_PREMIUM`, `in_season_premium`, and
// `In_Season_Premium` all render "In Season Premium".
// ── Redundant metadata parts in a joined display string ─────────────────────
//
// Several catalogs denormalise the same fact into more than one field, so naively
// joining them repeats it. Live example (Disney Pinnacle pin GEN-DPIN-SIMB-S0):
// `set_name` = "Walt Disney Animation Studios • Disney Genesis " and
// `franchises[0]` = "Walt Disney Animation Studios", which rendered as
// "Walt Disney Animation Studios • Disney Genesis · Walt Disney Animation
// Studios · 2023".
//
// Keeps the first occurrence and drops any later part already represented by a
// kept one — comparison is case-insensitive and punctuation-insensitive, and
// containment (not just equality) counts, because the duplicate is usually a
// prefix inside a longer field. Values are returned trimmed, in input order.
// Parts shorter than 4 normalised chars are only dropped on an exact match, so a
// short token ("S1", "1of1") can't be swallowed by an unrelated longer string.
export function dedupeLabelParts(parts: (string | null | undefined)[]): string[] {
  const kept: string[] = []
  const keptNorm: string[] = []
  for (const raw of parts) {
    const value = (raw ?? "").trim()
    if (!value) continue
    const norm = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    if (!norm) continue
    const redundant = keptNorm.some((k) => k === norm || (norm.length >= 4 && k.includes(norm)))
    if (redundant) continue
    kept.push(value)
    keptNorm.push(norm)
  }
  return kept
}

// ── Metadata-safe field reads ───────────────────────────────────────────────
//
// Trims a raw catalog string and reports a whitespace-only value as ABSENT, so
// data noise can never reach a meta tag. Live example (2026-07-25):
// `pinnacle_catalog.set_name` = "Walt Disney Animation Studios • Disney Genesis "
// (trailing space) rendered the Pinnacle pin meta description as
// "…Disney Genesis , Genesis variant" — the stray space escaped ahead of the
// separator. Description builders fan one string out to `description`,
// `og:description` AND `twitter:description`, so a single untrimmed read lands in
// three tags at once.
//
// Returning null rather than "" is the point: it lets a caller's `?? "…"`
// fallback fire, instead of silently emitting an empty segment.
export function metaField(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Joins metadata parts with `sep`, trimming each and dropping empty/absent ones.
// Dedupes the empty segments a naive template produces: a dangling separator
// when the last field is null (`"Simba · "`), and a double space mid-sentence
// when an interpolated `?? ""` collapses (`"Simba  on NBA Top Shot"`).
export function joinMetaParts(parts: (string | null | undefined)[], sep: string): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(sep)
}

export function humanizeLabel(value: string | null | undefined): string {
  if (value === null || value === undefined) return ""
  const words = String(value).trim().split(/[\s_]+/).filter(Boolean)
  if (words.length === 0) return ""
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")
}
