// Data-access layer for the pack DISTRIBUTION detail surface
// (app/(collections)/[collection]/pack/dist/[distId]/page.tsx).
//
// WHY THIS FILE EXISTS — TWO REASONS, BOTH STRUCTURAL.
//
// 1. COVERAGE. `app/**/page.tsx` is measured by NEITHER coverage gate: the
//    primary gate's include is `lib/**` + `app/**/route.ts(x)` + `proxy.ts`, and
//    the component gate is `components/**` + `app/**/*Client.tsx`. That leaves
//    ~48k LOC of server pages — 79 of which query Supabase directly — with no
//    ratchet at all. The established remedy in this repo is EXTRACTION: move the
//    logic into `lib/` where a gate already watches it (the same move the
//    trophy-case PDF route made in `lib/trophy-case/pdf-image.ts`). This module
//    is that move for the pack-dist page's fetch layer, which was the single
//    largest concentration of unmeasured data access in the tree (11 fetchers).
//
// 2. HONESTY. Most of those fetchers returned `[]` or `0` on a query ERROR, and
//    their callers render that as a POSITIVE CLAIM about the catalogue —
//    "Drop-pool contents aren't indexed for this distribution yet",
//    "computing pack contents…", "0 exhausted". A statement timeout therefore
//    told a visitor something false about our data rather than about our
//    availability. That is the exact class CLAUDE.md records as repeatedly
//    re-filed (`lib/insights/board-status.ts` header; the TrophyPickerModal fix;
//    the `/api/search` 503-not-empty rule). One fetcher in the page — the later
//    `fetchPackContents` — had ALREADY been fixed this way and carries a comment
//    saying so; this module generalises that fix to its ten siblings instead of
//    leaving one correct fetcher beside ten wrong ones.
//
// THE CONTRACT. Every fetcher returns `{ data, ok }` (or `{ rows, ok }`):
//
//   ok: false  →  the query FAILED. Callers must say so; they must not render
//                 an empty/zero value as a fact.
//   ok: true   →  the question was answered. `data` may legitimately be null /
//                 [] / 0 — that is a real "nothing here", safe to render.
//
// ⚠ A section that does not APPLY to this collection (e.g. the Top-Shot-only EV
// contributors on an All Day pack) is `ok: true` with empty data, NOT a failure.
// Marking it degraded would put a permanent "some data unavailable" banner on
// every All Day pack page, which is the cry-wolf failure the board-status module
// explicitly warns about for `stale-cache`.
//
// `db` is injectable (defaults to supabaseAdmin) so every branch is testable
// without a database — the same shape `lib/insights/candy-board.ts` uses.

import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import { computeTopPulls, type TopPull } from "@/lib/pack-dist-odds"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

// ── BUDGET ──────────────────────────────────────────────────────────────────
// ⚠ THIS PAGE IS THE TOP USER-IMPACTING ERROR IN PRODUCTION. Vercel's 24h window
// on 2026-08-23 shows `[pack-detail] pack_realized_ev error canceling statement
// due to statement timeout` at **124 users**, plus `pack_lifecycle` (86),
// `ev_contributors` (26) and `pack_table_rows` (22). Those are the reads that
// ANSWERED with an error. The ones that merely hang answer nothing at all —
// supabase-js resolves `{ data, error }` only when the query finishes — so the
// page waits on a streaming shell that Vercel logs as a 200.
//
// ⚠ ONE read here was already bounded (`get_pack_detail_bundle`, via
// `rpcWithRetry`) and THIRTEEN were not. That asymmetry is worth recording,
// because it is exactly the shape that would let a module-level "does this file
// mention a budget primitive?" check clear the whole page: one bounded read
// vouching for thirteen bare siblings. See scripts/check-unbounded-server-reads.mjs.
//
// ⚠ THE BOUND RESOLVES, IT DOES NOT REJECT. Every call site below is a bare
// `await` followed by `if (error)` — there is no try/catch to reject into, so a
// rejection would escape and render an error boundary instead of a page, which
// is worse than slow and is the trap the guard's own header warns about.
// Resolving with a synthetic `error` routes a timeout into the `ok: false`
// branch each fetcher already has. Same reasoning `withPagedBoardBudget` records
// for the paged /insights boards.
//
// ⚠ Page ceiling: `page.tsx` awaits `fetchPackRow` (+ fallback) and
// `fetchPackDetailBundle` sequentially, then three separate `Promise.all`
// groups. So the worst case is roughly 5 + 5 + 45 + 5 + 5 + 5 = 70s — dominated
// by `rpcWithRetry`'s own 45s, which is deliberately a ceiling ABOVE Postgres'
// 30s statement_timeout and must NOT be tuned down here (see its own header).
// **Bounding these thirteen does not by itself put the page inside a document's
// ~30s.** It removes the unbounded hangs; the bundle read's ceiling is a
// separate, already-argued decision.
const PACK_READ_TIMEOUT_MS = 5_000

