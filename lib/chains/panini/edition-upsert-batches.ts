// Split panini_editions rows into upsert batches of ONE row shape each (2026-11-22).
//
// A bulk upsert through supabase-js sends the UNION of every row's keys and writes NULL for a key a
// row lacks (`defaultToNull`). panini_editions rows omit `nation` (the printed team) when the payload
// did not carry it, so a mixed batch would overwrite stored teams with NULL — the defect that left
// 8.6–12.2 % of Basketball / Soccer / Football editions with a team. Grouping by the sorted key set
// means a batch without `nation` never names the column at all. Order within a shape is kept; each
// shape is chunked at `chunk`.
export function editionUpsertBatches<T extends Record<string, unknown>>(rows: T[], chunk: number): T[][] {
  const size = Number.isFinite(chunk) && chunk > 0 ? Math.floor(chunk) : 1
  const byShape = new Map<string, T[]>()
  for (const r of rows) {
    const shape = Object.keys(r).sort().join(",")
    const group = byShape.get(shape)
    if (group) group.push(r)
    else byShape.set(shape, [r])
  }
  const out: T[][] = []
  for (const group of byShape.values()) {
    for (let i = 0; i < group.length; i += size) out.push(group.slice(i, i + size))
  }
  return out
}
