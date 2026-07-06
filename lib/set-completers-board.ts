// lib/set-completers-board.ts
//
// Shared fetch + shape for the public Set Completers insights surface. Reads the
// rookie-scoped set-completion aggregate via get_topshot_set_completers() -> the
// materialized view topshot_set_completers_mv, refreshed daily by the pg_cron job
// rpc-refresh-set-completers. Built off the Dune-sourced TopShot ownership index
// (topshot_ownership); the MV carries no wallet addresses so it is anon-readable.
//
// "Completion" = base-play: a collector completes a set by owning >=1 of every
// base play in it (parallels ignored), matching Top Shot's own set-completion
// counts. Both the server page (initialBoard) and the /api/public route call this
// so the page HTML and the JSON API never diverge.

export interface SetCompleterRow {
  set_id_onchain: number
  set_name: string
  total_plays: number
  completers: number
  holders_with_any: number
  // completers as a share of collectors who hold at least one play in the set
  completion_rate: number
}

export interface SetCompletersBoard {
  rows: SetCompleterRow[]
}

export const EMPTY_BOARD: SetCompletersBoard = { rows: [] }

export const METHOD_NOTE =
  "Completion is base-play: a collector completes a set by owning at least one of every base play in it (parallels ignored), matching Top Shot's own set-completion counts. Ownership is the indexed on-chain holder graph for the 2025 rookie sets, refreshed daily. Parent and child Dapper wallets are collapsed to one collector."

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// `supabase` is the service-role client (typed any per the repo convention for
// API routes / server components).
export async function fetchSetCompletersBoard(supabase: any): Promise<SetCompletersBoard> {
  const { data, error } = await supabase.rpc("get_topshot_set_completers")
  if (error) throw new Error(error.message)
  const rows: SetCompleterRow[] = ((data ?? []) as any[])
    .map((r) => {
      const completers = num(r.completers)
      const holders = num(r.holders_with_any)
      return {
        set_id_onchain: num(r.set_id_onchain),
        set_name: String(r.set_name ?? ""),
        total_plays: num(r.total_plays),
        completers,
        holders_with_any: holders,
        completion_rate: holders > 0 ? completers / holders : 0,
      }
    })
    .sort((a, b) => b.completers - a.completers || b.total_plays - a.total_plays)
  return { rows }
}