// ── ⭐ RE-MEASURED 2026-09-03. THE BOUND WORKED, AND THE NUMBERS ABOVE ARE NOW
// ── THE *PRE-FIX* ONES — do not read them as today's severity.
// Vercel runtime errors, 24 h to 2026-09-03 05:43Z, same grouping:
//   pack_realized_ev  124 users (08-23)  ->    6 users
//   pack_lifecycle     86 users (08-23)  ->   13 users
//   ev_contributors    26 users (08-23)  ->    1 user
// A 7-20x drop, and what remains is the honest-degradation path FIRING, not the
// hang it replaced. That is the intended end state, not a residual defect.
//
// ⛔ AND DO NOT TUNE THESE RPCs — the overruns are not the queries being slow.
// Measured 2026-09-03 over a deterministic hash sample (never physical order),
// warm: `get_pack_lifecycle` runs **5-32 ms** across 8 packs, and 53 ms /
// 3,683 buffers on the newest one. Against a 5,000 ms budget that is three
// orders of magnitude of headroom, so an overrun is the INSTANCE under
// contention (the documented ~22 MB/s IO ceiling, register R46 — a capacity
// decision already made: stay on Small), not this function. Re-derive before
// believing either half.

/**
 * Bound one read, RESOLVING with a synthetic `error` rather than rejecting.
 *
 * ⚠ ONE envelope for all thirteen callers, not a generic. `Db` is `any` here, so
 * a generic infers `unknown` and every call site stops compiling; and every
 * caller destructures some subset of `{ data, count, error }`, so the overrun
 * value supplies all three as null and each site's existing `if (error)` branch
 * does the work. A different shape per caller would be thirteen chances to get
 * one wrong.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReadEnvelope = { data: any; count: number | null; error: { message: string } | null }

async function bounded(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: PromiseLike<any>,
  label: string,
): Promise<ReadEnvelope> {
  try {
    return await withBoardBudget<ReadEnvelope>(
      Promise.resolve(p),
      label,
      PACK_READ_TIMEOUT_MS,
      "pack-detail/",
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // 🚨 DELIBERATELY SILENT — the CALLER logs this, and logging here too made ONE
    // failure arrive as TWO. Measured in Vercel's error groups, 12 h to
    // 2026-09-05: `pack_lifecycle bound` count=6 and `pack_lifecycle error`
    // count=6; `pack_realized_ev bound` count=4 and `pack_realized_ev error`
    // count=4 — identical counts because they are the same six and four events.
    // The pack-detail route looked like it had six distinct problems when it had
    // three, and any observer counting occurrences read 2x the real incidence.
    //
    // ⚠ THE CALLER'S LOG IS THE ONE TO KEEP, not this one, and the reason is
    // COVERAGE not preference: this catch only fires on the REJECT path (a
    // `withBoardBudget` timeout), while every call site's `if (error)` branch also
    // catches a real PostgREST error, which never reaches here. Keeping this one
    // instead would have silently dropped every non-timeout failure.
    //
    // ⛔ Safe only because ALL 13 call sites log on their error branch — checked,
    // not assumed, and now pinned by
    // `__tests__/pack-dist-bounded-reads-are-logged-exactly-once.test.ts` so a
    // 14th site cannot quietly go unlogged.
    return { data: null, count: null, error: { message } }
  }
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** A single-row read: `data` is null when absent, `ok` is false only on error. */
export interface RowResult<T> {
  data: T | null
  ok: boolean
}

