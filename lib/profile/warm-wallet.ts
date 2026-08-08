// lib/profile/warm-wallet.ts
//
// One-shot dispatch of the DEEP, cross-collection wallet warm.
//
// Both wallet entry points — the "Load my collection" username CTA
// (/api/profile/resolve-and-associate) and the paste-an-address path
// (/api/profile/saved-wallets POST) — need the same thing on a brand-new
// wallet: a real Cadence walk across every published Flow collection, not a
// shallow marketplace search.
//
// Why this exists (2026-08-08): the front door opened 2026-07-20 (self-serve,
// allow-by-default), so open-door signups never get an `allow_list` row and
// therefore skip the approval-time multicollection prewarm entirely. The
// account-creation CTA became the only warm they get, and it was firing a
// shallow `/api/wallet-search` with `limit: 50` per collection — landing them
// page-capped at exactly 50 Top Shot moments and 0 everywhere else.
//
// /api/wallet-backfill-multicollection returns 202 immediately and performs the
// multi-minute walk in its own after(), so callers can await this without
// holding their own lambda open.

import { isCadenceAddress } from "@/lib/address";

export interface WarmDeepResult {
  dispatched: boolean;
  // Why we did not dispatch (or how it failed) — for logging only.
  reason?: "not_flow_address" | "no_ingest_token" | "http_error" | "fetch_failed";
  status?: number;
}

/**
 * Fire the deep multicollection backfill for `wallet`.
 *
 * Never throws — warming is best-effort and must not fail the caller's write.
 * Skips non-Flow addresses: the multicollection orchestrator only fans out to
 * Cadence collections, so a Solana/EVM address would be pure waste.
 */
export async function warmWalletDeep(
  baseUrl: string,
  ingestToken: string,
  wallet: string,
  context = "warm-wallet"
): Promise<WarmDeepResult> {
  const addr = wallet.trim();
  if (!isCadenceAddress(addr)) {
    return { dispatched: false, reason: "not_flow_address" };
  }
  if (!ingestToken) {
    // The orchestrator is Bearer-gated; without the token the POST would 401.
    console.warn(`[${context}] INGEST_SECRET_TOKEN missing — skipping deep warm`);
    return { dispatched: false, reason: "no_ingest_token" };
  }

  try {
    const res = await fetch(`${baseUrl}/api/wallet-backfill-multicollection`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestToken}`,
      },
      // skip_cached:false forces a full re-walk, so a wallet whose cache was
      // page-capped by the old shallow warm gets replaced with the real set.
      body: JSON.stringify({ wallet: addr, skip_cached: false }),
    });
    if (!res.ok) {
      console.warn(`[${context}] multicollection backfill HTTP ${res.status}`);
      return { dispatched: false, reason: "http_error", status: res.status };
    }
    return { dispatched: true, status: res.status };
  } catch (err: any) {
    console.warn(`[${context}] multicollection backfill failed:`, err?.message);
    return { dispatched: false, reason: "fetch_failed" };
  }
}
