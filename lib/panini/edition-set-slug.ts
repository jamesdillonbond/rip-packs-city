// lib/panini/edition-set-slug.ts
//
// The set page a Panini edition links to (2026-10-21, #204). A Panini set NAME can span several
// products ("Base Prizms Blue": the 2026 World Cup catalog, 2022-23 Prizm Basketball, the 2022
// World Cup), so the name slug the edition RPC returns is the catalog product's page — for a
// Basketball edition, ANOTHER product's set. panini_edition_set_slug answers with the edition's
// own `sets` row's canonical slug (get_set_detail's own canonical_slug, so the link and the page
// cannot disagree). Server only.
//
// HONESTY: a failed read is `ok: false` and the page renders the set name UNLINKED — falling back
// to the name slug would swap the subject to a different product, not merely lose depth.

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

export interface PaniniEditionSetSlug {
  slug: string | null
  ok: boolean
}

export async function fetchPaniniEditionSetSlug(
  editionExternalId: string,
  db: any = supabaseAdmin, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<PaniniEditionSetSlug> {
  if (!editionExternalId) return { slug: null, ok: true }
  try {
    const { data, error } = await withQueryDeadline<unknown>(
      db.rpc("panini_edition_set_slug", { p_edition_external_id: editionExternalId }),
      "edition/panini-set-slug",
      apiReadTimeoutMs(),
    )
    if (error) return { slug: null, ok: false }
    if (data === null || data === undefined) return { slug: null, ok: true }
    if (typeof data !== "string") return { slug: null, ok: false }
    return { slug: data || null, ok: true }
  } catch {
    return { slug: null, ok: false }
  }
}