/** A multi-row read: `rows` is empty when absent, `ok` is false only on error. */
export interface RowsResult<T> {
  rows: T[]
  ok: boolean
}

// ── Row shapes (moved verbatim from the page) ───────────────────────────────

export interface PackTableRow {
  dist_id: string
  collection_id: string
  collection_name: string
  collection_slug: string
  title: string | null
  image_url: string | null
  nft_type: string | null
  tier: string | null
  pack_type: string | null
  description: string | null
  retail_price_usd: string | number | null
  slots: number | null
  total_minted: number | null
  total_opened: number | null
  total_sealed: number | null
  depletion_pct: number | null
  pack_ev: string | number | null
  gross_ev: string | number | null
  typical_ev: string | number | null
  ev_pack_price: string | number | null
  value_ratio: string | number | null
  is_positive_ev: boolean | null
  fmv_coverage_pct: number | null
  edition_count: number | null
  total_unopened: number | null
  ev_depletion_pct: number | null
  ev_snapshotted_at: string | null
  ev_margin_pct: string | number | null
  is_rare_single_pack: boolean | null
  primary_price: string | number | null
  secondary_ask: string | number | null
  price_source: "primary" | "secondary" | "min" | "none" | null
  primary_available: boolean | null
  secondary_available: boolean | null
}

export interface DistFallbackRow {
  metadata: Record<string, unknown> | null
  image_url: string | null
  title: string | null
}

export interface DropPoolRow {
  edition_id: string
  drop_weight: string | number | null
}

export interface EditionLite {
  id: string
  name: string | null
  tier: string | null
  external_id: string | null
  player_name: string | null
  set_name: string | null
}

export interface FmvRow {
  edition_id: string
  fmv_usd: string | number | null
}

export interface PackLifecycleRow {
  packs_opened: string | number | null
  packs_opened_confirmed: string | number | null
  packs_opened_inferred: string | number | null
  packs_sealed_observed: string | number | null
  moments_pulled: string | number | null
  realized_pull_value_usd: string | number | null
  avg_realized_value_per_pack: string | number | null
  observed_depletion_pct: string | number | null
}

export interface PackRealizedEvRow {
  modeled_gross_ev: string | number | null
  n_opens: string | number | null
  realized_mean: string | number | null
  realized_median: string | number | null
  realized_p90: string | number | null
  realized_to_modeled_ratio: string | number | null
  calibrated_ev: string | number | null
}

export interface AllDayCorrectedEvRow {
  corrected_gross_ev: string | number | null
  corrected_net_ev: string | number | null
  corrected_value_ratio: string | number | null
  ev_method: string | null
  has_published_odds: boolean | null
  stale_value_share_pct: string | number | null
  low_confidence_ev: boolean | null
  opened_count: string | number | null
  packnft_total: string | number | null
  opened_pct_of_minted: string | number | null
}

export interface PackMarketRow {
  n_sales: string | number | null
  n_sales_30d: string | number | null
  n_sales_90d: string | number | null
  last_sale_price: string | number | null
  last_sale_at: string | null
  avg_price_90d: string | number | null
  median_price_90d: string | number | null
  min_price_all: string | number | null
  max_price_all: string | number | null
  retail_price: string | number | null
  secondary_vs_retail_ratio: string | number | null
}

export interface EvContributor {
  edition_id: string
  external_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  fmv_usd: string | number | null
  confidence: string | null
  pull_prob: string | number | null
  ev_per_slot: string | number | null
  pct_of_ev: string | number | null
}

export interface PackSaleRow {
  kind: "top" | "recent" | string
  buyer_address: string | null
  seller_address: string | null
  sale_price: string | number | null
  sale_currency: string | null
  sealed_at: string | null
  tx_hash: string | null
}

