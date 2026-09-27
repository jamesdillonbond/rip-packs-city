// lib/pinnacle/edition-types.ts
//
// Moved verbatim from app/api/pinnacle-wallet/route.ts (2026-09-27) so the
// shared Collection tab's route (/api/collection-moments) can answer the same
// "is this pin's edition serialised?" question once Pinnacle moved onto the
// shared page. The label is the only change: it names the calling route in
// boundedRead's diagnostics.
import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"

// pinnacle_editions lookup used only to answer "is this edition type serialised?".
type EditionTypeClient = {
  from: (table: string) => {
    select: (cols: string) => {
      in: (col: string, vals: string[]) => Promise<{ data: unknown; error: { message: string } | null }>
    }
  }
}

/**
 * edition_key -> edition_type for the editions this wallet actually holds.
 *
 * WHY: most Pinnacle editions are not serialised at all, but the wallet RPC does
 * not carry edition_type, so the table rendered a bare em-dash for every holding
 * of an unserialised edition -- indistinguishable from "we failed to index the
 * serial". Serialisation is a property of the edition TYPE (measured 2026-08-02:
 * not one Pinnacle edition is mixed), so one small keyed lookup is enough to tell
 * the two apart. Kept in the route rather than pushed into
 * get_wallet_moments_with_fmv on purpose: that RPC is a hot cross-collection read
 * and this is a presentation concern.
 *
 * Fails SOFT -- on any error we return an empty map, every row falls back to
 * `edition_type: null`, and the table renders exactly as it does today.
 */
export async function fetchEditionTypes(editionKeys: string[], label = "api/pinnacle-wallet"): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const keys = editionKeys.filter((k): k is string => typeof k === "string" && k.length > 0)
  if (keys.length === 0) return out
  // Chunked so the PostgREST request URL cannot blow its length cap on a big wallet.
  const CHUNK = 120
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    try {
      const { data, error } = await boundedRead((supabaseAdmin as unknown as EditionTypeClient)
        .from("pinnacle_editions")
        .select("edition_key, edition_type")
        .in("edition_key", slice), `${label}/pinnacle_editions`)
      if (error || !Array.isArray(data)) continue
      for (const row of data as Array<{ edition_key?: unknown; edition_type?: unknown }>) {
        if (typeof row?.edition_key === "string" && typeof row?.edition_type === "string") {
          out.set(row.edition_key, row.edition_type)
        }
      }
    } catch {
      // Soft-fail this chunk; the rows it would have covered stay "cannot say".
    }
  }
  return out
}
