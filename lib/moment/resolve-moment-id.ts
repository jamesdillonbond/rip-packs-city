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

export type MomentIdResolution = {
  /** False ONLY on a successful read that returned nothing. Fail-open otherwise. */
  resolves: boolean
  /** True when the read itself failed — `resolves` is then a fallback, not a finding. */
  degraded: boolean
  /** Present only when degraded; the upstream message, for logging. */
  reason?: string
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
    return { resolves: Array.isArray(data) ? data.length > 0 : data != null, degraded: false }
  } catch (err) {
    return { resolves: true, degraded: true, reason: err instanceof Error ? err.message : String(err) }
  }
}
