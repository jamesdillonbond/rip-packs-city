// Shared pure logic for pinnacle-nft-resolver — the edge fn that resolves an
// unmapped Disney Pinnacle NFT to its edition by running a Cadence script against
// the owner's account and reading the `editionKey` field off the returned struct.
//
// extractEditionKey is the load-bearing decode: the string it returns IS the
// mapping between a collector's on-chain NFT and a `pinnacle_editions` row, so a
// wrong unwrap either drops a real pin (returns null → the NFT stays unresolved)
// or, worse, would attach the wrong edition. Pinnacle wraps the field in an
// Optional inside a Struct, so the unwrap has to descend exactly one Optional
// level and reject empty strings.
//
// Ported VERBATIM from pinnacle-nft-resolver/index.ts (resolver_version 10). The
// deployed edge fn carries the inline copy; the source-drift guard in
// __tests__/edge-pinnacle-edition-key.test.ts fails CI if it is edited without
// mirroring it here.

/**
 * Pull the `editionKey` string out of a Flow-REST-decoded Pinnacle NFT struct.
 * Descends: envelope.value.fields → the `editionKey` field → its Optional (or
 * bare) value. Returns null for a missing field, an empty Optional, a null, or an
 * empty string — never a partial/garbage key.
 */
export function extractEditionKey(raw: unknown): string | null {
  const envelope = raw as { type?: string; value?: unknown }
  if (!envelope || typeof envelope !== "object") return null
  const structValue = envelope.value as { fields?: Array<{ name: string; value: unknown }> } | undefined
  const fields = structValue?.fields
  if (!Array.isArray(fields)) return null
  for (const f of fields) {
    if (f.name !== "editionKey") continue
    const outer = f.value as { type?: string; value?: unknown } | null
    if (!outer) return null
    if (outer.type === "Optional") {
      const inner = outer.value as { type?: string; value?: unknown } | null
      if (!inner) return null
      const v = inner.value
      return typeof v === "string" && v.length > 0 ? v : null
    }
    const v = outer.value
    return typeof v === "string" && v.length > 0 ? v : null
  }
  return null
}
