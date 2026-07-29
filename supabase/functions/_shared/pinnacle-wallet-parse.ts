// Shared pure logic for scan-pinnacle-wallet — the edge fn that walks a Disney
// Pinnacle wallet's on-chain NFTs (via a Cadence script through Flow REST) and
// resolves each into a `pinnacle_editions` mapping. Both helpers below decide
// what data comes back off chain:
//   • unwrap turns Flow REST's typed Cadence JSON (Optional/Array/Dictionary/
//     Struct/Resource/Event/Contract/Enum wrappers) into a plain JS value. A
//     wrong unwrap silently drops an NFT or mis-reads its fields.
//   • b64ToUtf8 is the mojibake guard — plain `atob` is latin1-only, so a
//     multi-byte UTF-8 character name comes back double-encoded.
//
// This `unwrap` is the same full CDC unwrapper as _shared/cdc.ts::unwrapCdc,
// minus the `Type` staticType case (this path never reads a Type value). Ported
// VERBATIM from scan-pinnacle-wallet/index.ts. The deployed edge fn carries the
// inline copies (excluded from CI's coverage run — no Deno toolchain); the
// source-drift guard in __tests__/edge-pinnacle-wallet-parse.test.ts fails CI if
// an inline copy is edited without mirroring it here.

/** base64 → JS string, UTF-8 CORRECT (the mojibake guard; ASCII is a no-op). */
export function b64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
}

/**
 * Flow REST typed-Cadence JSON → plain JS. Descends Optional/Array/Dictionary and
 * flattens Struct/Resource/Event/Contract/Enum by field name. Unknown types fall
 * through to their raw `value`. Never throws on a malformed node.
 */
export function unwrap(node: any): any {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrap)
  if (typeof node !== "object") return node
  const { type, value } = node
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrap(value)
      case "Array":
        return (value as any[]).map(unwrap)
      case "Dictionary": {
        const o: Record<string, any> = {}
        for (const kv of value as any[]) o[String(unwrap(kv.key))] = unwrap(kv.value)
        return o
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const o: Record<string, any> = {}
        for (const f of value.fields ?? []) o[f.name] = unwrap(f.value)
        return o
      }
      default:
        return value
    }
  }
  return node
}