export interface HeroEdition {
  route_slug: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  thumbnail_url: string | null
  rep_nft_id: string | null
  fmv_usd: number | null
  hit_probability: number | null
}

export interface PackDetailBundle {
  pack_row: PackTableRow | null
  dist_fallback: DistFallbackRow | null
  corrected_ev: AllDayCorrectedEvRow | null
  hero_editions: HeroEdition[] | null
  has_pool: boolean | null
}

// ── Shell bundle ────────────────────────────────────────────────────────────

/**
 * The one-RPC shell bundle (P3): pack_row + dist_fallback + All Day corrected_ev
 * + top-5 FMV hero editions + has_pool, on ONE connection. It replaced a 10-way
 * per-request `Promise.all` fan-out that was saturating the pool (~58 statement
 * timeouts/24h).
 *
 * ⚠ This one does NOT follow the `ok` convention, and the difference is
 * deliberate rather than an oversight. Every other fetcher here feeds a panel
 * that can degrade; this one is the page's **throw-or-404 gate**, and the caller
 * must be able to tell a failed bundle from a genuinely-absent dist — collapsing
 * them renders real packs as 404s under contention, which is a soft-404 a crawler
 * will believe. So the raw error is returned for the caller to branch on and
 * throw. Returning `ok:false` here would discard the message the caller puts in
 * the thrown error.
 *
 * `rpcWithRetry` because a transient pool blip must not flip a real dist to the
 * error boundary on the first miss — but note 57014 is deliberately NOT retried
 * upstream (a statement that blew its timeout will blow it again).
 */
export async function fetchPackDetailBundle(
  collectionId: string,
  distId: string,
  collectionSlug: string,
  db: Db = supabaseAdmin,
): Promise<{ bundle: PackDetailBundle; error: { message: string } | null }> {
  const { data, error } = await rpcWithRetry(db, "get_pack_detail_bundle", {
    p_collection_id: collectionId,
    p_dist_id: distId,
    p_collection_slug: collectionSlug,
  })
  if (error) console.error("[pack-detail] bundle error", error.message)
  return {
    bundle: (data ?? {}) as PackDetailBundle,
    error: error ? { message: error.message } : null,
  }
}

// ── Metadata-path reads ─────────────────────────────────────────────────────

export async function fetchPackRow(
  collectionId: string,
  distId: string,
  db: Db = supabaseAdmin,
): Promise<RowResult<PackTableRow>> {
  const { data, error } = await bounded(
    db
      .from("pack_table_rows")
      .select("*")
      .eq("collection_id", collectionId)
      .eq("dist_id", distId)
      .limit(1)
      .maybeSingle(),
    "pack_table_rows",
  )
  if (error) {
    console.error("[pack-detail] pack_table_rows error", error.message)
    return { data: null, ok: false }
  }
  return { data: (data as PackTableRow | null) ?? null, ok: true }
}

export async function fetchDistFallback(
  collectionId: string,
  distId: string,
  db: Db = supabaseAdmin,
): Promise<RowResult<DistFallbackRow>> {
  const { data, error } = await bounded(
    db
      .from("pack_distributions")
      .select("metadata, image_url, title")
      .eq("collection_id", collectionId)
      .eq("dist_id", distId)
      .limit(1)
      .maybeSingle(),
    "pack_distributions",
  )
  if (error) {
    console.error("[pack-detail] pack_distributions error", error.message)
    return { data: null, ok: false }
  }
  return { data: (data as DistFallbackRow | null) ?? null, ok: true }
}

// ── Lifecycle / realized-EV / market (streamed sections) ────────────────────

/**
 * Observed pack lifecycle. All Day reads `v_allday_pack_lifecycle` and maps into
 * the shared shape; Top Shot uses the per-dist SECDEF RPC. Any OTHER collection
 * has no lifecycle source at all — that is `ok: true` with no data, not a failure.
 */
