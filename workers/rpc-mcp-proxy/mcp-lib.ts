// Pure logic for the rpc-mcp-proxy Cloudflare Worker (the RPC MCP server) — the
// bits that are unit-testable without a Worker runtime: JSON-RPC 2.0 envelope
// builders, bearer-token parsing, the gap-tag/limit/slug helpers. The worker is
// deploy-gated via wrangler and its index.ts is outside the repo tsconfig, so —
// like the pack-EV / edge-fn extractions — this is a tested reference the
// source-drift guard in __tests__/worker-rpc-mcp-lib.test.ts holds in lockstep
// with the inline copies (import-or-inline), rather than a live import.
//
// Ported VERBATIM from workers/rpc-mcp-proxy/index.ts (v0.1.0).

/** Long-form collection slug → UUID (RPC_DESIGN_SYSTEM.md §4). */
export const COLLECTION_SLUG_TO_UUID: Record<string, string> = {
  nba_top_shot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  nfl_all_day: "dee28451-5d62-409e-a1ad-a83f763ac070",
  laliga_golazos: "06248cc4-b85f-47cd-af67-1855d14acd75",
  disney_pinnacle: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
  ufc_strike: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
}

export function isKnownCollectionSlug(slug: string): boolean {
  return slug in COLLECTION_SLUG_TO_UUID
}

/**
 * Sanitize an arbitrary string for use inside a `gaps` tag: collapse any run of
 * non-`[a-zA-Z0-9_]` to a single `_` and cap at 60 chars. Keeps an upstream error
 * message / bad slug from injecting structure into the machine-readable gap tag.
 */
export function sanitizeForGap(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 60)
}

/**
 * Parse the MCP bearer token from an Authorization header. Only the
 * `rpc_mcp_live_<token>` shape is accepted (the raw token that is then sha256'd
 * and validated against mcp_validate_api_key). Returns null for any other shape,
 * so a malformed header never reaches the DB validation call.
 */
export function parseBearerToken(authHeader: string | null | undefined): string | null {
  const auth = authHeader ?? ""
  const m = auth.match(/^Bearer\s+(rpc_mcp_live_[A-Za-z0-9_-]+)$/)
  return m ? m[1] : null
}

/**
 * Clamp a tool's `limit` argument to [1, 100], defaulting to 25 when absent.
 * Mirrors the inline `args.limit != null ? Math.max(1, Math.min(100,
 * Number(args.limit))) : 25`.
 */
export function clampMcpLimit(raw: unknown): number {
  return raw != null ? Math.max(1, Math.min(100, Number(raw))) : 25
}

/**
 * gaps_count telemetry: the length of a result's `gaps` array, 0 for anything
 * that isn't an object with an array `gaps`.
 */
export function extractGapsCount(result: unknown): number {
  if (result == null || typeof result !== "object") return 0
  const r = result as Record<string, unknown>
  if (Array.isArray(r.gaps)) return r.gaps.length
  return 0
}

/** JSON-RPC 2.0 success envelope. `id` null-coalesces so a notification's absent id → null. */
export function rpcResult(id: string | number | null | undefined, result: unknown): object {
  return { jsonrpc: "2.0", id: id ?? null, result }
}

/** JSON-RPC 2.0 error envelope. `data` is omitted entirely when undefined (spec-compliant). */
export function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): object {
  const error: Record<string, unknown> = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: "2.0", id: id ?? null, error }
}

/**
 * Seconds until the next UTC midnight, floored at 60 — the Retry-After / quota
 * reset window. Pure version of the inline `secondsUntilUtcMidnight()`; `nowMs`
 * is injected so it's deterministic under test.
 */
export function secondsUntilUtcMidnightFrom(nowMs: number): number {
  const now = new Date(nowMs)
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  return Math.max(60, Math.ceil((tomorrow - nowMs) / 1000))
}
