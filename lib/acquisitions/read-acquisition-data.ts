// lib/acquisitions/read-acquisition-data.ts
//
// 2026-11-14 — get_wallet_acquisition_data_scoped returns ONE row per moment (DISTINCT ON nft_id),
// and PostgREST clamps a set-returning RPC's result at 1,000 rows with no error and no signal
// (docs/reference: "PostgREST caps reads at 1000 rows"). /api/cost-basis sent all 14,888 of a
// founder wallet's moment ids in one call: 1,000 came back with their acquisition_method and
// 13,888 were silently method-less, so the Collection tab lost the "Loan Default" label and the
// trusted P&L basis ("Bought"/"Loan") for everything past the first thousand.
//
// This reads in chunks no larger than the clamp, so no chunk can be truncated. A chunk that
// returns exactly the clamp is reported (it would mean the one-row-per-moment premise broke).
// Any failed chunk fails the whole read — a partial map published as the complete one is the
// paged-read-that-breaks-on-error defect (CLAUDE.md, "A PAGED read").

export const ACQUISITION_CHUNK = 500
const POSTGREST_MAX_ROWS = 1000

export type AcquisitionDataRow = {
  moment_id: string
  acquisition_method: string  // NOT NULL in moment_acquisitions
  buy_price: number | null
  loan_principal: number | null
  acquired_date?: string | null
  source_wallet?: string | null
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export async function readAcquisitionData(
  client: RpcClient,
  wallet: string,
  momentIds: readonly string[],
  collectionId: string | null,
  chunkSize: number = ACQUISITION_CHUNK,
): Promise<{ rows: AcquisitionDataRow[]; error: string | null }> {
  const ids = Array.from(new Set(momentIds.filter(Boolean)))
  const size = Math.max(1, Math.min(chunkSize, POSTGREST_MAX_ROWS))
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  const rows: AcquisitionDataRow[] = []
  // Bounded concurrency: a 15k-moment wallet is 30 chunks; 4 at a time keeps the read short
  // without fanning 30 statements at the pool at once.
  const CONCURRENCY = 4
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(function(chunk) {
      return client.rpc("get_wallet_acquisition_data_scoped", {
        p_wallet: wallet,
        p_moment_ids: chunk,
        p_collection_id: collectionId,
      })
    }))
    for (const r of results) {
      if (r.error) return { rows: [], error: r.error.message }
      const data = Array.isArray(r.data) ? (r.data as AcquisitionDataRow[]) : []
      if (data.length >= POSTGREST_MAX_ROWS) {
        console.warn(`[readAcquisitionData] a chunk returned ${data.length} rows — at the PostgREST clamp; rows may be missing`)
      }
      rows.push(...data)
    }
  }
  return { rows, error: null }
}