export async function fetchPackLifecycle(
  collectionSlug: string,
  distId: string,
  db: Db = supabaseAdmin,
): Promise<RowResult<PackLifecycleRow>> {
  if (collectionSlug === "nfl-all-day") {
    const { data, error } = await bounded(
      db
        .from("v_allday_pack_lifecycle")
        .select(
          "packs_opened, minted, moments_pulled, realized_pull_value_usd, avg_realized_value_per_pack, opened_pct_of_minted",
        )
        .eq("dist_id", distId)
        .maybeSingle(),
      "allday_pack_lifecycle",
    )
    if (error) {
      console.error("[pack-detail] allday_pack_lifecycle error", error.message)
      return { data: null, ok: false }
    }
    if (!data) return { data: null, ok: true }
    return {
      ok: true,
      data: {
        packs_opened: data.packs_opened ?? null,
        packs_opened_confirmed: data.packs_opened ?? null, // all on-chain confirmed
        packs_opened_inferred: 0,
        // Sealed = minted - opened (the registry knows the full mint).
        packs_sealed_observed:
          data.minted != null && data.packs_opened != null && Number(data.minted) >= Number(data.packs_opened)
            ? Number(data.minted) - Number(data.packs_opened)
            : null,
        moments_pulled: data.moments_pulled ?? null,
        realized_pull_value_usd: data.realized_pull_value_usd ?? null,
        avg_realized_value_per_pack: data.avg_realized_value_per_pack ?? null,
        observed_depletion_pct: data.opened_pct_of_minted ?? null,
      },
    }
  }
  if (collectionSlug !== "nba-top-shot") return { data: null, ok: true }
  const { data, error } = await bounded(
    db.rpc("get_pack_lifecycle_row", { p_dist_id: distId }).maybeSingle(),
    "pack_lifecycle",
  )
  if (error) {
    console.error("[pack-detail] pack_lifecycle error", error.message)
    return { data: null, ok: false }
  }
  return { data: (data as PackLifecycleRow | null) ?? null, ok: true }
}

export async function fetchPackRealizedEv(
  collectionSlug: string,
  distId: string,
  db: Db = supabaseAdmin,
): Promise<RowResult<PackRealizedEvRow>> {
  if (collectionSlug === "nfl-all-day") {
    const { data, error } = await bounded(
      db
        .from("v_allday_pack_realized_ev")
        .select("modeled_gross_ev, n_opens, realized_mean, realized_median, realized_to_modeled_ratio")
        .eq("dist_id", distId)
        .maybeSingle(),
      "allday_pack_realized_ev",
    )
    if (error) {
      console.error("[pack-detail] allday_pack_realized_ev error", error.message)
      return { data: null, ok: false }
    }
    if (!data) return { data: null, ok: true }
    return {
      ok: true,
      data: {
        modeled_gross_ev: data.modeled_gross_ev ?? null,
        n_opens: data.n_opens ?? null,
        realized_mean: data.realized_mean ?? null,
        realized_median: data.realized_median ?? null,
        realized_p90: null,
        realized_to_modeled_ratio: data.realized_to_modeled_ratio ?? null,
        calibrated_ev: null,
      },
    }
  }
  if (collectionSlug !== "nba-top-shot") return { data: null, ok: true }
  const { data, error } = await bounded(
    db.rpc("get_pack_realized_ev_row", { p_dist_id: distId }).maybeSingle(),
    "pack_realized_ev",
  )
  if (error) {
    console.error("[pack-detail] pack_realized_ev error", error.message)
    return { data: null, ok: false }
  }
  return { data: (data as PackRealizedEvRow | null) ?? null, ok: true }
}

