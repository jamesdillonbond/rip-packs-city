// lib/chains/solana/sns.ts
//
// Resolve a Solana Name Service name (`alice.sns`, `alice.sol`) to the Solana
// wallet it points at — the one name → wallet source that exists for Candy MLB
// collectors (2026-09-25; Trevor approved the external dependency).
//
// ⛔ WHY NOT "CANDY USERNAME". Candy publishes no public profiles and no
// username API (docs/research/candy-recon-2026-07-16.md; re-researched
// 2026-09-25). And RPC's OWN usernames are deliberately NOT a source: the
// public profile strips wallet addresses as a load-bearing privacy step
// (lib/profile/public-profile.ts), so resolving `@rpcuser` → address here would
// publish exactly what that step hides.
//
// Source: the SNS SDK proxy (github.com/SolanaNameService/sns-sdk, `sdk-proxy/`):
//   GET https://sdk-proxy-v2.sns.id/resolve/<name>
//   → { "s": "ok", "result": "<base58 pubkey>" } | { "s": "error", "result": "<message>" }
// The legacy host (sdk-proxy.sns.id) retires 2026-10-01 — never use it.
//
// Three outcomes, never two: resolved · the name does not resolve (a fact about
// the NAME) · the lookup failed (a fact about US / the proxy). A failed lookup
// must never render as "no such name".

import { isSolanaAddress } from "@/lib/address"

export const SNS_PROXY_BASE = "https://sdk-proxy-v2.sns.id"
const LOOKUP_TIMEOUT_MS = 6_000

// A domain label: lowercase letters, digits, hyphens (SNS names are lowercase).
// ⚠ Lowercasing is safe HERE because this is a DOMAIN NAME, not a base58 key —
// the resolved wallet itself is passed through verbatim.
const SNS_NAME_RE = /^(?:[a-z0-9-]{1,63}\.)+(sns|sol)$/

/** A normalised SNS name, or null when the input is not one. */
export function parseSnsName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const v = raw.trim().replace(/^@/, "").toLowerCase()
  return SNS_NAME_RE.test(v) ? v : null
}

export type SnsResolution =
  | { kind: "resolved"; wallet: string }
  | { kind: "not_found"; reason: string }
  | { kind: "failed"; reason: string }

export async function resolveSnsName(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SnsResolution> {
  let res: Response
  try {
    res = await fetchImpl(`${SNS_PROXY_BASE}/resolve/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: { accept: "application/json" },
      cache: "no-store",
    })
  } catch (err) {
    return { kind: "failed", reason: err instanceof Error ? err.name : "network_error" }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { kind: "failed", reason: `unparseable_${res.status}` }
  }
  const b = body as { s?: unknown; result?: unknown } | null
  if (b && b.s === "ok" && typeof b.result === "string") {
    // Verbatim — base58 is case-sensitive. A non-base58 "ok" is the proxy
    // misbehaving, not a wallet.
    return isSolanaAddress(b.result) ? { kind: "resolved", wallet: b.result.trim() } : { kind: "failed", reason: "bad_result_shape" }
  }
  if (b && b.s === "error") {
    const msg = typeof b.result === "string" ? b.result : ""
    // "Unsupported TLD" (the proxy stops resolving `.sol` past a slot height) is
    // a limitation of the SOURCE, not a verdict that the name is unregistered.
    if (/unsupported/i.test(msg)) return { kind: "failed", reason: "unsupported_tld" }
    // A 5xx carrying an error envelope is still the proxy failing.
    if (res.status >= 500) return { kind: "failed", reason: `proxy_${res.status}` }
    return { kind: "not_found", reason: msg.slice(0, 120) }
  }
  return { kind: "failed", reason: `unexpected_${res.status}` }
}
