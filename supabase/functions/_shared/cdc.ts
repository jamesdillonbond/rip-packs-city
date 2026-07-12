// Shared JSON-CDC (Cadence event/script) unwrapper.
//
// Every Flow event-ingest edge function and on-chain read decodes the same
// typed JSON-CDC shape, where each node is `{ type, value }` and containers
// (Optional / Array / Dictionary / Struct / Resource / Event / Contract / Enum /
// Type) nest recursively. A wrong Optional or typed unwrap silently drops ids
// and starves a backfill, so this recursive tree unwrapper — which collapses a
// whole decoded payload into plain JS values in one pass — is the highest-value
// piece to pin.
//
// Ported VERBATIM from lib/chains/flow/allday-edition-onchain.ts (unwrapCdc,
// ~line 41), which is the canonical shape duplicated across the ingest edge
// functions (ingest-allday-pack-opens, sales-serial-backfill, the indexer, and
// dapper-v1-tx-decode all carry the same structural unwrap). This module is a
// Deno-and-vitest-importable extraction so the unwrap is pinned by unit tests.
// The deployed edge functions still carry inline copies; wiring them to import
// from here is a deploy-gated follow-up (Deno deploy), tracked so the two don't
// silently diverge.

// Cadence JSON-CDC unwrapper (mirrors the indexer / dapper-v1-tx-decode copy).
export function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const out: Record<string, unknown> = {}
        const fields = (value as { fields?: Array<{ name: string; value: unknown }> }).fields ?? []
        for (const f of fields) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case "Type":
        return { staticType: (value as { staticType?: unknown }).staticType }
      default:
        return value
    }
  }
  return node
}
