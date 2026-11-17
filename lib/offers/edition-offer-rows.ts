// Row builder for the offers-sweep `edition_offers` upsert.
//
// ⛔ A value the sweep could not READ is OMITTED from the merge write, never
// sent as NULL (known-issues "Merge upserts fed by a degraded read", (d)).
// `set_uuid` / `play_uuid` come from the GQL row's set.id / play.id; when a row
// lacked them, the old builder sent `null`, and the ON CONFLICT DO UPDATE
// overwrote a UUID an earlier tick had stored — the UUIDs the
// topshot-deal-floor-serials cron needs for searchMintedMoments.byEditions.
//
// PostgREST's upsert only SETs the columns present in the payload, and a
// batch's columns are the UNION of its rows' keys (a key missing from one row is
// sent as NULL/default for that row). So rows are grouped by key SHAPE and each
// group is upserted on its own: a row without a UUID is in a batch whose payload
// has no such column, and its stored UUID survives.
//
// highest_offer / low_ask are deliberately NOT omitted when null: the sweep
// READ the edition and found no offer (or no ask) — that null is a measured
// absence, not an unread value.

export type OfferAcc = Map<
  string,
  { offer: number | null; ask: number | null; setUuid: string | null; playUuid: string | null }
>

export type EditionOfferRow = {
  collection_id: string
  external_id: string
  highest_offer: number | null
  low_ask: number | null
  set_uuid?: string
  play_uuid?: string
  updated_at: string
}

export function buildEditionOfferRows(acc: OfferAcc, collectionId: string, nowIso: string): EditionOfferRow[] {
  const rows: EditionOfferRow[] = []
  for (const [external_id, v] of acc.entries()) {
    if (v.offer == null && v.ask == null) continue
    const row: EditionOfferRow = {
      collection_id: collectionId,
      external_id,
      highest_offer: v.offer,
      low_ask: v.ask,
      updated_at: nowIso,
    }
    if (v.setUuid) row.set_uuid = v.setUuid
    if (v.playUuid) row.play_uuid = v.playUuid
    rows.push(row)
  }
  return rows
}

/** Batches of at most `size` rows, each batch holding rows with IDENTICAL key sets. */
export function upsertBatchesByShape<T extends object>(rows: T[], size: number): T[][] {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const shape = Object.keys(r).sort().join(",")
    const g = groups.get(shape)
    if (g) g.push(r)
    else groups.set(shape, [r])
  }
  const out: T[][] = []
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i += size) out.push(g.slice(i, i + size))
  }
  return out
}
