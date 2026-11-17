// Shared pure parser for HybridCustody `AccountUpdated` events.
//
// This is the event parser feeding the account-linking pipeline: each base64
// JSON-CDC event payload carries the (id, child, parent, active) tuple that
// establishes/clears a parent↔child wallet link, which the
// `analytics_sales_resolved` view uses to dedup a collector's parent + child
// wallets in leaderboards. The parser is pure and bug-prone — keyed (not
// positional) field lookup, Optional unwrap, strict type guards that REJECT a
// malformed payload rather than write a half-link, and a fallible BigInt parse
// of the id that must degrade to null, never throw.
//
// Ported VERBATIM from supabase/functions/hybrid-custody-events/index.ts
// (decodeBase64Json ~line 115, unwrap ~line 120, parseAccountUpdatedPayload
// ~line 136). This module is a Deno-and-vitest-importable extraction so the
// parse is pinned by unit tests. The deployed edge function still carries the
// inline copies; wiring it to import from here is a deploy-gated follow-up (Deno
// deploy), tracked so the two don't silently diverge.
//
// atob is a global in both Deno and Node (>=16), so this file stays
// dependency-free and importable by both runtimes.

// JSON-CDC payload walker. Each event payload is base64-encoded JSON of shape:
//   { "type": "Event", "value": { "id": "<full type>", "fields": [{name, value}, ...] } }
// where each field's value is itself a typed JSON-CDC node:
//   { "type": "Optional", "value": { "type": "UInt64", "value": "123" } | null }
//   { "type": "Address", "value": "0x..." }
//   { "type": "Bool",    "value": true }
//
// We don't depend on field ordering — keyed lookup by name.
export interface CdcNode {
  type: string
  value: unknown
}

export function decodeBase64Json(b64: string): unknown {
  const decoded = atob(b64)
  return JSON.parse(decoded)
}

export function unwrap(node: CdcNode | null | undefined): unknown {
  if (!node || typeof node !== "object") return null
  if (node.type === "Optional") {
    if (node.value === null || node.value === undefined) return null
    return unwrap(node.value as CdcNode)
  }
  return node.value
}

export interface ParsedAccountUpdated {
  id: bigint | null
  child: string
  parent: string
  active: boolean
}

export function parseAccountUpdatedPayload(b64: string): ParsedAccountUpdated | null {
  try {
    const root = decodeBase64Json(b64) as { value?: { fields?: Array<{ name: string; value: CdcNode }> } }
    const fields = root?.value?.fields
    if (!Array.isArray(fields)) return null
    const byName = new Map<string, CdcNode>()
    for (const f of fields) byName.set(f.name, f.value)

    const idNode = byName.get("id")
    const childNode = byName.get("child")
    const parentNode = byName.get("parent")
    const activeNode = byName.get("active")

    const childRaw = unwrap(childNode)
    const parentRaw = unwrap(parentNode)
    const activeRaw = unwrap(activeNode)
    const idRaw = unwrap(idNode)

    if (typeof childRaw !== "string" || typeof parentRaw !== "string") return null
    if (typeof activeRaw !== "boolean") return null

    let id: bigint | null = null
    if (idRaw != null) {
      try { id = BigInt(String(idRaw)) } catch { id = null }
    }

    return {
      id,
      child: childRaw,
      parent: parentRaw,
      active: activeRaw,
    }
  } catch {
    return null
  }
}
