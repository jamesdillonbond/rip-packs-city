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

import { detectAddressChain } from "@/lib/address";

export interface WarmDeepResult {
  dispatched: boolean;
  // Which backfill we dispatched (or would have) — for logging only.
  path?: string;
  // Why we did not dispatch (or how it failed) — for logging only.
  reason?: "unsupported_chain" | "no_ingest_token" | "http_error" | "fetch_failed";
  status?: number;
}

// The Flow orchestrator fans out to the five published Cadence collections and
// takes a FLOW address — Candy is a different chain with its own enricher, so a
// Solana address must never be handed to it.
const BACKFILL_PATH_BY_CHAIN: Record<string, string> = {
  cadence: "/api/wallet-backfill-multicollection",
  solana: "/api/wallet-backfill-candy",
};

/**
 * Fire the deep, chain-appropriate backfill for `wallet`.
 *
 * Never throws — warming is best-effort and must not fail the caller's write.
 * Skips chains we have no enricher for (EVM today), rather than burning a
 * request that could only no-op.
 */
export async function warmWalletDeep(
  baseUrl: string,
  ingestToken: string,
  wallet: string,
  context = "warm-wallet"
): Promise<WarmDeepResult> {
  // NOT `.toLowerCase()` — base58 is case-sensitive, and detectAddressChain
  // reads the raw string.
  const addr = wallet.trim();
  const path = BACKFILL_PATH_BY_CHAIN[detectAddressChain(addr)];
  if (!path) {
    return { dispatched: false, reason: "unsupported_chain" };
  }
  if (!ingestToken) {
    // Every backfill route is Bearer-gated; without the token the POST would 401.
    console.warn(`[${context}] INGEST_SECRET_TOKEN missing — skipping deep warm`);
    return { dispatched: false, reason: "no_ingest_token", path };
  }

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestToken}`,
      },
      // skip_cached:false forces a full re-walk, so a wallet whose cache was
      // page-capped by the old shallow warm gets replaced with the real set.
      // (The Candy enricher ignores it — every on-chain row is written each run.)
      body: JSON.stringify({ wallet: addr, skip_cached: false }),
    });
    if (!res.ok) {
      console.warn(`[${context}] ${path} HTTP ${res.status}`);
      return { dispatched: false, reason: "http_error", status: res.status, path };
    }
    return { dispatched: true, status: res.status, path };
  } catch (err: any) {
    console.warn(`[${context}] ${path} failed:`, err?.message);
    return { dispatched: false, reason: "fetch_failed", path };
  }
}
