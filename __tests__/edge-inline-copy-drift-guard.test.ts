import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// ── consolidated edge-fn inline-copy drift guard ────────────────────────────
//
// Several Deno edge functions carry a HAND-COPY of a pure helper that already
// lives — unit-tested — in supabase/functions/_shared/*.ts. Because the edge
// fns run on Deno (outside the vitest coverage gates) and are frequently
// redeployed by inlining the whole body via the Supabase MCP, an edit to a
// deployed copy leaves the _shared mirror's unit tests GREEN while the code
// that actually runs has drifted. That is the exact "mirror passes, deployed
// copy is wrong" hole the per-module guards (edge-nba-odds-parse,
// edge-flow-address, edge-cdc-reduced, …) already close for OTHER fns.
//
// This file closes it for the remaining VERIFIED-VERBATIM copies that no guard
// pinned yet. Each tuple below was confirmed byte-identical (comment/whitespace/
// semicolon-normalized) to its _shared mirror at authoring time. A future edit
// to either side that breaks that equality — without migrating the edge fn to
// `import` the shared module — fails CI here, in the named place, instead of
// shipping silently.
//
// Deliberately NOT pinned here (considered, excluded for cause):
//   • cdc::unwrapCdc in scan-ufc-wallet / backfill-allday-listing-serials —
//     those are the REDUCED variant and are already guarded to STAY reduced by
//     edge-cdc-reduced.test.ts (a divergence guard, not an equality one).
//   • spork-cursor::reachableFloor / sporkFloorOf in ingest-allday-pack-opens —
//     behaviourally identical but structurally parameterized differently (the
//     _shared copy takes a SporkConfig; the edge copy closes over module
//     constants), so byte-equality is the wrong assertion. Only isTransient,
//     which is constant-free, is pinned.
//   • ufc-wallet-enrich::inferTier / titleCase vs seed-ufc-editions — those are
//     two INDEPENDENTLY-authored functions that merely share a name; they are
//     not a maintained copy. NOTE a real latent discrepancy recorded for the
//     operator: seed-ufc-editions.inferTier maps circulation 0 → "ULTIMATE"
//     (its guard is `circulation === null`), while the canonical
//     ufc-wallet-enrich.inferTier maps 0 → "FANDOM" (`!max || max === 0`). Not
//     "fixed" here (editing edge source is a deploy-risk change, out of scope
//     for a test-only pass) — flagged so it isn't mistaken for a copy to align.

const root = process.cwd()

// Same normalization the sibling guards use: drop line comments, a leading
// `export`, semicolons, and collapse whitespace — so cosmetic formatting
// differences between the mirror and the inline copy don't trip the guard,
// but any real token change does.
const norm = (s: string) =>
  s
    .replace(/\/\/[^\n]*/g, "")
    .replace(/^\s*export\s+/, "")
    .replace(/;/g, "")
    .replace(/\s+/g, " ")
    .trim()

// Brace-matched extraction of a top-level `function <name>(...) { ... }` body.
function extractFn(src: string, name: string): string | null {
  const sig = src.search(new RegExp(`(export\\s+)?function ${name}\\(`))
  if (sig < 0) return null
  const open = src.indexOf("{", sig)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return norm(src.slice(sig, i + 1))
    }
  }
  return null
}

const readEdge = (fn: string) =>
  readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8")
const readShared = (mod: string) =>
  readFileSync(path.join(root, `supabase/functions/_shared/${mod}.ts`), "utf8")