export async function fetchAllDayCorrectedEv(
  collectionSlug: string,
  distId: string,
  db: Db = supabaseAdmin,
): Promise<RowResult<AllDayCorrectedEvRow>> {
  if (collectionSlug !== "nfl-all-day") return { data: null, ok: true }
  const { data, error } = await bounded(
    db
      .from("v_allday_pack_detail_ev")
      .select(
        "corrected_gross_ev, corrected_net_ev, corrected_value_ratio, ev_method, has_published_odds, stale_value_share_pct, low_confidence_ev, opened_count, packnft_total, opened_pct_of_minted",
      )
      .eq("dist_id", distId)
      .maybeSingle(),
    "allday_corrected_ev",
  )
  if (error) {
    console.error("[pack-detail] allday_corrected_ev error", error.message)
    return { data: null, ok: false }
  }
  return { data: (data as AllDayCorrectedEvRow | null) ?? null, ok: true }
}

const PACK_MARKET_VIEW: Record<string, string> = {
  "nfl-all-day": "v_allday_pack_market",
  "nba-top-shot": "v_topshot_pack_market",
}

export async function fetchPackMarket(
  collectionSlug: string,
  distId: string,
  db: Db = supabaseAdmin,
): Promise<RowResult<PackMarketRow>> {
  if (!PACK_MARKET_VIEW[collectionSlug]) return { data: null, ok: true }
  const { data, error } = await bounded(
    db.rpc("get_pack_market_row", { p_collection_slug: collectionSlug, p_dist_id: distId }),
    "pack_market",
  )
  if (error) {
    console.error(`[pack-detail] pack_market rpc error (${collectionSlug})`, error.message)
    return { data: null, ok: false }
  }
  const row = Array.isArray(data) ? data[0] : data
  return { data: (row as PackMarketRow | null) ?? null, ok: true }
}

// ── Pool-derived reads ──────────────────────────────────────────────────────

export async function fetchEvContributors(
  collectionSlug: string,
  distId: string,
  db: Db = supabaseAdmin,
): Promise<RowsResult<EvContributor>> {
  if (collectionSlug !== "nba-top-shot") return { rows: [], ok: true }
  const { data, error } = await bounded(
    db.rpc("get_pack_ev_contributors", { p_dist_id: distId, p_limit: 12 }),
    "ev_contributors",
  )
  if (error) {
    console.error("[pack-detail] ev_contributors error", error.message)
    return { rows: [], ok: false }
  }
  return { rows: Array.isArray(data) ? (data as EvContributor[]) : [], ok: true }
}

/**
 * Top pulls by per-slot EV.
 *
 * ⚠ The POOL read is load-bearing and its failure must propagate: an empty
 * result renders "Drop-pool contents aren't indexed for this distribution yet",
 * a claim about OUR INDEX. A timeout there previously produced that sentence.
 *
 * The three follow-up reads (editions / FMV / full-pool weight) are DIFFERENT:
 * `computeTopPulls` degrades gracefully on each — a missing edition row yields a
 * blank player cell, a missing FMV yields a null EV, and a missing weight sum
 * makes `probabilityPct` null by design (audit B2: never fall back to summing
 * only the top-50 weights, which inflates the percentage). Rows still render and
 * every absent number renders as an em-dash, so the honest signal is already on
 * screen. They mark the section PARTIAL rather than failed, which is exactly the
 * distinction `BoardStatus.partial` exists to carry.
 */
