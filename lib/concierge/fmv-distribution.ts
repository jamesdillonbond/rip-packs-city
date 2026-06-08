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

function buildDistribution(
  rows: Array<DistributionalSampleEdition>,
  sampleLimit: number
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
 *  2. Pull the latest fmv_snapshots row per edition_id and reduce client-side.
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
  let query = supabase
    .from("editions")
    .select("id, external_id, player_name, set_name, tier, collection_id")
    .not("player_name", "is", null)
    .neq("player_name", "")
  if (input.collectionUuid) query = query.eq("collection_id", input.collectionUuid)
  if (input.player) query = query.ilike("player_name", `%${input.player}%`)
  if (input.setName) query = query.ilike("set_name", `%${input.setName}%`)
  // editions.tier is a Postgres enum (tier_type) — values COMMON, FANDOM,
  // RARE, LEGENDARY, ULTIMATE. ILIKE doesn't work on enum columns without
  // an explicit text cast, and the supabase-js .ilike() helper doesn't
  // emit one, so we normalize to uppercase and use eq() instead. The
  // model can pass any case (common, Common, COMMON) — sixth run of
  // Test 2 confirmed the model now reaches for the tier param after the
  // f55e022 prompt rule, but the upstream filter was silently failing.
  if (input.tier) query = query.eq("tier", input.tier.toUpperCase())
  // Hard cap to keep the result set bounded — the model never needs more
  // than ~500 editions to compute a meaningful distribution. Larger queries
  // return the first 500 ordered by id, which is acceptable for a sampled
  // distribution at p10/p50/p90.
  const { data: editions, error: edErr } = await query.limit(500)
  if (edErr) return { status: "no_results", message: `editions query error: ${edErr.message}` }
  if (!editions || editions.length === 0) {
    return { status: "no_results", message: "No catalog editions matched those filters." }
  }

  const ids: string[] = editions.map((e: { id: string }) => e.id)
  const { data: snaps, error: snErr } = await supabase
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, confidence, computed_at")
    .in("edition_id", ids)
    .order("computed_at", { ascending: false })
  if (snErr) return { status: "no_results", message: `fmv_snapshots query error: ${snErr.message}` }

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

  return buildDistribution(enriched, sampleLimit)
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
