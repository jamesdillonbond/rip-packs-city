// Shared pure formatters for the collection analytics page
// (app/(collections)/[collection]/analytics/page.tsx) and its extracted card
// components. Behavior-identical verbatim move — no logic changes.

import { toDbSlug, fromDbSlug, getCollection } from "@/lib/collections"

export function relativeDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diff = Date.now() - t
  const d = Math.floor(diff / 86400000)
  if (d < 1) {
    const h = Math.floor(diff / 3600000)
    if (h < 1) return "just now"
    return `${h}h ago`
  }
  if (d < 30) return `${d}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

export function fmtUsd(n: number): string {
  return `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmt(n: number): string {
  // Thresholds test the MAGNITUDE, and the sign is re-attached — otherwise a
  // negative value skipped the M/k abbreviation entirely (a losing wallet's
  // total P&L rendered "$-1500.00" instead of "-$1.5k"; see CostBasisCard).
  const a = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}k`
  return `${sign}$${a.toFixed(2)}`
}

export function shortAddr(addr: string): string {
  if (!addr) return "—"
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// Percentage change from `prev` to `curr`, rounded to one decimal. Null-safe and
// zero/negative-safe: a nullish/non-finite input, or a non-positive baseline (a
// %-change off 0 is undefined and would render a misleading ∞/huge number),
// yields null so the caller shows "—" instead of a fabricated delta.
// (Verbatim move out of components/analytics/PulseDashboard.tsx.)
export function deltaPct(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null || !Number.isFinite(curr) || !Number.isFinite(prev)) return null
  if (prev <= 0) return null
  return Math.round(((curr - prev) / prev) * 1000) / 10
}

// Earliest / latest of a set of ISO-8601 timestamps, ignoring nullish entries.
// ISO-8601 sorts correctly lexicographically, so a plain string sort is safe.
// Returns null when no valid timestamp is present.
// (Verbatim move out of components/analytics/WalletProfile.tsx.)
export function pickEarliest(...isos: Array<string | null | undefined>): string | null {
  const valid = isos.filter((x): x is string => Boolean(x)).sort()
  return valid[0] ?? null
}

export function pickLatest(...isos: Array<string | null | undefined>): string | null {
  const valid = isos.filter((x): x is string => Boolean(x)).sort()
  return valid[valid.length - 1] ?? null
}

/**
 * The EXPLICIT arms: a URL hyphen-slug ("nba-top-shot") whose analytics key is a
 * SHORT form ("topshot") rather than its DB slug.
 *
 * ⚠ This map is the mirror of the `CASE c.slug WHEN 'nba_top_shot' THEN 'topshot'
 * … END` that every analytics_* RPC normalizes with — NOT an allowlist of the
 * collections that have analytics. Read `shortSlug` below for why that
 * distinction is the whole point.
 */
export const URL_TO_SHORT_SLUG: Record<string, string> = {
  "nba-top-shot": "topshot",
  "nfl-all-day": "allday",
  "laliga-golazos": "golazos",
  "disney-pinnacle": "pinnacle",
  "ufc": "ufc",
}

// Own-property guard for the string-keyed lookup maps below: a bare `MAP[key]`
// read matches inherited Object.prototype members, so a key like "toString" /
// "constructor" would return a prototype member (a truthy function) instead of
// hitting the `?? fallback`. Keys here come from DB/analytics rows, so guard.
function ownValue<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/**
 * URL hyphen-slug → the collection key the `analytics_*` RPCs actually emit and
 * filter on.
 *
 * ⭐ 2026-09-20 — THIS IS NOW A DERIVATION, NOT A LOOKUP, and the change is the
 * fix rather than a tidy-up. Every analytics_* RPC normalizes with the same
 * shape:
 *
 *     CASE c.slug WHEN 'nba_top_shot' THEN 'topshot' … ELSE c.slug END
 *
 * so a collection WITHOUT a CASE arm is keyed by its DB slug — it is not
 * dropped. The three lines below are that CASE, arm for arm:
 *   1. URL_TO_SHORT_SLUG  = the explicit WHEN arms
 *   2. toDbSlug()         = `ELSE c.slug`
 *   3. `?? urlSlug`       = a slug in no registry at all (never reached from a
 *                           rendered route, which resolves through the registry)
 *
 * 🚨 WHY IT HAD TO CHANGE. The old body was `ownValue(map) ?? urlSlug` — a
 * five-entry hardcoded allowlist sitting beside lib/collections, the exact shape
 * CLAUDE.md bans. Candy MLB went live 2026-09-06 and is absent from the map, so
 * `shortSlug("candy-mlb")` returned the HYPHEN slug "candy-mlb", while the RPCs
 * emit and filter on the UNDERSCORE slug "candy_mlb". Nothing 500s: every card
 * on the collection analytics tab would have queried a key matching zero rows
 * and rendered its EMPTY state — "No live listings.", an empty liquidity grid,
 * an empty whale board — about a collection carrying ~1,900 live asks, 125
 * priced editions and 1,564 sales in 30 days. It was latent only because Candy
 * had no `analytics` page; enabling the tab is what would have fired it.
 *
 * ⭐ Deriving arm 2 means the next collection added to the registry is keyed
 * correctly with NO edit here — the map can no longer go stale by omission, only
 * by a genuinely wrong explicit arm, which is what the guard test asserts.
 */
export function shortSlug(urlSlug: string): string {
  return ownValue(URL_TO_SHORT_SLUG, urlSlug) ?? toDbSlug(urlSlug) ?? urlSlug
}

/**
 * The five analytics keys whose display string PREDATES the registry and does
 * not match either `label` or `shortLabel` on it. Kept verbatim so this helper
 * cannot silently reword existing UI: the registry would render "NBA Top Shot"
 * and "Strike" where every analytics surface has always said "Top Shot" and
 * "UFC".
 */
const ANALYTICS_COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
}

/** Analytics collection key → the URL slug, for the keys that have an arm. */
const ANALYTICS_KEY_TO_URL_SLUG: Record<string, string> = {
  topshot: "nba-top-shot",
  allday: "nfl-all-day",
  golazos: "laliga-golazos",
  pinnacle: "disney-pinnacle",
  ufc: "ufc",
}

/**
 * Display label for a collection key as the `analytics_*` RPCs emit it.
 *
 * 🚨 WHY THIS EXISTS. Six analytics modules each carried their OWN five-entry
 * `COLLECTION_LABEL` map, every one of them falling back to the RAW KEY —
 * `BiggestSales`, `RecentWhaleTrades`, the pulse / listings / sets / fmv compute
 * libs. That is the allowlist-beside-a-registry shape CLAUDE.md bans, copied
 * six times, and the failure is silent and user-visible: a collection with no
 * entry renders the literal string `candy_mlb` in a public table.
 *
 * ⭐ The fallback is DERIVED, so it cannot go stale by omission. The RPCs key a
 * collection with no CASE arm by its DB slug (`… ELSE c.slug`), so `fromDbSlug`
 * resolves it and the registry supplies the name — `candy_mlb` → `candy-mlb` →
 * "Candy MLB", with no edit here, and the same for the next collection added.
 * Only the five legacy spellings above are hand-held, and only because changing
 * them would reword shipped UI.
 *
 * Returns the key unchanged when nothing resolves, so an unknown key degrades to
 * itself rather than to a wrong name.
 */
export function collectionLabel(key: string | null | undefined): string {
  const raw = key ?? ""
  const k = raw.toLowerCase()
  const legacy = ownValue(ANALYTICS_COLLECTION_LABEL, k)
  if (legacy) return legacy
  const urlSlug = ownValue(ANALYTICS_KEY_TO_URL_SLUG, k) ?? fromDbSlug(k) ?? k
  return getCollection(urlSlug)?.label ?? raw
}

/** Display label per marketplace key; unknown key → capitalized key. */
export const MARKETPLACE_LABEL: Record<string, string> = {
  topshot: "TopShot Native",
  allday: "AllDay Native",
  golazos: "Golazos Native",
  pinnacle: "Pinnacle Native",
  flowty: "Flowty",
  // ⚠ Candy MLB's ONLY marketplace, and the value `sales.marketplace` actually
  // carries is the UNDERSCORED one — verified against the live payload
  // (`"marketplace":"magic_eden"`). Without this the generic fallback
  // capitalizes it to "Magic_eden" on every Candy row.
  magic_eden: "Magic Eden",
  // ⚠ The keys `sales.marketplace` ACTUALLY carries for All Day and Golazos are
  // the un-underscored `nflallday` (12,344 rows / 30d on 2026-09-25) and
  // `laligagolazos` (61) — the analytics daily rows pass them through verbatim,
  // and the fallback capitalized them to "Nflallday" in the marketplace mix.
  nflallday: "AllDay Native",
  laligagolazos: "Golazos Native",
  "on-chain": "On-chain",
  unknown: "Unknown",
}

export function marketplaceLabel(key: string): string {
  return ownValue(MARKETPLACE_LABEL, key) ?? (key.charAt(0).toUpperCase() + key.slice(1))
}

/** Accent colour per marketplace key; unknown key → neutral grey. */
export const MARKETPLACE_COLOR: Record<string, string> = {
  topshot: "#E03A2F",
  allday: "#4F94D4",
  golazos: "#22C55E",
  pinnacle: "#A855F7",
  flowty: "#3B82F6",
  // Candy's registry accent (lib/collections.ts), so the marketplace mix and
  // the collection chrome agree rather than defaulting this slice to grey.
  magic_eden: "#FB923C",
  nflallday: "#4F94D4",
  laligagolazos: "#22C55E",
  "on-chain": "#94A3B8",
  unknown: "#6B7280",
}

export function marketplaceColor(key: string): string {
  return ownValue(MARKETPLACE_COLOR, key) ?? "#6B7280"
}