export async function fetchTopPulls(
  collectionId: string,
  distId: string,
  totalUnopened: number | null,
  slots: number | null,
  db: Db = supabaseAdmin,
): Promise<RowsResult<TopPull> & { partial: boolean }> {
  const { data: poolRows, error: poolErr } = await bounded(
    db
      .from("pack_drop_pool")
      .select("edition_id, drop_weight")
      .eq("dist_id", distId)
      .eq("collection_id", collectionId)
      .gt("drop_weight", 0)
      .order("drop_weight", { ascending: false })
      .limit(50),
    "drop_pool",
  )
  if (poolErr) {
    console.error("[pack-detail] pack_drop_pool error", poolErr.message)
    return { rows: [], ok: false, partial: false }
  }
  const pool = (poolRows ?? []) as DropPoolRow[]
  if (pool.length === 0) return { rows: [], ok: true, partial: false }

  const editionIds = pool.map((r) => r.edition_id)

  const [editionsRes, fmvRes, fullPoolWeightRes] = await Promise.all([
    db.from("editions").select("id, name, tier, external_id, player_name, set_name").in("id", editionIds),
    db.rpc("get_fmv_for_editions", {
      p_collection_id: collectionId,
      p_edition_ids: editionIds,
    }),
    db.rpc("query_sql", {
      query: `
        SELECT COALESCE(SUM(drop_weight), 0)::numeric AS total_weight
        FROM pack_drop_pool
        WHERE dist_id = '${distId.replace(/'/g, "''")}'
          AND collection_id = '${collectionId.replace(/'/g, "''")}'
          AND drop_weight > 0
      `,
    }),
  ])

  if (editionsRes.error) console.error("[pack-detail] editions error", editionsRes.error.message)
  if (fmvRes.error) console.error("[pack-detail] fmv rpc error", fmvRes.error.message)
  if (fullPoolWeightRes.error)
    console.error("[pack-detail] full pool weight error", fullPoolWeightRes.error.message)
  const partial = Boolean(editionsRes.error || fmvRes.error || fullPoolWeightRes.error)

  const fullPoolWeight = Number(
    (fullPoolWeightRes.data as Array<{ total_weight: number | string }> | null)?.[0]?.total_weight ?? 0,
  )

  return {
    ok: true,
    partial,
    rows: computeTopPulls({
      pool,
      editions: (editionsRes.data ?? []) as EditionLite[],
      fmv: (fmvRes.data ?? []) as FmvRow[],
      fullPoolWeight,
      totalUnopened,
      slots,
    }),
  }
}

/**
 * The visual "What's Inside" grid. This one was ALREADY error-aware before the
 * extraction (it returned `null` on failure and `[]` on an empty pool); the
 * `{ rows, ok }` shape says the same thing in the module's uniform vocabulary.
 */
export async function fetchPackContents(
  collectionId: string,
  distId: string,
  limit: number,
  offset: number,
  db: Db = supabaseAdmin,
): Promise<RowsResult<unknown>> {
  const { data, error } = await bounded(
    db.rpc("get_pack_contents", {
      p_collection_id: collectionId,
      p_dist_id: distId,
      p_limit: limit,
      p_offset: offset,
    }),
    "pack_contents",
  )
  if (error) {
    console.error("[pack-detail] get_pack_contents error", error.message)
    return { rows: [], ok: false }
  }
  return { rows: Array.isArray(data) ? data : [], ok: true }
}

/**
 * Count of exhausted (drop_weight = 0) pool rows.
 *
 * ⚠ Previously returned literal `0` on error — a NUMBER manufactured from a
 * failure, rendered in a section header as though it were measured. `ok: false`
 * lets the caller withhold the count instead of publishing a false zero.
 */
export async function fetchExhaustedCount(
  collectionId: string,
  distId: string,
  db: Db = supabaseAdmin,
): Promise<{ count: number; ok: boolean }> {
  const { count, error } = await bounded(
    db
      .from("pack_drop_pool")
      .select("edition_id", { count: "exact", head: true })
      .eq("collection_id", collectionId)
      .eq("dist_id", distId)
      .eq("drop_weight", 0),
    "exhausted_count",
  )
  if (error) {
    console.error("[pack-detail] exhausted count error", error.message)
    return { count: 0, ok: false }
  }
  return { count: count ?? 0, ok: true }
}

export async function fetchPackSalesHistory(
  collectionId: string,
  distId: string,
  limit = 10,
  db: Db = supabaseAdmin,
): Promise<RowsResult<PackSaleRow>> {
  const { data, error } = await bounded(
    db.rpc("get_pack_sales_history", {
      p_collection_id: collectionId,
      p_dist_id: distId,
      p_limit: limit,
    }),
    "pack_sales_history",
  )
  if (error) {
    console.error("[pack-detail] get_pack_sales_history error", error.message)
    return { rows: [], ok: false }
  }
  return { rows: Array.isArray(data) ? (data as PackSaleRow[]) : [], ok: true }
}
