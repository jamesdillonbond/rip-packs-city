// Top Shot parallel (subedition) names — the ONE source in code (2026-10-28).
//
// public.topshot_subeditions holds TopShot.getAllSubeditions() from the chain and is kept current by the
// pg_cron lane rpc-topshot-subeditions-refresh. Three hardcoded copies of this list had gone stale (the
// newest knew 1–22; the chain has 24 since Animated / Illustrated), and their fallback INVENTED a name —
// "Parallel 23" — that an edition upsert would then write over the real one. A name we do not know is
// ABSENT (null), never made up.

import { supabaseAdmin } from "@/lib/supabase"

export type SubeditionNames = ReadonlyMap<number, string>

/** id → name, or `{ ok: false }` when the read failed (callers then write no name at all). */
export async function loadTopshotSubeditionNames(
  db: { from: (t: string) => any } = supabaseAdmin as any,
): Promise<{ ok: true; names: SubeditionNames } | { ok: false; error: string }> {
  try {
    const { data, error } = await db.from("topshot_subeditions").select("subedition_id, name")
    if (error) return { ok: false, error: String(error.message ?? error) }
    const names = new Map<number, string>()
    for (const r of (data as { subedition_id: number; name: string }[] | null) ?? []) {
      if (Number.isInteger(r.subedition_id) && r.name) names.set(r.subedition_id, r.name)
    }
    if (names.size === 0) return { ok: false, error: "topshot_subeditions returned no rows" }
    return { ok: true, names }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** The parallel's name, or null when it is not known. Never "Parallel N". */
export function subeditionName(names: SubeditionNames | null | undefined, id: number): string | null {
  return names?.get(id) ?? null
}
