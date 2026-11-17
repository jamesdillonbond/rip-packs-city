// lib/edition/legacy-redirect.ts
//
// Resolve a legacy flat `/edition/<uuid>` link to its canonical nested path.
//
// ⚠ WHY THE `ok` FLAG MATTERS MORE HERE THAN ON A NORMAL PAGE. This route
// exists ONLY to catch LEGACY inbound links — old shares, DMs, and anything a
// crawler already indexed under the flat URL. The page collapsed a failed read
// into the not-found branch (`if (error || !data) notFound()`), so a statement
// timeout handed a hard 404 for an edition that exists, to precisely the
// audience least likely to try again and most likely to record the 404.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LegacyEditionTarget {
  externalId: string
  collectionDbSlug: string
}

export interface LegacyEditionLookup {
  target: LegacyEditionTarget | null
  /**
   * ⚠ false ONLY when the read failed. A uuid that matches no edition is
   * `{ target: null, ok: true }` and must still 404 — otherwise no bad legacy
   * URL would ever 404 again, which is the mirror-image defect.
   */
  ok: boolean
}

/**
 * Look up the canonical `(external_id, collection slug)` for a legacy uuid.
 *
 * A row that exists but is missing either field is treated as a MISS rather
 * than a failure: we asked and got an answer, and there is no canonical path to
 * redirect to. Reporting it as a failure would make an un-redirectable edition
 * retry forever behind an error boundary.
 */
export async function lookupLegacyEdition(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<LegacyEditionLookup> {
  // ⚠ BOUNDED 2026-08-22, and the try/catch is part of the same change rather
  // than incidental: this function had an `if (error)` branch but no catch, so
  // a rejecting budget would have propagated to an error boundary — turning a
  // slow page into a broken one, which is worse than slow. The catch maps a
  // hang onto the SAME `{ ok: false }` an errored read already produced.
  let data: unknown
  let error: { message: string } | null = null
  try {
    // The supabase query builder is a THENABLE, not a Promise, so the generic
    // infers `unknown` through it and `data`/`error` stop existing. Name it.
    ;({ data, error } = await withBoardBudget<{ data: unknown; error: { message: string } | null }>(
      db
        .from("editions")
        .select("external_id, collections!inner(slug)")
        .eq("id", id)
        .maybeSingle(),
      `edition/legacy-redirect ${id}`,
      undefined,
      "",
    ))
  } catch (e) {
    console.error("[edition/legacy-redirect] lookup failed", e instanceof Error ? e.message : e)
    return { target: null, ok: false }
  }
  if (error) {
    console.error("[edition/legacy-redirect] lookup error", error.message)
    return { target: null, ok: false }
  }
  const row = data as { external_id?: string | null; collections?: { slug?: string } | null } | null
  const externalId = row?.external_id
  const slug = row?.collections?.slug
  if (!externalId || !slug) return { target: null, ok: true }
  return { target: { externalId, collectionDbSlug: slug }, ok: true }
}
