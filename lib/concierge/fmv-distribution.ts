import { keepCanonicalEditionRows } from "@/lib/concierge/edition-listings"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
// lib/concierge/fmv-distribution.ts
//
// Shared catalog-FMV helpers used by the support-chat tools. The unified
// (NBA TS / NFL All Day / LaLiga Golazos / UFC Strike) helper queries
// editions + fmv_snapshots; the Pinnacle helper queries pinnacle_catalog,
// which holds PER-RENDER FMV (render_id PK). (character, set, variant) is
// 1:1 with a render there, so each catalog row is one priced render — the
// legacy pinnacle_editions + pinnacle_fmv_snapshots blend is retired.
//
// Both return one of three shapes:
//   { status: "no_results", message }
//   { status: "ok", mode: "single", edition: {...} }       when count = 1
//   { status: "ok", mode: "distribution", count, p10,      when count >= 2
//     p50, p90, min_fmv, max_fmv, sample_editions: [...5] }
//
// "Sample editions" are the five most-recently-priced rows so the model
// can cite concrete examples alongside the distribution.
//
// NULL guards: editions with player_name IS NULL or set_name IS NULL are
// excluded — the catalog has 134 + 1,389 such rows that would otherwise
// silently inflate the no-match count without a real player/set to surface.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = any

export interface DistributionalSampleEdition {
  edition_id: string
  external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  fmv_usd: number
  confidence: string | null
  computed_at: string | null
}

export interface SingleEditionShape {
  edition_id: string
  external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  fmv_usd: number
  confidence: string | null
  computed_at: string | null
}

export type FmvDistributionResult =
  | { status: "no_results"; message: string }
  | { status: "ok"; mode: "single"; edition: SingleEditionShape }
  | {
      status: "ok"
      mode: "distribution"
      count: number
      p10: number
      p50: number
      p90: number
      min_fmv: number
      max_fmv: number
      sample_editions: DistributionalSampleEdition[]
      /**
       * Honesty fields. `count` is how many PRICED editions went into the
       * percentiles; `population_matched` is how many editions the filter
       * actually matched. When `truncated` is true they are different things
       * and the percentiles describe a SLICE, not the set.
       */
      population_matched?: number
      scanned?: number
      scan_cap?: number
      truncated?: boolean
      truncation_note?: string
    }

interface UnifiedInput {
  collectionUuid: string | null
  player?: string | null
  setName?: string | null
  tier?: string | null
  editionKey?: string | null
  /** Max sample-editions returned in distribution mode. Default 5, hard cap 10. */
  sampleLimit?: number
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base])
  }
  return sorted[base]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

type ScanInfo = { populationMatched: number; scanned: number; cap: number }

function buildDistribution(
  rows: Array<DistributionalSampleEdition>,
  sampleLimit: number,
  scan?: ScanInfo
): FmvDistributionResult {
  if (rows.length === 0) {
    return { status: "no_results", message: "No catalog editions matched those filters." }
  }
  if (rows.length === 1) {
    const r = rows[0]
    return {
      status: "ok",
      mode: "single",
      edition: {
        edition_id: r.edition_id,
        external_id: r.external_id,
        player_name: r.player_name,
        set_name: r.set_name,
        tier: r.tier,
        fmv_usd: r.fmv_usd,
        confidence: r.confidence,
        computed_at: r.computed_at,
      },
    }
  }
  const fmvs = rows.map((r) => r.fmv_usd).sort((a, b) => a - b)
  const samples = [...rows]
    .sort((a, b) => {
      const at = a.computed_at ? Date.parse(a.computed_at) : 0
      const bt = b.computed_at ? Date.parse(b.computed_at) : 0
      return bt - at
    })
    .slice(0, Math.min(Math.max(sampleLimit, 1), 10))
  return {
    status: "ok",
    mode: "distribution",
    count: rows.length,
    p10: round2(quantile(fmvs, 0.1)),
    p50: round2(quantile(fmvs, 0.5)),
    p90: round2(quantile(fmvs, 0.9)),
    min_fmv: round2(fmvs[0]),
    max_fmv: round2(fmvs[fmvs.length - 1]),
    sample_editions: samples,
    ...(scan
      ? {
          population_matched: scan.populationMatched,
          scanned: scan.scanned,
          scan_cap: scan.cap,
          truncated: scan.populationMatched > scan.cap,
          ...(scan.populationMatched > scan.cap
            ? {
                truncation_note:
                  `These percentiles are computed over ${scan.scanned} editions out of ${scan.populationMatched} that matched — the read is capped at ${scan.cap}. They describe a SLICE of the filter, not the whole thing, and the slice is taken in a fixed catalog order rather than at random, so it is not a representative sample either. Say so and offer to narrow by set or tier (search_catalog lists the matching sets); do not present these as the distribution for the whole filter.`,
              }
            : {}),
        }
      : {}),
  }
}

