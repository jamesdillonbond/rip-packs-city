// ⛔ A value a writer could not READ is OMITTED from a merge upsert, never sent
// as NULL (known-issues "Merge upserts fed by a degraded read"): ON CONFLICT DO
// UPDATE would otherwise overwrite the stored value with the failure. PostgREST
// only SETs the columns a payload carries, so dropping the key keeps it.
// Only for SINGLE-row payloads — in a batch, the column set is the union of the
// rows' keys, and a row missing one is sent NULL (see lib/offers/edition-offer-rows.ts).
export function omitUnread<T extends Record<string, unknown>>(row: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = { ...row }
  for (const k of keys) if (out[k] == null) delete out[k]
  return out
}
