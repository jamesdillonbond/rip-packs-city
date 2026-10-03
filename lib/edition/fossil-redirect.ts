// lib/edition/fossil-redirect.ts
//
// The 2026-09-08 cleanup purged the UUID-form Top Shot edition keys
// (`<setUUID>:<playUUID>`) from `editions`; the edition page has 404'd them
// since (`isTopShotFossilSlug`). Search Console (read 2026-10-03) still carries
// 285 of them as "Not found (404)" and 17 as "Duplicate, Google chose different
// canonical", crawled as recently as 09-21. `topshot_edition_uuid_redirects`
// (migration 20261003163012) maps the 4,447 fossils whose canonical
// `setID:playID` key is UNAMBIGUOUS (same set, player, name and subedition —
// exactly one candidate). This helper is the read; the page turns a hit into a
// 308 and a miss into the same notFound() as before.
//
// Honesty: a FAILED read must not become a 308 to a guessed page. On any error
// (timeout, pool blip) it returns null, which is the pre-existing 404 — an
// honest 404 on a purged key is the fallback, never a wrong redirect. The
// lookup is one primary-key probe through the service-role client (the table is
// RLS-enabled with no policies, the estate's deny-all shape), bounded by a
// short race so a stuck pool cannot hold the page.

import { supabaseAdmin } from "@/lib/supabase"

export const FOSSIL_REDIRECT_TIMEOUT_MS = 2_000

// `<uuid>:<uuid>` — the exact shape of the purged keys. Anything else is not a
// fossil this table can answer for (and must not be looked up).
const FOSSIL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isTopShotFossilKeyShape(decodedSlug: string): boolean {
  return FOSSIL_RE.test(decodedSlug)
}

/** The canonical `setID:playID` for a purged UUID-form Top Shot key, or null. */
export async function lookupTopShotFossilRedirect(decodedSlug: string): Promise<string | null> {
  if (!isTopShotFossilKeyShape(decodedSlug)) return null
  const key = decodedSlug.toLowerCase()
  try {
    const read = supabaseAdmin
      .from("topshot_edition_uuid_redirects")
      .select("canonical_slug")
      .eq("fossil_slug", key)
      .maybeSingle()
    const timeout = new Promise<{ data: null; error: { message: string } }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: { message: "fossil redirect lookup timed out" } }), FOSSIL_REDIRECT_TIMEOUT_MS),
    )
    const { data, error } = await Promise.race([read, timeout])
    if (error || !data) return null
    const canonical = (data as { canonical_slug?: unknown }).canonical_slug
    return typeof canonical === "string" && /^[0-9]+:[0-9]+$/.test(canonical) ? canonical : null
  } catch {
    return null
  }
}