/**
 * Unified path: editions + fmv_snapshots for NBA Top Shot, NFL All Day,
 * LaLiga Golazos, UFC Strike.
 *
 * Strategy:
 *  1. Filter editions by (collection_uuid, player ILIKE, set ILIKE, tier).
 *     NULL player_name / set_name rows are excluded (they cannot match the
 *     ILIKE filter when one is provided; when none is provided they are
 *     still skipped via player_name IS NOT NULL to avoid the no-name catalog
 *     rows polluting distributions).
 *  2. Pull the latest FMV per edition_id via get_editions_latest_fmv (a per-id
 *     LATERAL LIMIT 1 over fmv_snapshots). This avoids BOTH the 1000-row
 *     PostgREST clamp that raw fmv_snapshots history hits AND the row
 *     amplification of reading fmv_current, which has no per-group LIMIT and
 *     so scans every snapshot per edition — measured 2026-09-02 for 500 ids at
 *     25,330 buffers / 1,070 ms warm (42,342 / 10.0 s cold on a heavier id
 *     set) versus 2,002 / 4.0 ms for the RPC. See the ⛔ block at the read
 *     itself: the 1,334,789 / 249x this line used to cite is RETRACTED.
 *  3. Aggregate to {count, p10, p50, p90, min, max, sample_editions}.
 *
 * Returns single-edition shape when exactly one edition matches AND has FMV;
 * distributional shape for 2+; no_results for 0.
 */
