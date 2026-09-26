// lib/fmv-candy-ceiling.ts
//
// Candy MLB's live cheapest ask, fed into fmv-recalc's ask-CEILING (the rule,
// Trevor 2026-08-07: a sales-derived base FMV must not exceed the cheapest
// current ask — "a base FMV above buy-it-now is a confident wrong number that
// fabricates deals"). Top Shot (edition_offers.low_ask) and All Day
// (allday_edition_floor_ask) have fed that ceiling since August; Candy never
// did, so nothing capped it.
//
// Measured 2026-09-25 ~11:15 PM PT: 56 of 123 Candy editions with a confirmed
// ask carried an FMV above 1.5× it. Worst: Munetaka Murakami Green LEGENDARY,
// FMV $584.48 at MEDIUM against a $66.50 ask seen in the last 12 h — the FMV is
// the mean of three early-August launch sales ($732 / $724 / $297); the two
// most recent sales ($194, $203) had been discarded as outliers.
//
// Source: `candy_listing_floor.confirmed_floor_usd` — the cheapest active ask
// seen in the last 12 h, troll-filtered (asks above 10× the edition's FMV or
// its tier median are excluded). The confirmed column, not `floor_usd`, so a
// listing the indexer has stopped seeing cannot cap anything.
//
// Failure is not silent and not destructive: a failed chunk leaves those
// editions uncapped (the pre-existing behaviour, same as the All Day feed) and
// the error is returned so the run can record it beside its count.

type SupabaseLike = {
  // The real client's builder generics do not fit a narrower structural type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any
}

export type CandyCeilingResult = {
  floors: Map<string, number>
  error: string | null
}

export async function fetchCandyConfirmedFloors(
  supabase: SupabaseLike,
  editionIds: string[],
  chunkSize = 500,
): Promise<CandyCeilingResult> {
  const floors = new Map<string, number>()
  let error: string | null = null
  for (let i = 0; i < editionIds.length; i += chunkSize) {
    const slice = editionIds.slice(i, i + chunkSize)
    try {
      const { data, error: err } = await supabase
        .from("candy_listing_floor")
        .select("edition_id, confirmed_floor_usd")
        .in("edition_id", slice)
        .gt("confirmed_floor_usd", 0)
      if (err) {
        error = `chunk ${i}: ${err.message ?? String(err)}`
        continue
      }
      for (const row of (data ?? []) as Array<{ edition_id: unknown; confirmed_floor_usd: unknown }>) {
        const ask = Number(row.confirmed_floor_usd)
        if (!(ask > 0) || !Number.isFinite(ask)) continue
        floors.set(String(row.edition_id), ask)
      }
    } catch (e) {
      error = `chunk ${i}: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { floors, error }
}

/** Merge asks into a ceiling map, keeping the LOWER ask on a collision. */
export function mergeCeilingAsks(target: Map<string, number>, asks: Map<string, number>): void {
  for (const [edId, ask] of asks) {
    const prior = target.get(edId)
    target.set(edId, prior != null ? Math.min(prior, ask) : ask)
  }
}