// [ _shared module, exported fn name, edge fn dir, why a drift here bites ]
const PINS: Array<[string, string, string, string]> = [
  // JSON-Cadence decoder — a mis-decode corrupts every on-chain field the fn reads.
  ["cdc", "unwrapCdc", "pinnacle-owner-discovery", "owner attribution off a mis-decoded event"],
  ["cdc", "unwrapCdc", "pinnacle-owner-discovery-forward", "owner attribution off a mis-decoded event"],
  // Account-linking event parse — wrong parse = wrong parent/child ownership.
  ["hybrid-custody-parse", "parseAccountUpdatedPayload", "hybrid-custody-events", "account-link ownership attribution"],
  ["hybrid-custody-parse", "unwrap", "hybrid-custody-events", "account-link event unwrap"],
  // Pinnacle mint Deposit.to extraction — feeds owner discovery.
  ["pinnacle-mint-parse", "extractDeposit", "pinnacle-owner-discovery", "mint recipient / owner discovery"],
  ["pinnacle-mint-parse", "extractDeposit", "pinnacle-owner-discovery-forward", "mint recipient / owner discovery"],
  // Positive-serial coercion (0/negative/NaN → null) on the AllDay serial backfill.
  ["cdc-reduced", "toSerial", "backfill-allday-listing-serials", "serial coercion; a bad 0/NaN pollutes serials"],
  // Transient-vs-fatal classification of a spork fetch failure — the retry/abort decision.
  ["spork-cursor", "isTransient", "ingest-allday-pack-opens", "retry-vs-abort on a spork fetch failure"],
  // Cadence dict flatten — the UFC stub thumbnail resolver's whole read.
  ["topshot-stub-parse", "flattenCadenceDict", "ufc-stub-thumbnail-resolver", "Cadence dict flatten for stub metadata"],
  // Cadence dict decode on the base-parallel probe.
  ["topshot-subedition-parse", "decodeDict", "backfill-topshot-base-parallel-probe", "Cadence dict decode"],
  // Integer clamp used at write sites (page sizes, serials, circulation).
  ["topshot-subedition-parse", "clampInt", "backfill-allday-listing-serials", "bounded integer clamp"],
  ["topshot-subedition-parse", "clampInt", "backfill-topshot-base-parallel-probe", "bounded integer clamp"],
  ["topshot-subedition-parse", "clampInt", "special-serial-sweep", "bounded integer clamp"],
  // ── Added 2026-08-11 (test-coverage sweep) ────────────────────────────────
  // Found by walking every _shared export against every edge index.ts and
  // keeping only pairs that are VERBATIM-identical (under this file's `norm`)
  // yet named by no test. 13 such pairs existed; these are the 5 distinct ones.
  //
  // b64ToUtf8 is exported by FOUR _shared modules with byte-identical bodies
  // (verified — one distinct body across ufc-wallet-enrich / pinnacle-wallet-
  // parse / topshot-stub-parse / pack-distribution-parse). Pinning each edge fn
  // against all four would be 12 assertions of the same fact, so each edge fn is
  // pinned ONCE against the mirror closest to its own domain. It decodes every
  // base64 Cadence payload these functions read, so a drift here silently
  // corrupts the whole on-chain read rather than failing loudly.
  ["ufc-wallet-enrich", "b64ToUtf8", "enrich-ufc-wallet", "base64 Cadence payload decode for the UFC wallet scan"],
  ["pinnacle-wallet-parse", "b64ToUtf8", "scan-pinnacle-wallet", "base64 Cadence payload decode for the Pinnacle wallet scan"],
  ["pack-distribution-parse", "b64ToUtf8", "seed-allday-pack-distributions", "base64 Cadence payload decode for AllDay dist seeding"],
  ["topshot-stub-parse", "b64ToUtf8", "topshot-stub-resolver", "base64 Cadence payload decode for stub metadata"],
  // Same clamp already pinned for three sibling fns above; this call site was
  // missed. It bounds serial numbers on the sales serial backfill, where an
  // unclamped 0/NaN pollutes serials that FMV multipliers key on.
  ["topshot-subedition-parse", "clampInt", "sales-serial-backfill", "bounded integer clamp on backfilled serials"],
]

describe("edge-fn inline-copy drift guard — deployed copies match their tested _shared mirror", () => {
  it.each(PINS)(
    "%s::%s inline in %s == _shared mirror (or the edge fn imports it) — else drift (%s)",
    (mod, fn, edge, _why) => {
      const edgeSrc = readEdge(edge)
      const importsShared = new RegExp(`_shared/${mod}`).test(edgeSrc)
      if (importsShared) {
        // Migrating the edge fn to import the shared module is the ideal end
        // state — the copy is gone, so there is nothing left to drift.
        expect(importsShared).toBe(true)
        return
      }
      const shared = extractFn(readShared(mod), fn)
      const inline = extractFn(edgeSrc, fn)
      // A null on the SHARED side means the mirror export was renamed/removed
      // out from under this pin — fail loudly rather than pass vacuously.
      expect(shared, `_shared/${mod}.ts no longer exports function ${fn}`).not.toBeNull()
      // A null on the INLINE side means the edge fn's copy was renamed/removed
      // without migrating to an import — also a drift to surface.
      expect(inline, `${edge}/index.ts no longer defines an inline ${fn} (and does not import _shared/${mod})`).not.toBeNull()
      expect(inline).toBe(shared)
    },
  )
})