export async function fetchUnifiedFmvDistribution(
  supabase: Supabase,
  input: UnifiedInput
): Promise<FmvDistributionResult> {
  const sampleLimit = input.sampleLimit ?? 5

  // EditionKey path: deterministic single lookup against external_id.
  if (input.editionKey) {
    const { data: edition } = await supabase
      .from("editions")
      .select("id, external_id, player_name, set_name, tier")
      .eq("external_id", input.editionKey)
      .maybeSingle()
    if (!edition?.id) {
      return { status: "no_results", message: `No edition found for key '${input.editionKey}'.` }
    }
    const { data: snap } = await supabase
      .from("fmv_snapshots")
      .select("fmv_usd, confidence, computed_at")
      .eq("edition_id", edition.id)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!snap || snap.fmv_usd == null) {
      return { status: "no_results", message: `Edition '${input.editionKey}' has no FMV snapshot yet.` }
    }
    return {
      status: "ok",
      mode: "single",
      edition: {
        edition_id: edition.id,
        external_id: edition.external_id,
        player_name: edition.player_name,
        set_name: edition.set_name,
        tier: edition.tier,
        fmv_usd: Number(snap.fmv_usd),
        confidence: snap.confidence ?? null,
        computed_at: snap.computed_at ?? null,
      },
    }
  }

  // Filtered catalog query. We intentionally exclude NULL player_name rows
  // (134 in NBA TS, 36 in AllDay) so they don't pollute distributions or
  // sample-edition output. NULL set_name rows (1,389 in NBA TS) are kept
  // unless setName was provided as a filter — they have valid player names
  // and FMVs and shouldn't be hidden from a "LeBron Commons" query.
  // ⚠ ONE filter builder for both the count and the fetch. They must apply
  // byte-identical predicates — a population count taken over a different
  // WHERE than the sample is worse than no count at all, because it looks
  // authoritative. Do not inline either copy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyCatalogFilters = (q: any): any => {
    let out = q.not("player_name", "is", null).neq("player_name", "")
    if (input.collectionUuid) out = out.eq("collection_id", input.collectionUuid)
    if (input.player) out = out.ilike("player_name", `%${input.player}%`)
    if (input.setName) out = out.ilike("set_name", `%${input.setName}%`)
    if (input.tier) out = out.eq("tier", input.tier.toUpperCase())
    return out
  }

  // How many editions does this filter ACTUALLY match? Measured 2026-09-02:
  // a bitmap-AND over the trigram + collection indexes, 2,241 buffers /
  // 20.8 ms, so it is affordable on every call — and without it the tool
  // cannot tell "500 editions matched" from "5,016 matched and you are
  // seeing a tenth of them".
  const { count: populationMatched } = await applyCatalogFilters(
    supabase.from("editions").select("id", { count: "exact", head: true })
  )

  let query = supabase
    .from("editions")
    .select("id, external_id, player_name, set_name, tier, collection_id")
  query = applyCatalogFilters(query)
  // Deterministic order. Without one, LIMIT returns rows in PHYSICAL order,
  // which shifts as the table is rewritten — so two identical calls could
  // report different percentiles for the same filter and neither would look
  // wrong. external_id is not a random sample either, but it is STABLE and
  // explainable, and the truncation note says which it is.
  query = query.order("external_id", { ascending: true })
  // editions.tier is a Postgres enum (tier_type) — values COMMON, FANDOM,
  // RARE, LEGENDARY, ULTIMATE. ILIKE doesn't work on enum columns without
  // an explicit text cast, and the supabase-js .ilike() helper doesn't
  // emit one, so we normalize to uppercase and use eq() instead. The
  // model can pass any case (common, Common, COMMON) — sixth run of
  // Test 2 confirmed the model now reaches for the tier param after the
  // f55e022 prompt rule, but the upstream filter was silently failing.
  // ⚠ Hard cap. The comment this replaces claimed the first 500 come back
  // "ordered by id, which is acceptable for a sampled distribution" — both
  // halves were wrong. There was no ORDER BY, so it was PHYSICAL order; and a
  // physical-order slice of a catalog written in ingest order is not a sample,
  // it is a systematically early subset. MEASURED 2026-09-02: setName "Base
  // Set" matches 5,016 editions across TWO distinct set names, and the first
  // 500 covered ONE of the two — so p10/p50/p90 were computed over 10% of the
  // filter, from one set, and returned with count: 500 as the distribution.
  // ⛔ A percentile is worse than a truncated list here: a list that stops is
  // visibly short, a percentile over a slice looks like a summary of
  // everything. The cap STAYS (raising it multiplies the fmv_current read,
  // which is the expensive half) — what changes is that the caller is told,
  // via population_matched / truncated / truncation_note.
  const SCAN_CAP = 500
  const { data: editionRows, error: edErr } = await query.limit(SCAN_CAP)
  if (edErr) return { status: "no_results", message: `editions query error: ${edErr.message}` }
  // ⚠ Drop Top Shot's UUID-keyed twins before anything is counted. `editions`
  // holds every Top Shot moment under BOTH the int `setID:playID` key and a
  // UUID pair, so an unfiltered distribution counts each moment twice — and
  // the twins carry their own FMV rows, so this is not a cosmetic duplicate.
  // Measured 2026-08-15 for "Damian Lillard": 65 canonical vs 28 twins, of
  // which 14 are priced, so `count` reported 77 where the truth is 63 and the
  // percentiles were computed over the inflated set. No-op for every other
  // collection (they have no dual convention — applying it there returns
  // zero rows); see keepCanonicalEditions.
  type CatalogEditionRow = {
    id: string
    external_id: string | null
    player_name: string | null
    set_name: string | null
    tier: string | null
    collection_id: string | null
  }
  const editions = keepCanonicalEditionRows<CatalogEditionRow>(
    (editionRows ?? []) as CatalogEditionRow[],
    COLLECTION_UUID_BY_SLUG["nba-top-shot"] ?? "",
  )
  if (editions.length === 0) {
    return { status: "no_results", message: "No catalog editions matched those filters." }
  }

  const ids: string[] = editions.map((e: { id: string }) => e.id)
  // Latest FMV per edition, one row each. ⚠ The original reason for NOT reading
  // raw fmv_snapshots still stands and must not be undone: it keeps daily
  // history (~34 rows/edition), so a bare .in() over ~500 editions returns ~17k
  // rows, PostgREST clamps at 1,000, and ordered computed_at DESC *globally*
  // only the ~330 most-recently-snapshotted editions survive — the other ~34%
  // silently vanish and p10/p50/p90 skew toward recently-priced (hot) editions.
  // The fix for THAT was to read the fmv_current view. The fix was correct and
  // its cost was never measured; see the block below for what it turned out to
  // cost and what replaced it. Both constraints hold at once now: one row per
  // edition, and no full pass.
  // ⛔ DO NOT put this back to `.from("fmv_current").in("edition_id", ids)`.
  // fmv_current is a DISTINCT ON (edition_id) view over fmv_snapshots with no
  // per-group LIMIT, so reading it by edition id reaches the partitioned index
  // and STILL scans every snapshot row for each edition (~35 and growing), with
  // Unique discarding all but the newest. Warm, same session, 2026-09-02, the
  // 500-id list the caller actually sends, as a BOUND ARRAY (which is what
  // PostgREST emits - edition_id = ANY($1), confirmed in pg_stat_statements):
  //     fmv_current, = ANY($1) ..... 25,330 buffers   1,070 ms
  //     get_editions_latest_fmv ....  2,002 buffers       4 ms
  // ~13x fewer buffers here, 17x over the whole 6,190-edition All Day list.
  // ⚠ A SECOND session re-measured cold on 500 Top Shot "Base Set" ids and got
  // 42,342 buffers / 10.0 s against 5,359 / 470 ms — 8x, not 13x. Both are
  // right: cold vs warm, and Base Set editions carry ~80 snapshots each against
  // a ~35 average. Quote a RANGE and say what was cold.
  // ⚠ CORRECTED: the first version of this comment said "does NOT push down"
  // and claimed 1,334,789 buffers / 249x. Both came from a benchmark whose
  // "before" arm wrote the ids as IN (SELECT … FROM a CTE ordered by
  // external_id) — that becomes a HASH semi-join over the fully materialised
  // view, a shape PostgREST never sends. Re-measured and isolated to that one
  // ORDER BY. The swap is still right; the number was 15x too flattering.
  // The 16.7 s that motivated it sat inside a 60 s lambda that also runs the
  // Anthropic tool loop, and a live probe the same day ("what is a Base Set
  // common worth?") answered "the FMV lookup timed out on that one" — so the
  // user-facing symptom was real even though the attributed cost was not.
  // Judge any change here on BUFFERS, not wall clock.
  // The RPC applies the view's own selection rule per id
  // (LATERAL ... ORDER BY computed_at DESC LIMIT 1) and was verified to return
  // byte-identical rows for those 500 ids: 500 = 500, zero rows differing
  // either way. See migration 20260902225408 (+ 225443, its enum fix).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: snaps, error: snErr } = await (supabase as any).rpc("get_editions_latest_fmv", {
    p_edition_ids: ids,
  })
  // ⚠ A failed READ is not "no editions matched". This result type has no
  // error variant, so the message has to carry the distinction the shape
  // cannot — the prompt's error-vs-empty rule depends on the model being able
  // to tell them apart, and "no results" plus a silent failure reads as an
  // honest empty catalog.
  if (snErr) {
    return {
      status: "no_results",
      message: `FMV LOOKUP FAILED (not an empty result): get_editions_latest_fmv errored — ${snErr.message}. Tell the user the price check failed; do NOT say there is no FMV for this.`,
    }
  }

  // Reduce to latest FMV per edition.
  const latestById = new Map<
    string,
    { fmv_usd: number; confidence: string | null; computed_at: string | null }
  >()
  for (const s of snaps ?? []) {
    if (s.fmv_usd == null) continue
    if (latestById.has(s.edition_id)) continue
    latestById.set(s.edition_id, {
      fmv_usd: Number(s.fmv_usd),
      confidence: s.confidence ?? null,
      computed_at: s.computed_at ?? null,
    })
  }

  const enriched: DistributionalSampleEdition[] = []
  for (const e of editions) {
    const fmv = latestById.get(e.id)
    if (!fmv) continue
    enriched.push({
      edition_id: e.id,
      external_id: e.external_id ?? null,
      player_name: e.player_name ?? null,
      set_name: e.set_name ?? null,
      tier: e.tier ?? null,
      fmv_usd: fmv.fmv_usd,
      confidence: fmv.confidence,
      computed_at: fmv.computed_at,
    })
  }

  return buildDistribution(enriched, sampleLimit, {
    populationMatched: typeof populationMatched === "number" ? populationMatched : editions.length,
    scanned: editionRows?.length ?? 0,
    cap: SCAN_CAP,
  })
}

