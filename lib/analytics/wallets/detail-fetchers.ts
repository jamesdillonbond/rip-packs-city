// lib/analytics/wallets/detail-fetchers.ts
//
// The three database reads behind /analytics/wallets/[address], extracted from
// that page so a coverage gate can see them.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// This is the FIFTH instance of "a failed read renders as an answer" found on a
// server page, and the reason it survived four previous sweeps is worth more
// than the fix itself:
//
//   • THE GUARD'S CASE IS NAMED FOR A DIFFERENT PAGE. The existing case in
//     __tests__/server-pages-error-vs-absent-guard.test.ts is titled
//     "analytics/wallets does not report a failed read as 'no activity'" and
//     reads `app/(analytics)/analytics/wallets/page.tsx` — the DIRECTORY INDEX.
//     The detail page one segment down, `wallets/[address]/page.tsx`, was never
//     in it. lib/analytics/sets/detail-fetchers.ts even cites "/analytics/wallets"
//     as already-pinned, which reads as covering this page and does not. A guard
//     that is an ALLOWLIST fails silently when two pages share a path prefix.
//
//   • ERROR IS NOT ABSENCE. `loadWallet` returned a bare `null` for BOTH "no such
//     wallet" and "the RPC failed", and the caller answered `notFound()`. This
//     page is explicitly SEO-indexable (see its own header), and it is served
//     under ISR with `revalidate = 600` — so a single transient statement timeout
//     did not just 404 one request, it CACHED that 404 for the next ten minutes,
//     for every visitor and every crawler. `generateMetadata` published
//     "Wallet not found" alongside it.
//
// ⚠ A malformed address is `{ data: null, ok: TRUE }` — deliberately, matching
// the sets sibling. That is an ANSWER ("no such wallet"), not a failure, and
// flipping it to false would put a permanent degraded state on every bad URL a
// crawler invents.
//
// ⚠ This page does NOT prerender — `generateStaticParams` returns []. So unlike
// /analytics/sets/[set_id] there is no build-export budget to blow here, and the
// bound below is NOT protecting a build. It bounds the REQUEST: an unbounded
// server read parks the render until Vercel's 300s lambda kill while holding a
// pooled connection on a 2 GB instance that is already the documented source of
// this platform's saturation. Do not remove it on the reasoning that "nothing is
// prerendered".
//
// The client is injectable so tests can drive both branches; it defaults to the
// service-role client the page used.

import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type {
  WalletDetailResponse,
  WalletPositionTransfersResponse,
} from "@/lib/analytics-types"

export const FLOW_ADDR_RE = /^0x[0-9a-f]{16}$/i

/**
 * Per-request budget for the wallet reads.
 *
 * Matched to SET_DETAIL_TIMEOUT_MS (12s) rather than the 45s `withQueryDeadline`
 * default: these are supplementary analytics reads behind an archival surface,
 * and Postgres self-bounds `service_role` at 30s, so a bound above that would
 * only ever fire after Postgres had already answered.
 */
export const WALLET_DETAIL_TIMEOUT_MS = 12_000

/**
 * Outcome of a wallet read.
 *
 * ⚠ `ok` answers "did the READ succeed", NOT "were there rows". A wallet that
 * genuinely has no loan activity is `{ data: <empty>, ok: true }` and must keep
 * rendering as such — collapsing the two directions is the same defect facing
 * the other way.
 */
export interface WalletLoad<T> {
  data: T | null
  ok: boolean
}

/** Shared bounded-attempt runner. Catches INSIDE the raced promise so an
 *  abandoned query that fails later cannot surface as an unhandled rejection
 *  after we have stopped listening. */
async function bounded<T>(
  label: string,
  run: () => Promise<WalletLoad<T>>
): Promise<WalletLoad<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = (async (): Promise<WalletLoad<T>> => {
    try {
      return await run()
    } catch (e: any) {
      console.log(`[wallet/page] ${label}_error`, e?.message || e)
      return { data: null, ok: false }
    }
  })()
  const timeout = new Promise<WalletLoad<T>>((resolve) => {
    timer = setTimeout(() => {
      console.log(`[wallet/page] ${label}_timeout`)
      // A read that is merely SLOW is as unservable as one that errored, and
      // before this only the errored one was modelled.
      resolve({ data: null, ok: false })
    }, WALLET_DETAIL_TIMEOUT_MS)
  })
  try {
    return await Promise.race([attempt, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadWallet(
  addr: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin
): Promise<WalletLoad<WalletDetailResponse>> {
  // A malformed address is an ANSWER, not a failure — see the header.
  if (!FLOW_ADDR_RE.test(addr)) return { data: null, ok: true }
  return bounded("rpc", async () => {
    const { data, error } = await rpcWithRetry<WalletDetailResponse>(
      db,
      "flowty_analytics_wallet_detail",
      { p_addr: addr }
    )
    if (error) {
      const msg = (error.message || "").toLowerCase()
      // A genuine "no such wallet" IS an answer — ok stays true.
      if (msg.includes("not found") || msg.includes("does not exist")) {
        return { data: null, ok: true }
      }
      console.log("[wallet/page] rpc_error", error.message)
      return { data: null, ok: false }
    }
    return { data: (data as WalletDetailResponse) ?? null, ok: true }
  })
}

export async function loadPositionTransfers(
  addr: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin
): Promise<WalletLoad<WalletPositionTransfersResponse>> {
  if (!FLOW_ADDR_RE.test(addr)) return { data: null, ok: true }
  return bounded("position_transfers", async () => {
    const { data, error } = await rpcWithRetry<WalletPositionTransfersResponse>(
      db,
      "analytics_wallet_position_transfers",
      { p_addr: addr }
    )
    if (error) {
      console.log("[wallet/page] position_transfers_rpc_error", error.message)
      return { data: null, ok: false }
    }
    return { data: (data as WalletPositionTransfersResponse) ?? null, ok: true }
  })
}

/**
 * Resolve a non-hex handle to a wallet address via analytics_lookup_username.
 *
 * ⚠ Same two-outcome shape, and it matters here for a subtler reason than the
 * others: the caller REDIRECTS on a hit and 404s on a miss. Conflating a failed
 * lookup with "no such handle" means a transient blip 404s a handle that
 * resolves perfectly well a second later — and ISR caches that answer.
 */
export async function lookupUsername(
  handle: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin
): Promise<WalletLoad<string>> {
  return bounded("lookup_username", async () => {
    const { data, error } = await rpcWithRetry<unknown>(
      db,
      "analytics_lookup_username",
      { p_username: handle }
    )
    if (error) {
      console.log("[wallet/page] lookup_username_error", error.message)
      return { data: null, ok: false }
    }
    if (typeof data === "string" && FLOW_ADDR_RE.test(data)) {
      return { data: data.toLowerCase(), ok: true }
    }
    // Read succeeded and the handle maps to nothing — a real answer.
    return { data: null, ok: true }
  })
}
