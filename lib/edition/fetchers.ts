// lib/edition/fetchers.ts
//
// The edition page's two PostgREST TABLE reads, extracted out of
// app/(collections)/[collection]/edition/[slug]/page.tsx.
//
// WHY THEY MOVED. Two reasons, and they turned out to be the same edit:
//
//  1. They were the page's LAST unbounded data access. The 2026-08-13 fix routed
//     every `.rpc()` in the edition shell through `rpcWithRetry`, which carries a
//     45 s wall-clock budget — but `rpcWithRetry` is RPC-shaped and cannot take a
//     `.from()` builder, so these two stayed bare. Both are live production error
//     sources ("Timed out acquiring connection from connection pool", 19 events
//     for provenance and 5 for usernames), so the connection they use is
//     demonstrably one that can stall. They now go through `withQueryDeadline`.
//
//  2. They were the page's only `@/lib/supabase` import, which is what put it on
//     `__tests__/server-page-data-access-ratchet.test.ts`'s list of server pages
//     querying the DB inline — the largest surface neither coverage gate measures.
//     Extracting them takes the page off that list and makes these reads testable.
//
// ⚠ BOTH FAIL SOFT BY DESIGN, and that is correct HERE — do not "fix" it into a
// thrown error. Unlike the honesty defects this repo keeps re-finding, neither
// failure renders a FALSE CLAIM:
//   • provenance renders only when `pack_pulls_observed > 0`, so a failed read
//     HIDES a supplementary section — it never claims "0 pulls";
//   • usernames fall back to the raw wallet address, which is still true.
// They are omissions, not assertions. `ok` is returned anyway so a caller that
// wants to distinguish "no data" from "we could not read" can, and so the
// distinction is available if either ever moves above the fold.

import { supabaseAdmin } from "@/lib/supabase"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

/** Minimal shape used from the Supabase client, so tests can inject a stub. */
export type TableClient = {
  from: (table: string) => unknown
}

export interface PackProvenanceRow {
  pack_pulls_observed: number | null
  distinct_packs: number | null
  observed_pull_share_pct: number | null
  first_pull_at: string | null
  last_pull_at: string | null
}

/** `ok` is FALSE only when the read itself failed — not when it found nothing. */
export interface FetchResult<T> {
  data: T
  ok: boolean
}

function client(injected?: TableClient): TableClient {
  return injected ?? (supabaseAdmin as unknown as TableClient)
}

/**
 * Pack provenance — what share of this edition's circulation we have observed
 * being pulled from packs. Top Shot and All Day read different views.
 */
export async function fetchPackProvenance(
  editionId: string,
  isAllDay: boolean,
  injected?: TableClient,
): Promise<FetchResult<PackProvenanceRow | null>> {
  const view = isAllDay
    ? "v_allday_edition_pull_provenance"
    : "v_topshot_edition_pull_provenance"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = (client(injected).from(view) as any)
    .select(
      "pack_pulls_observed, distinct_packs, observed_pull_share_pct, first_pull_at, last_pull_at",
    )
    .eq("edition_id", editionId)
    .maybeSingle()

  const { data, error } = await withQueryDeadline<PackProvenanceRow>(
    builder,
    "edition pack provenance",
  )
  if (error) {
    console.error("[edition] pack provenance", error.message)
    return { data: null, ok: false }
  }
  return { data: (data ?? null) as PackProvenanceRow | null, ok: true }
}

/**
 * Resolve owner wallet addresses → @username so the server-rendered Special
 * Serials owner cell matches the client-resolved Recent Sales rows.
 */
export async function fetchOwnerUsernames(
  addresses: string[],
  injected?: TableClient,
): Promise<FetchResult<Map<string, string>>> {
  const out = new Map<string, string>()
  const lowered = Array.from(
    new Set(addresses.filter(Boolean).map((a) => a.toLowerCase())),
  )
  // No addresses is a legitimate empty answer, not a failed read — and it must
  // NOT issue a query, because `.in()` on an empty list is a pointless round
  // trip against the pool this whole change exists to stop pressuring.
  if (lowered.length === 0) return { data: out, ok: true }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = (client(injected).from("wallet_usernames") as any)
    .select("wallet_addr, username")
    .in("wallet_addr", lowered)
    .not("username", "is", null)

  const { data, error } = await withQueryDeadline<
    Array<{ wallet_addr: string; username: string | null }>
  >(builder, "edition owner usernames")
  if (error) {
    console.error("[edition] owner_usernames", error.message)
    return { data: out, ok: false }
  }
  for (const r of (data ?? []) as Array<{
    wallet_addr: string
    username: string | null
  }>) {
    if (r.wallet_addr && r.username) out.set(r.wallet_addr.toLowerCase(), r.username)
  }
  return { data: out, ok: true }
}