interface PinnacleInput {
  character?: string | null
  setName?: string | null
  variant?: string | null
  editionKey?: string | null
  sampleLimit?: number
}

/**
 * Pinnacle path: pinnacle_catalog (per-render FMV). Each render is one
 * priced row — (character, set, variant) is 1:1 with a render — so the
 * distribution is genuinely per-render rather than a per-edition blend.
 * legacy_edition_key is SET-LEVEL (spans characters), so the editionKey
 * lookup collapses to the most-traded render under that key.
 */
export async function fetchPinnacleFmvDistribution(
  supabase: Supabase,
  input: PinnacleInput
): Promise<FmvDistributionResult> {
  const sampleLimit = input.sampleLimit ?? 5
  const cols =
    "render_id, legacy_edition_key, character_name, set_name, variant, fmv_usd, fmv_confidence, fmv_computed_at, fmv_sales_count_30d"

  if (input.editionKey) {
    const { data: rows } = await supabase
      .from("pinnacle_catalog")
      .select(cols)
      .eq("legacy_edition_key", input.editionKey)
      .not("fmv_usd", "is", null)
      .order("fmv_sales_count_30d", { ascending: false })
    if (!rows || rows.length === 0) {
      return { status: "no_results", message: `Pinnacle edition '${input.editionKey}' has no priced render.` }
    }
    // The key can span renders/characters; the representative (most-traded
    // 30d) is rows[0] by the order above. Surface it as the single edition.
    const rep = rows[0]
    return {
      status: "ok",
      mode: "single",
      edition: {
        edition_id: rep.render_id,
        external_id: rep.legacy_edition_key ?? null,
        player_name: rep.character_name,
        set_name: rep.set_name,
        tier: rep.variant,
        fmv_usd: Number(rep.fmv_usd),
        confidence: rep.fmv_confidence ?? null,
        computed_at: rep.fmv_computed_at ?? null,
      },
    }
  }

  // ⚠ No population count / truncation flag on THIS path, and that is a
  // measurement, not an oversight. Measured 2026-09-02: pinnacle_catalog holds
  // 2,470 priced renders, the busiest CHARACTER has 35 and the busiest SET has
  // 102 — so a filtered query cannot reach the 500 cap, and only a bare
  // no-filter call could. The unified (Top Shot / All Day / Golazos) path is
  // the one where the cap really binds: "Base Set" alone matches 5,016.
  // Re-measure before assuming this still holds if the catalog grows.
  let query = supabase
    .from("pinnacle_catalog")
    .select(cols)
    .not("character_name", "is", null)
    .neq("character_name", "")
    .not("fmv_usd", "is", null)
  if (input.character) query = query.ilike("character_name", `%${input.character}%`)
  if (input.setName) query = query.ilike("set_name", `%${input.setName}%`)
  if (input.variant) query = query.ilike("variant", `%${input.variant}%`)
  const { data: renders } = await query.limit(500)
  if (!renders || renders.length === 0) {
    return { status: "no_results", message: "No priced Pinnacle renders matched those filters." }
  }

  const enriched: DistributionalSampleEdition[] = renders.map((r: {
    render_id: string; legacy_edition_key: string | null; character_name: string | null;
    set_name: string | null; variant: string | null; fmv_usd: number;
    fmv_confidence: string | null; fmv_computed_at: string | null;
  }) => ({
    edition_id: r.render_id,
    external_id: r.legacy_edition_key ?? null,
    player_name: r.character_name ?? null,
    set_name: r.set_name ?? null,
    tier: r.variant ?? null,
    fmv_usd: Number(r.fmv_usd),
    confidence: r.fmv_confidence,
    computed_at: r.fmv_computed_at,
  }))

  return buildDistribution(enriched, sampleLimit)
}
