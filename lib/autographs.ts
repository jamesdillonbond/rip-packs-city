// lib/autographs.ts
//
// Which editions are SIGNED. Source: editions.autographed_at, written from Atlas
// `autographedAt` by the pg_cron sweep autograph_sweep_tick (migration
// 20261020030228; census in docs/research/autographs-topshot-allday-2026-10-19.md).
//
// ⚠ Signing is per EDITION, not per set or parallel: on Series 8 Rookie Debut the
// Hardcourt /50 is signed for 27 players and unsigned for 34. Never infer it from a
// set name, a parallel name or a price — read the column.
//
// ⚠ THREE STATES. `autographed_at` NULL means "unsigned OR never checked"; only
// edition_autograph_checks can say "verified unsigned". So these helpers make
// POSITIVE claims only. A failed read returns `ok: false`, never an empty set — an
// empty set would read as "nothing on this board is signed", and with an
// autographs-only filter on it would silently empty the board.

import { boundedRead } from "@/lib/api/bounded-read"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

export const AUTOGRAPH_BADGE_SLUG = "autograph"
export const AUTOGRAPH_BADGE_TITLE = "Autographed"

const TOPSHOT_ID = COLLECTION_UUID_BY_SLUG["nba-top-shot"]
const ALLDAY_ID = COLLECTION_UUID_BY_SLUG["nfl-all-day"]

export type AutographRead<T> = { ok: true; value: T } | { ok: false; error: string }

type SupaLike = { from: (table: string) => any }

/**
 * Signed edition count is ~240 per collection. PostgREST CLAMPS any read at 1000 rows
 * (an explicit larger .limit() is silently cut), so one page is the most a read can
 * return, and a FULL page is refused as possibly partial.
 */
const SIGNED_PAGE = 1000

async function readSigned(
  supa: SupaLike,
  collectionId: string,
  columns: string,
  label: string,
): Promise<AutographRead<any[]>> {
  const { data, error } = await boundedRead(
    supa
      .from("editions")
      .select(columns)
      .eq("collection_id", collectionId)
      .not("autographed_at", "is", null)
      .order("id", { ascending: true })
      .limit(SIGNED_PAGE),
    label,
  )
  if (error) return { ok: false, error: String(error?.message ?? error?.code ?? "unknown error") }
  const rows = (data ?? []) as any[]
  // A full page means there may be more: refuse rather than return a partial set.
  if (rows.length >= SIGNED_PAGE) return { ok: false, error: `signed editions exceed one ${SIGNED_PAGE}-row page` }
  // The filter is re-checked on the row itself, so a signed claim never rests on a
  // predicate that was dropped somewhere between here and the database.
  return { ok: true, value: rows.filter((x) => x?.autographed_at != null) }
}

/**
 * External ids of signed NBA Top Shot editions. Parallel editions carry their own
 * key ("219:7408::18" = Flagg's Rookie Debut Hardcourt), so look up the PARALLEL key
 * first; the base key ("219:7408") is signed only when the Standard printing is.
 */
/** Never throws: a builder or network fault is a FAILED read, reported as one. */
async function guarded<T>(read: () => Promise<AutographRead<T>>): Promise<AutographRead<T>> {
  try {
    return await read()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchTopShotAutographedKeys(
  supa: SupaLike,
  label = "autographs/topshot",
): Promise<AutographRead<Set<string>>> {
  return guarded(async () => {
    const r = await readSigned(supa, TOPSHOT_ID, "external_id, autographed_at", label)
    if (!r.ok) return r
    return {
      ok: true as const,
      value: new Set(r.value.map((x) => String(x.external_id ?? "").trim()).filter(Boolean)),
    }
  })
}

export function allDayPairKey(playerName: string | null | undefined, setName: string | null | undefined): string {
  return `${(playerName ?? "").trim().toLowerCase()}|${(setName ?? "").trim().toLowerCase()}`
}

/**
 * NFL All Day sniper rows carry no edition key (get_allday_sniper_deals returns the
 * NFT id), so they are matched on player + set. A pair counts as signed ONLY when
 * every edition of that pair is signed: a pair holding both a signed and an unsigned
 * edition (0 today, measured 2026-10-19) is left unclaimed rather than guessed.
 */
export async function fetchAllDayAutographedPairs(
  supa: SupaLike,
  label = "autographs/allday",
): Promise<AutographRead<Set<string>>> {
  return guarded(() => readAllDayPairs(supa, label))
}

async function readAllDayPairs(supa: SupaLike, label: string): Promise<AutographRead<Set<string>>> {
  const signed = await readSigned(supa, ALLDAY_ID, "player_name, set_name, autographed_at", label)
  if (!signed.ok) return signed
  const sets = [...new Set(signed.value.map((x) => String(x.set_name ?? "")).filter(Boolean))]
  if (sets.length === 0) return { ok: true, value: new Set() }
  const { data, error } = await boundedRead(
    supa
      .from("editions")
      .select("player_name, set_name, autographed_at")
      .eq("collection_id", ALLDAY_ID)
      .in("set_name", sets)
      .order("id", { ascending: true })
      .limit(SIGNED_PAGE),
    `${label}#pairs`,
  )
  if (error) return { ok: false, error: String(error?.message ?? error?.code ?? "unknown error") }
  const rows = (data ?? []) as any[]
  if (rows.length >= SIGNED_PAGE) return { ok: false, error: `signed-set editions exceed one ${SIGNED_PAGE}-row page` }
  const state = new Map<string, boolean>()
  for (const row of rows) {
    const key = allDayPairKey(row.player_name, row.set_name)
    const isSigned = row.autographed_at != null
    state.set(key, (state.get(key) ?? true) && isSigned)
  }
  return { ok: true, value: new Set([...state].filter(([, allSigned]) => allSigned).map(([k]) => k)) }
}

/** Add the autograph slug to a badge-slug list (idempotent, autograph first). */
export function withAutographSlug(slugs: readonly string[], signed: boolean): string[] {
  if (!signed) return [...slugs]
  return [AUTOGRAPH_BADGE_SLUG, ...slugs.filter((s) => s !== AUTOGRAPH_BADGE_SLUG)]
}
