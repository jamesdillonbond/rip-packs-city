// Shared pure decoders for the HybridCustody *probe* path.
//
// ⚠ NOT the same thing as `_shared/hybrid-custody-parse.ts`. That module parses
// the `AccountUpdated` EVENT stream (hybrid-custody-events). These decode the
// reply to an on-chain SCRIPT read (hybrid-custody-backfill), which asks a Flow
// REST `/v1/scripts` endpoint whether an address owns a HybridCustody Manager
// and, if so, which child and owned addresses it holds.
//
// ── WHY THESE TWO ARE WORTH PINNING ────────────────────────────────────────
// Both fail to an EMPTY value, never to an error, which is this platform's most
// productive defect class:
//
//   • extractScriptResultB64 returns null on an unexpected JSON shape. The Flow
//     REST script response has historically been EITHER a bare base64 string OR
//     `{ "value": "<base64>" }`, so the branch that tells those apart is load-
//     bearing and has no test anywhere.
//   • parseAddressArray returns [] for a node that is missing, wrongly typed, or
//     holds non-Address children. An account with children then reads as an
//     account with none — indistinguishable from a genuine absence.
//
// Ported VERBATIM from supabase/functions/hybrid-custody-backfill/index.ts so
// the bodies stay byte-identical under the drift guard's normalization; the
// deployed function keeps its inline copies and is pinned against this mirror by
// __tests__/edge-inline-copy-drift-guard.test.ts. Wiring it to `import` from
// here is a deploy-gated follow-up, deliberately not bundled with a test-only
// change (see #31: a half-done edge deploy caused a ~40 h silent outage).
//
// ⚠ `decodeStructResult` is deliberately NOT mirrored here. Its return type is an
// object literal, and the drift guard's extractor historically captured that type
// instead of the body — the exact vacuous-pin defect fixed on 2026-09-19. The
// extractor is correct now, but the two functions above carry the branching that
// actually decides the outcome, and pinning the composition on top of them adds
// no assertion the parts do not already make.
//
// `atob`/`btoa` are globals in Deno and in Node >= 16, so this file stays
// dependency-free and importable by both runtimes.

export interface CdcNode {
  type: string
  value: unknown
}

// Flow REST /v1/scripts response shape varies — historically it's been
// either a raw base64 string or `{ "value": "<base64>" }`. Handle both.
export function extractScriptResultB64(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  // Try JSON-wrapped shape first.
  if (trimmed.startsWith("{") || trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object" && typeof parsed.value === "string") {
        return parsed.value;
      }
      // Unexpected JSON shape — fall through.
      return null;
    } catch {
      // Not JSON. Maybe raw base64.
    }
  }
  // Raw base64.
  return trimmed;
}

export function parseAddressArray(node: CdcNode | undefined): string[] {
  if (!node || node.type !== "Array" || !Array.isArray(node.value)) return [];
  const out: string[] = [];
  for (const child of node.value as Array<CdcNode | unknown>) {
    if (child && typeof child === "object" && (child as CdcNode).type === "Address") {
      const v = (child as CdcNode).value;
      if (typeof v === "string") out.push(v);
    }
  }
  return out;
}
