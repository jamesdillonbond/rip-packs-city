// The REDUCED JSON-CDC unwrapper + serial coercion shared (by shape) across the
// serial-backfill edge functions: sales-serial-backfill,
// backfill-allday-listing-serials, and scan-ufc-wallet. Each carries a verbatim
// inline copy; the coverage measure can't see Deno edge fns, so this module
// mirrors the logic for unit testing and __tests__/edge-cdc-reduced.test.ts adds
// a source-drift guard. It does NOT modify the edge functions (no deploy).
//
// WHY "reduced" — and why it must NOT be unified with _shared/cdc.ts:
// the FULL unwrapCdc (_shared/cdc.ts) flattens composite CDC types
// (Struct/Resource/Event/Contract/Enum) into a plain object keyed by field name,
// because a Deposit event is an Event composite whose fields must be reachable.
// This reduced variant deliberately OMITS those cases: its `default` arm returns
// the raw `value` for any type it doesn't handle (incl. all composites). The
// serial-backfill scripts read scalar/Array/Dictionary script results and never
// a composite, so the reduced form is correct AND cheaper — but swapping in the
// full unwrapCdc here would change composite handling. This module + guard pin
// that divergence so a well-meaning "dedupe" can't silently break it.

export function unwrapCdcReduced(node: unknown): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(unwrapCdcReduced);
  if (typeof node !== "object") return node;
  const { type, value } = node as { type?: string; value?: unknown };
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional": return value === null ? null : unwrapCdcReduced(value);
      case "Array": return (value as unknown[]).map(unwrapCdcReduced);
      case "Dictionary": {
        const out: Record<string, unknown> = {};
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdcReduced(kv.key))] = unwrapCdcReduced(kv.value);
        }
        return out;
      }
      default:
        return value;
    }
  }
  return node;
}

// Coerce a CDC scalar (or its string form) to a positive serial number, else
// null. Serials are 1-based on-chain, so 0 / negative / non-finite → null.
export function toSerial(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
