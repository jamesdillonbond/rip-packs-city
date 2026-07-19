// Cadence JSON-CDC decoder for pack-events-ingest, extracted VERBATIM from
// index.ts so the type-branch handling can be unit-tested. This decoder turns
// every pack purchase/open event payload into plain JS, so a regression here
// (e.g. an Optional or a Dictionary decoded wrong) silently corrupts what lands
// in pack_purchases. index.ts imports these; kept worker-local (not shared with
// supabase/functions/_shared) so the wrangler bundle stays self-contained.
//
// Mirrors lib/cdc / _shared/cdc, but the pack-events worker deliberately carries
// its own copy; keeping it here (imported by index.ts) makes that copy testable.

export function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Bool":
      case "String":
      case "Address":
      case "Path":
      case "Character":
        return value
      case "Int":
      case "UInt":
      case "Int8":
      case "Int16":
      case "Int32":
      case "Int64":
      case "Int128":
      case "Int256":
      case "UInt8":
      case "UInt16":
      case "UInt32":
      case "UInt64":
      case "UInt128":
      case "UInt256":
      case "Word8":
      case "Word16":
      case "Word32":
      case "Word64":
      case "Fix64":
      case "UFix64":
        return value
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const arr = value as Array<{ key: unknown; value: unknown }>
        const out: Record<string, unknown> = {}
        for (const entry of arr) out[String(unwrapCdc(entry.key))] = unwrapCdc(entry.value)
        return out
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const out: Record<string, unknown> = {}
        const v = value as { fields?: Array<{ name: string; value: unknown }> }
        for (const f of v.fields ?? []) out[f.name] = unwrapCdc(f.value)
        return out
      }
      default:
        return value
    }
  }
  return node
}

export function extractTypeId(field: unknown): string | undefined {
  if (typeof field === "string") return field
  if (field && typeof field === "object") {
    const st = (field as Record<string, unknown>).staticType
    if (typeof st === "string") return st
    if (st && typeof st === "object") {
      const id = (st as Record<string, unknown>).typeID
      if (typeof id === "string") return id
    }
  }
  return undefined
}
