// lib/edition/alias-redirect.ts
//
// #175 (2026-10-10): some Top Shot edition keys are ALIASES of another key —
// Top Shot's API names the 2023-24 Honors (Diced) printing `149:<play>::8` while
// the chain mints it as `152:<play>`, and the 25 alias `editions` rows exist (a
// FK target of archived offers and FMV history) with nothing of their own. A
// visitor landing on an alias URL (an old link, a crawler, the API key typed
// in) must see the one page that holds the sales, the owners and the market:
// this helper reads `public.topshot_edition_aliases` (migration 20261010155627,
// the one alias point every API-facing writer also resolves through) and the
// edition page turns a hit into a 308.
//
// Honesty: a FAILED read must not become a 308 to a guessed page, and must not
// become a 404 either — the alias edition exists. On any error or timeout it
// returns null and the page renders the alias as before (honest, ask-less).
// The lookup is one primary-key probe through the service-role client (the
// table is RLS-enabled with no policies), bounded by the estate's shared
// board budget so a stuck pool cannot hold the page.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

export const ALIAS_REDIRECT_TIMEOUT_MS = 2_000

// The integer-pair key shapes an alias can take: `set:play` or `set:play::sub`.
// Anything else (a purged UUID pair, a hostile string) never touches the DB.
const KEY_RE = /^[0-9]{1,9}:[0-9]{1,9}(::[0-9]{1,6})?$/

export function isTopShotEditionKeyShape(decodedSlug: string): boolean {
  return KEY_RE.test(decodedSlug)
}

/** The canonical key for a Top Shot alias edition key, or null (not an alias, or the read failed). */
export async function lookupTopShotEditionAliasRedirect(decodedSlug: string): Promise<string | null> {
  if (!isTopShotEditionKeyShape(decodedSlug)) return null
  try {
    const { data, error } = await withBoardBudget(
      Promise.resolve(
        supabaseAdmin
          .from("topshot_edition_aliases")
          .select("canonical_external_id")
          .eq("alias_external_id", decodedSlug)
          .maybeSingle(),
      ),
      "alias-redirect",
      ALIAS_REDIRECT_TIMEOUT_MS,
      "edition/",
    )
    if (error || !data) return null
    const canonical = (data as { canonical_external_id?: unknown }).canonical_external_id
    return typeof canonical === "string" && KEY_RE.test(canonical) && canonical !== decodedSlug ? canonical : null
  } catch {
    return null
  }
}
