// lib/moment/resolve-moment-id.ts
//
// The `/moment/[id]` layout's ONE data read, lifted out of the layout so a test
// can drive it. Extracted 2026-08-17 for the reason the server-page ratchet's
// header gives for every extraction on its list: moving the code somewhere a
// test can reach it is how you pin a contract, and the contract here is one the
// comment asserted and nothing checked.
//
// ⚠ THE CONTRACT IS FAIL-OPEN, AND IT IS NOT COSMETIC. `/moment/[id]` is an
// SEO-indexed surface. If a transient RPC failure were allowed to resolve as
// "no such moment", the layout would call notFound() on a moment that exists
// and invite Google to drop a live URL from the index — a failed read rendered
// as a fact about our catalogue, in the sub-class that costs the most to undo.
// So an unreadable answer resolves OPEN and the page renders its own soft
// not-found instead.
//
// ⚠ THREE STATES, NOT TWO. `resolves` alone cannot distinguish "the id is real"
// from "we could not tell", and collapsing them is exactly the defect above. The
// caller gets `degraded` beside it so a future consumer that needs to say
// something honest to the user can, without re-deriving what was lost here.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { momentCanonicalPath } from "@/lib/moment-detail-seo"

export type MomentIdResolution = {
  /** False ONLY on a successful read that returned nothing. Fail-open otherwise. */
  resolves: boolean
  /** True when the read itself failed — `resolves` is then a fallback, not a finding. */
  degraded: boolean
  /** Present only when degraded; the upstream message, for logging. */
  reason?: string
  /**
   * Set when the resolver's OWN verdict is `kind = 'edition'` — the URL named an
   * edition (aggregate grain), not one serial. Absent for a serial-specific
   * moment, a Pinnacle edition, a miss, and a degraded read.
   */
  edition?: { editionId: string; collectionSlug: string }
}

/** Minimal shape so a test can inject without dragging in the whole client type. */
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }

export async function resolveMomentId(
  id: string,
  client: RpcClient = supabaseAdmin as unknown as RpcClient,
): Promise<MomentIdResolution> {
  try {
    // ⚠ BOUNDED 2026-08-22. A read that merely HANGS errors nowhere, so without
    // this the `catch` below — and the degraded result it produces — were
    // unreachable from the failure mode that actually took /overview down on
    // 2026-08-22 ("Timed out acquiring connection from connection pool"). The
    // budget REJECTS, which lands in that existing catch: no new failure policy.
    const { data, error } = await withBoardBudget(
      client.rpc("resolve_moment_id", { p_id: id }),
      `moment/resolve-moment-id ${id}`,
      undefined,
      "",
    )
    if (error) {
      // supabase-js RETURNS this rather than throwing, so the catch below never
      // sees it. Handling only the throw would leave the branch that actually
      // fires in production unhandled.
      return { resolves: true, degraded: true, reason: error.message }
    }
    const row = Array.isArray(data) ? data[0] : data
    const edition = editionGrainOf(row)
    return {
      resolves: Array.isArray(data) ? data.length > 0 : data != null,
      degraded: false,
      ...(edition ? { edition } : {}),
    }
  } catch (err) {
    return { resolves: true, degraded: true, reason: err instanceof Error ? err.message : String(err) }
  }
}

function editionGrainOf(row: unknown): MomentIdResolution["edition"] | undefined {
  if (!row || typeof row !== "object") return undefined
  const r = row as { kind?: unknown; edition_id?: unknown; collection_slug?: unknown }
  if (r.kind !== "edition") return undefined
  if (typeof r.edition_id !== "string" || typeof r.collection_slug !== "string") return undefined
  return { editionId: r.edition_id, collectionSlug: r.collection_slug }
}

/** Minimal shape for the one-column edition read below. */
type EditionReadClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>
      }
    }
  }
}

// ── The edition-grain 301 (2026-09-06, Search Console) ─────────────────────
//
// /moment/<edition uuid> is the edition page under another URL — same data,
// same components, a canonical pointing there since 06-05 — and Google still
// crawled ~11,000 of them into the not-indexed buckets. A redirect in the PAGE
// cannot fix that: this segment ships a loading.tsx, so the shell has already
// gone out as 200 by the time the page runs and the redirect degrades to a
// streamed `<meta http-equiv="refresh">` (measured live on fd65daa: 200 +
// NEXT_REDIRECT row, no Location header). The layout is awaited before the
// first flush — the same reason the 404 lives there — so the redirect decided
// HERE is a real 308 with a Location header.
//
// The canonical edition slug is `external_id` (Pinnacle keys on the uuid, but a
// Pinnacle id resolves as `pinnacle_edition`, never `edition`, so it never
// reaches this). That is one more column than resolve_moment_id returns, hence
// the PK lookup. ⚠ FAIL-OPEN, like everything on this surface: a failed or
// empty read returns null and the page renders (with its own backstop
// redirect); it never 404s and never redirects to a guessed slug.
export async function editionGrainRedirectTarget(
  id: string,
  resolution: MomentIdResolution,
  client: EditionReadClient = supabaseAdmin as unknown as EditionReadClient,
): Promise<string | null> {
  const ed = resolution.edition
  if (!ed) return null
  try {
    const { data, error } = await withBoardBudget(
      Promise.resolve(client.from("editions").select("external_id").eq("id", ed.editionId).maybeSingle()),
      `moment/edition-canonical ${id}`,
      undefined,
      "",
    )
    if (error || !data || typeof data !== "object") return null
    const externalId = (data as { external_id?: unknown }).external_id
    const target = momentCanonicalPath({
      collectionSlug: ed.collectionSlug,
      editionId: ed.editionId,
      externalId: typeof externalId === "string" ? externalId : null,
      momentUrlId: id,
    })
    return target === `/moment/${encodeURIComponent(id)}` ? null : target
  } catch {
    return null
  }
}
