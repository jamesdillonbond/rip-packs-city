// lib/parallel-premiums-board.ts
//
// Shared config + fetch for the public Parallel Premiums board. Backed by the
// read-only analytics view public.v_topshot_parallel_premiums (security_invoker
// =on, anon-granted), which pairs every TopShot ::subID parallel edition with
// its Standard base edition and computes premium_mult = parallel_fmv / base_fmv.
//
// This is intelligence NEITHER nbatopshot.com NOR dapper.market expose: both
// name parallels (Hexwave / Cosmic / Club Collection / …) but neither prices
// them relative to the Standard. RPC can only do this because the 2026-06-20
// subedition (::) conflation split gave each parallel its own FMV.

export type ParallelSortKey = "premium" | "parallel_fmv" | "scarcity"

export type ParallelRow = {
  edition_id: string | null
  external_id: string | null
  base_ext: string | null
  player_name: string | null
  set_name: string | null
  series: number | null
  tier: string | null
  subedition_name: string | null
  parallel_circ: number | null
  base_circ: number | null
  base_fmv: number | null
  base_confidence: string | null
  parallel_fmv: number | null
  parallel_confidence: string | null
  premium_mult: number | null
  both_high_conf: boolean
  thumbnail_url: string | null
}

const COLS = [
  "edition_id",
  "external_id",
  "base_ext",
  "player_name",
  "set_name",
  "series",
  "tier",
  "subedition_name",
  "parallel_circ",
  "base_circ",
  "base_fmv",
  "base_confidence",
  "parallel_fmv",
  "parallel_confidence",
  "premium_mult",
  "both_high_conf",
  "thumbnail_url",
].join(", ")

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeRow(raw: Record<string, unknown>): ParallelRow {
  return {
    edition_id: (raw.edition_id as string) ?? null,
    external_id: (raw.external_id as string) ?? null,
    base_ext: (raw.base_ext as string) ?? null,
    player_name: (raw.player_name as string) ?? null,
    set_name: (raw.set_name as string) ?? null,
    series: num(raw.series),
    tier: (raw.tier as string) ?? null,
    subedition_name: (raw.subedition_name as string) ?? null,
    parallel_circ: num(raw.parallel_circ),
    base_circ: num(raw.base_circ),
    base_fmv: num(raw.base_fmv),
    base_confidence: (raw.base_confidence as string) ?? null,
    parallel_fmv: num(raw.parallel_fmv),
    parallel_confidence: (raw.parallel_confidence as string) ?? null,
    premium_mult: num(raw.premium_mult),
    both_high_conf: raw.both_high_conf === true,
    thumbnail_url: (raw.thumbnail_url as string) ?? null,
  }
}

export type ParallelFetchOpts = {
  parallelName?: string | null // subedition_name filter (e.g. "Hexwave")
  minPremium: number // premium_mult floor; default 1.5
  highConfOnly: boolean // require both sides HIGH/MEDIUM FMV
  sort: ParallelSortKey
  limit: number
}

// Query the view and return normalized rows. `supabase` is the service-role
// client (typed any per the repo API-route convention).
export async function fetchParallelPremiums(
  supabase: any,
  opts: ParallelFetchOpts
): Promise<ParallelRow[]> {
  let q = supabase
    .from("v_topshot_parallel_premiums")
    .select(COLS)
    .not("premium_mult", "is", null)
    .gte("premium_mult", opts.minPremium)

  if (opts.highConfOnly) q = q.eq("both_high_conf", true)
  if (opts.parallelName) q = q.eq("subedition_name", opts.parallelName)

  if (opts.sort === "parallel_fmv") q = q.order("parallel_fmv", { ascending: false })
  else if (opts.sort === "scarcity") q = q.order("parallel_circ", { ascending: true })
  else q = q.order("premium_mult", { ascending: false })

  q = q.limit(opts.limit)

  const { data, error } = await q
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<Record<string, unknown>>).map(normalizeRow)
}
