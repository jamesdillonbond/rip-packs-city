import { resolveTopShotUsernameCacheAware } from "@/lib/chains/flow/topshot-username-resolve";
import { supabaseAdmin } from "@/lib/supabase";
import { NextResponse } from "next/server";

const resolveCache = new Map<string, { addr: string; expiresAt: number }>();
const RESOLVE_TTL_MS = 5 * 60 * 1000;

function isWalletAddress(v: string) {
  return /^0x[a-fA-F0-9]{16}$/.test(v.trim());
}

function ensureFlowPrefix(v: string) {
  return v.startsWith("0x") ? v : "0x" + v;
}

/**
 * Thrown when a username lookup could not REACH its source — as opposed to the
 * "Could not resolve …" error, which means the source answered and there is no
 * such user. Its message deliberately does not match isUnresolvedIdentifierError.
 */
export class UsernameLookupUnavailableError extends Error {
  constructor(detail: string) {
    super(`username lookup unavailable: ${detail}`);
    this.name = "UsernameLookupUnavailableError";
  }
}

/** The publishable 503 for the above: fixed copy, concludes nothing about the handle. */
export function usernameLookupUnavailableResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "We couldn't reach Top Shot to look up that username, so this says nothing about it. Try again shortly, or enter the wallet address.",
      code: "upstream_unavailable" as const,
      retryable: true,
    },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
  );
}

// 2026-09-29 — resolves through the shared cache-aware ladder (cached layers,
// then a live Atlas read, then Top Shot GQL). This used to run its own copy:
// the cache, then ONLY the Top Shot GraphQL host — decommissioned, per the note
// in app/api/sets/route.ts — with every thrown error swallowed into `null`. So
// any username not already cached, on any day, came back "Could not resolve …
// Check the username", and an outage read the same way. Now a miss says so and
// a failure to look throws UsernameLookupUnavailableError.
export async function resolveToFlowAddress(input: string): Promise<string> {
  const trimmed = input.trim();
  if (isWalletAddress(trimmed)) return ensureFlowPrefix(trimmed);
  const cacheKey = trimmed.toLowerCase();
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.addr;

  const outcome = await resolveTopShotUsernameCacheAware(supabaseAdmin as any, trimmed);
  if (outcome.found) {
    resolveCache.set(cacheKey, { addr: outcome.walletAddress, expiresAt: Date.now() + RESOLVE_TTL_MS });
    return outcome.walletAddress;
  }
  if (outcome.reason === "topshot_gql_error") {
    throw new UsernameLookupUnavailableError(outcome.detail ?? outcome.reason);
  }
  throw new Error('Could not resolve "' + trimmed + '" to a Flow address. Check the username and try again.');
}
