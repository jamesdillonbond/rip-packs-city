// lib/new-collectors-board.ts
//
// Shared fetch + shape for the public New Collectors insights surface. Reads the
// four anon-granted materialized views (refreshed daily by the pg_cron job
// rpc-refresh-new-collectors -> refresh_insights_new_collectors()):
//
//   mv_insights_new_collectors_summary  — per-window acquisition + spend headline
//   mv_insights_new_collectors_spend    — first-buy price histogram per window
//   mv_insights_new_collectors_gateway  — gateway sets + players (top 10, 30d/90d)
//   mv_insights_new_collectors_cohorts  — monthly cohort behavior (size, repeat, LTV)
//
// Both the server page (initialBoard) and the /api/public route call this so they
// read one identical shape. The buyer-spine MV the aggregates are built from is
// service_role only (holds wallet addresses) — these four aggregates carry no
// addresses and are anon-readable.
//
// COVERAGE HONESTY: active/returning/market-$ and all composition (spend mix,
// gateway sets/players) are reliable for recent windows (~92% of active buyers
// captured). The raw new-buyer COUNT is inflated by partial historical buyer
// coverage; new_debiased strips wallets seen selling before their first observed
// buy. Self-corrects as the deep buyer backfill lands.

export type NCWindow = "7d" | "30d" | "90d"

export interface NCSummaryRow {
  window_label: string
  days: number
  new_first_seen: number
  new_debiased: number
  new_prior_period: number
  active_buyers: number
  returning_buyers: number
  market_usd: number
  new_usd: number
  median_first_buy: number
  avg_first_buy: number
  computed_at: string | null
}

export interface NCSpendRow {
  window_label: string
  b_lt5: number
  b_5_25: number
  b_25_100: number
  b_100_500: number
  b_500plus: number
  total_new: number
}

export interface NCGatewayRow {
  window_label: string
  kind: "set" | "player"
  name: string
  series: number | null
  buyers: number
  rnk: number
}

export interface NCCohortRow {
  cohort_month: string
  cohort_size: number
  repeat_30d_pct: number | null
  repeat_60d_pct: number | null
  repeat_90d_pct: number | null
  ltv_median: number | null
  ltv_avg: number | null
  whales: number
  median_days_to_10th: number | null
}

export interface NewCollectorsBoard {
  summary: NCSummaryRow[]
  spend: NCSpendRow[]
  // keyed by window_label ('30d' | '90d'), each pre-sorted by rnk
  gateway: Record<string, { sets: NCGatewayRow[]; players: NCGatewayRow[] }>
  cohorts: NCCohortRow[]
  computed_at: string | null
}

export const EMPTY_BOARD: NewCollectorsBoard = {
  summary: [],
  spend: [],
  gateway: {},
  cohorts: [],
  computed_at: null,
}

export const COVERAGE_NOTE =
  "Active buyers, returning buyers, market $ and composition (spend mix, gateway sets/players) are reliable for recent windows (~92% of active buyers captured). New-collector counts are a lower-confidence, directional metric — partial historical buyer coverage mislabels some returning collectors as new; the debiased count strips wallets seen selling before their first observed buy. These self-correct as deep-history buyer resolution backfills."

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function numOr0(v: unknown): number {
  return num(v) ?? 0
}

// `supabase` is the service-role client (typed any per the repo convention for
// API routes / server components).
export async function fetchNewCollectorsBoard(supabase: any): Promise<NewCollectorsBoard> {
  const [summary, spend, gateway, cohorts] = await Promise.all([
    supabase.from("mv_insights_new_collectors_summary").select("*"),
    supabase.from("mv_insights_new_collectors_spend").select("*"),
    supabase.from("mv_insights_new_collectors_gateway").select("*"),
    supabase
      .from("mv_insights_new_collectors_cohorts")
      .select("*")
      .order("cohort_month", { ascending: false }),
  ])

  const err = summary.error || spend.error || gateway.error || cohorts.error
  if (err) throw new Error(err.message)

  const summaryRows: NCSummaryRow[] = ((summary.data ?? []) as any[])
    .map((r) => ({
      window_label: String(r.window_label),
      days: numOr0(r.days),
      new_first_seen: numOr0(r.new_first_seen),
      new_debiased: numOr0(r.new_debiased),
      new_prior_period: numOr0(r.new_prior_period),
      active_buyers: numOr0(r.active_buyers),
      returning_buyers: numOr0(r.returning_buyers),
      market_usd: numOr0(r.market_usd),
      new_usd: numOr0(r.new_usd),
      median_first_buy: numOr0(r.median_first_buy),
      avg_first_buy: numOr0(r.avg_first_buy),
      computed_at: (r.computed_at as string) ?? null,
    }))
    .sort((a, b) => a.days - b.days)

  const spendRows: NCSpendRow[] = ((spend.data ?? []) as any[]).map((r) => ({
    window_label: String(r.window_label),
    b_lt5: numOr0(r.b_lt5),
    b_5_25: numOr0(r.b_5_25),
    b_25_100: numOr0(r.b_25_100),
    b_100_500: numOr0(r.b_100_500),
    b_500plus: numOr0(r.b_500plus),
    total_new: numOr0(r.total_new),
  }))

  const gw: Record<string, { sets: NCGatewayRow[]; players: NCGatewayRow[] }> = {}
  for (const raw of (gateway.data ?? []) as any[]) {
    const row: NCGatewayRow = {
      window_label: String(raw.window_label),
      kind: raw.kind === "set" ? "set" : "player",
      name: String(raw.name ?? ""),
      series: num(raw.series),
      buyers: numOr0(raw.buyers),
      rnk: numOr0(raw.rnk),
    }
    const w = (gw[row.window_label] ??= { sets: [], players: [] })
    ;(row.kind === "set" ? w.sets : w.players).push(row)
  }
  for (const w of Object.values(gw)) {
    w.sets.sort((a, b) => a.rnk - b.rnk)
    w.players.sort((a, b) => a.rnk - b.rnk)
  }

  const cohortRows: NCCohortRow[] = ((cohorts.data ?? []) as any[]).map((r) => ({
    cohort_month: String(r.cohort_month),
    cohort_size: numOr0(r.cohort_size),
    repeat_30d_pct: num(r.repeat_30d_pct),
    repeat_60d_pct: num(r.repeat_60d_pct),
    repeat_90d_pct: num(r.repeat_90d_pct),
    ltv_median: num(r.ltv_median),
    ltv_avg: num(r.ltv_avg),
    whales: numOr0(r.whales),
    median_days_to_10th: num(r.median_days_to_10th),
  }))

  const computedAt = summaryRows[0]?.computed_at ?? null

  return {
    summary: summaryRows,
    spend: spendRows,
    gateway: gw,
    cohorts: cohortRows,
    computed_at: computedAt,
  }
}
