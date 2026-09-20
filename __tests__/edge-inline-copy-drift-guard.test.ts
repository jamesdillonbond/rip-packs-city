import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
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
//   • pinnacle-mint-parse::extractDeposit vs pinnacle-owner-discovery and
//     pinnacle-owner-discovery-forward — REMOVED 2026-09-19 after the extractor
//     fix below made the comparison real for the first time. They are the same
//     ALGORITHM written twice, not a maintained copy: the mirror uses
//     `u`/`id`/`to`/`toAddr` and one combined null-check, the inline copies use
//     `unwrapped`/`idField`/`toField`/`to` and two separate checks. ⛔ And the
//     decisive part — each logs its OWN function name on the catch path
//     (`[ingest-pinnacle-mints]` vs `[pinnacle-owner-discovery]`), which is
//     CORRECT behaviour, so byte-equality can never hold and pinning it would
//     demand a wrong log prefix in one of them. Behaviour was compared by hand
//     and is equivalent. `ingest-pinnacle-mints` keeps its pin: its copy IS
//     verbatim, log prefix included.
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

/**
 * A statement keyword. Present in every real function BODY; absent from a
 * return-type object literal. This is what makes the extraction self-checking.
 */
export const BODY_TOKEN = /\breturn\b|\bconst\b|\bfor\b|\btry\b|\bif\b|\blet\b|\bthrow\b|\bswitch\b|=>/

/**
 * Brace-match that SKIPS string/template literals and comments.
 *
 * ⚠ 2026-09-19: the previous version counted every `{` character, so a brace
 * inside a STRING — `trimmed.startsWith("{")` in hybrid-custody-backfill's
 * extractScriptResultB64 — left the depth permanently unbalanced and the
 * extraction returned null. Null on both sides is caught by the assertions
 * below, so it failed loudly rather than silently; but it made a whole class of
 * parser unpinnable for a reason no one could see from the pin list.
 */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      i++
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue }
        if (src[i] === quote) break
        i++
      }
      continue
    }
    if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); if (nl < 0) return -1; i = nl; continue }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return -1; i = e + 1; continue }
    if (c === "{") depth++
    else if (c === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * Extraction of a top-level `function <name>(...) { ... }` BODY.
 *
 * 🚨 2026-09-19 — WHY THIS IS NOT `indexOf("{")` ANY MORE, AND WHY IT MATTERED.
 * A function whose RETURN TYPE is an object literal —
 *
 *     function extractDeposit(b64: string): { nftId: string; to: string } | null {
 *
 * — has its first `{` in the TYPE, not the body. The old extractor matched that
 * brace, so the pin compared two RETURN TYPES and was structurally incapable of
 * seeing a body change. **Seven of the 47 pins were in that state**, including
 * `computeDualPrice` and `editionExtKey` on `compute-topshot-pack-ev` — whose
 * own pin comments read "drift silently re-prices every pack" and "a mis-key
 * attributes pulls to the wrong edition". They asserted neither.
 *
 * Fixing it surfaced REAL divergence in two pins that had always "passed"
 * (see the pinnacle-owner-discovery exclusion below).
 *
 * The rule is now self-checking: the body is the FIRST brace group containing a
 * statement keyword, so a type literal can never be returned as a body.
 */
function extractFn(src: string, name: string): string | null {
  const sig = src.search(new RegExp(`(export\\s+)?function ${name}\\(`))
  if (sig < 0) return null
  let cursor = sig
  // At most a few groups: [type params]? [return type]? [body].
  for (let n = 0; n < 4; n++) {
    const open = src.indexOf("{", cursor)
    if (open < 0) return null
    const close = matchBrace(src, open)
    if (close < 0) return null
    if (BODY_TOKEN.test(src.slice(open + 1, close))) return norm(src.slice(sig, close + 1))
    cursor = close + 1
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
  // ⛔ pinnacle-mint-parse::extractDeposit for pinnacle-owner-discovery{,-forward}
  //    was pinned here until 2026-09-19 and is REMOVED, not merely un-pinned —
  //    see the "Deliberately NOT pinned" note at the top of this file. In short:
  //    those two are INDEPENDENTLY authored, not a maintained copy, and each logs
  //    its OWN function name, so byte-equality is impossible by construction. The
  //    pin only ever passed because the old extractor compared return types.
  //    `ingest-pinnacle-mints` keeps its pin below — that one IS a verbatim copy.
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
  // ── Added 2026-08-16 (test-coverage sweep) ────────────────────────────────
  //
  // ⚠ THE 2026-08-11 SWEEP ABOVE SAYS IT WALKED "every _shared export against every edge
  // index.ts" AND FOUND 13 SUCH PAIRS. Re-running that exact walk on 2026-08-16 found 20
  // MORE that were verbatim-identical and named by no pin — so the population had grown
  // (or the first walk was narrower than its own note claims) while the note read as a
  // completed census. A "found them all" comment is the thing least likely to be re-run.
  // Re-derive this list; do not trust this comment either.
  //
  // The largest miss is compute-topshot-pack-ev, the biggest edge function on the
  // platform (1,583 LOC) and the writer of pack_ev_history + pack_drop_pool — i.e. the
  // public +EV badge and the pack simulator's drop probabilities. It appeared NOWHERE in
  // the pin list despite holding three verbatim copies of tested _shared exports.
  // Verified 2026-08-16: all three still match, so this pins a property that holds rather
  // than fixing a live drift.
  ["pack-ev-edition", "computeDualPrice", "compute-topshot-pack-ev", "primary-vs-secondary pack price selection; drift silently re-prices every pack"],
  ["pack-ev-edition", "editionExtKey", "compute-topshot-pack-ev", "edition keying for the EV pool; a mis-key attributes pulls to the wrong edition"],
  ["pack-ev-edition", "normalizeTier", "compute-topshot-pack-ev", "tier normalisation feeding grail odds"],
  // ── Added 2026-09-19, and only possible BECAUSE of the extractor fix above ──
  // `extractScriptResultB64` contains `startsWith("{")`. Under the old
  // brace-counter that string literal unbalanced the depth and extraction
  // returned null, so this parser could not be pinned at all — a gap invisible
  // from the pin list. Both functions here fail to an EMPTY value rather than to
  // an error (null / []), which is the platform's most productive defect class:
  // an account WITH linked children reads as an account with none. Unit-tested
  // in __tests__/edge-hybrid-custody-probe-decode.test.ts (16 cases).
  ["hybrid-custody-probe-decode", "extractScriptResultB64", "hybrid-custody-backfill", "Flow REST /v1/scripts shape sniffer; a wrong branch feeds JSON to atob()"],
  ["hybrid-custody-probe-decode", "parseAddressArray", "hybrid-custody-backfill", "Cadence Address[] decode; drift silently reports linked children as none"],
  // Cadence/base64 decode paths — a drift here corrupts the whole on-chain read rather
  // than failing loudly, which is what makes these worth pinning over prettier targets.
  ["cdc", "unwrapCdc", "ingest-pinnacle-mints", "JSON-Cadence decode for Pinnacle mint events"],
  ["pinnacle-mint-parse", "extractDeposit", "ingest-pinnacle-mints", "mint recipient extraction; wrong owner attribution"],
  ["pinnacle-mint-parse", "extractMint", "ingest-pinnacle-mints", "mint event extraction; wrong edition/serial"],
  ["topshot-stub-parse", "b64Utf8", "topshot-stub-resolver", "base64 Cadence payload decode for stub metadata"],
  ["topshot-stub-parse", "flattenCadenceDict", "topshot-stub-resolver", "Cadence dict flatten for stub metadata"],
  ["topshot-stub-parse", "pickPlayerName", "topshot-stub-resolver", "player-name selection; a drift mislabels a moment's player"],
  ["topshot-stub-parse", "b64Utf8", "ufc-stub-thumbnail-resolver", "base64 Cadence payload decode for UFC stub thumbnails"],
  ["pinnacle-edition-key", "extractEditionKey", "pinnacle-nft-resolver", "the royalty:variant:printing triple key; a drift breaks every Pinnacle FMV join"],
  ["pack-opens-rip-parse", "toRip", "backfill-pack-opens-api", "pack-rip parse; feeds pull attribution and pack EV"],
  ["atlas-pool-normalize", "normalizeAtlas", "ingest-topshot-atlas-pool", "Atlas drop-pool normalisation; feeds pack drop weights"],
  ["atlas-pool-normalize", "num", "ingest-topshot-atlas-pool", "numeric coercion inside the pool normaliser"],
  ["spork-cursor", "isTransient", "ingest-topshot-pack-opens-history", "retry-vs-abort on a spork fetch failure"],
  // The odds parser: devig and implied-probability maths whose drift would move published
  // projections without erroring anywhere.
  ["nba-odds-parse", "americanToImplied", "sync-nba-odds", "American odds to implied probability"],
  ["nba-odds-parse", "devigPair", "sync-nba-odds", "vig removal; a drift biases every projection"],
  ["nba-odds-parse", "isoDateInET", "sync-nba-odds", "ET date bucketing; an off-by-one puts a game on the wrong slate"],
  ["nba-odds-parse", "parseEvents", "sync-nba-odds", "event parse"],
  ["nba-odds-parse", "pickBookmaker", "sync-nba-odds", "bookmaker selection; decides whose line is published"],
  // ⚠ THESE NINE WERE FOUND BY THE COMPLETENESS CHECK BELOW, NOT BY THE HAND SWEEP THAT
  // FOUND THE TWENTY ABOVE. The hand sweep used its own extractor, which required a
  // line-start `}` to close a function and so missed every copy formatted differently.
  // The check reuses THIS FILE'S extractFn and norm — the same ones the pin assertions
  // use — which is why it sees more. The transferable bit: when a guard and an ad-hoc
  // script disagree about a population, the guard's own primitives are the instrument;
  // an approximation of them is a second, weaker implementation of the same question.
  ["topshot-subedition-parse", "decodeDict", "backfill-topshot-subeditions", "Cadence dict decode for subedition backfill; a mis-decode mis-keys parallels"],
  ["topshot-subedition-parse", "clampInt", "backfill-topshot-subeditions", "bounded integer clamp on subedition ids and serials"],
  ["ufc-wallet-enrich", "inferTier", "enrich-ufc-wallet", "UFC tier inference; drives the tier shown on every UFC moment"],
  ["ufc-wallet-enrich", "makeEditionKey", "enrich-ufc-wallet", "UFC edition keying; a drift breaks the join to editions"],
  ["ufc-wallet-enrich", "parseResult", "enrich-ufc-wallet", "wallet scan result parse"],
  ["hybrid-custody-parse", "decodeBase64Json", "hybrid-custody-events", "base64 event payload decode for account-link ownership"],
  ["sales-serial-parse", "normalizeAddr", "sales-serial-backfill", "Flow address normalisation; a drift mis-attributes buyers and sellers"],
  ["flow-address", "toFlowAddr", "special-serial-delta", "Flow address normalisation for special-serial ownership"],
  ["flow-address", "toFlowAddr", "special-serial-sweep", "Flow address normalisation for special-serial ownership"],
]

// ── COMPLETENESS: the list above must not silently fall behind ──────────────
//
// ⚠ THIS EXISTS BECAUSE THE PIN LIST DID FALL BEHIND, AND ITS OWN COMMENT SAID IT HAD NOT.
// The 2026-08-11 note records walking "every _shared export against every edge index.ts";
// re-running that exact walk on 2026-08-16 found 20 more verbatim-identical, unpinned
// pairs. Whether the first walk was narrower than described or the population grew after
// it, the outcome is the same and is the point: a hand-run census records a MOMENT, and
// nothing about the note announces its expiry. The remedy is not a better note.
//
// So: re-run the walk here, every CI run, and fail on anything unpinned. A new edge fn
// that copies a tested helper is caught the day it lands, and the human decision it forces
// is the right one — import the shared module, or pin the copy.
//
// Deliberately narrow, for the same reason the list is: only pairs that are VERBATIM
// identical (under this file's `norm`) are demanded. An edge copy that has legitimately
// diverged — closing over module state, taking different arguments — is NOT a drift and
// must not be forced into a pin it would immediately fail.
describe("edge-fn inline-copy drift guard — the pin list is COMPLETE", () => {
  /** Every `export function <name>` in a _shared module, name -> [module]. */
  function sharedExports(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    const dir = path.join(root, "supabase/functions/_shared")
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(path.join(dir, f), "utf8")
      for (const m of src.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)\(/gm)) {
        const mod = f.replace(/\.ts$/, "")
        out.set(m[1], [...(out.get(m[1]) ?? []), mod])
      }
    }
    return out
  }

  const pinned = new Set(PINS.map(([, fn, edge]) => `${edge}::${fn}`))
  const exports = sharedExports()
  const edgeDirs = readdirSync(path.join(root, "supabase/functions"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => e.name)
    .filter((n) => existsSync(path.join(root, `supabase/functions/${n}/index.ts`)))

  it("finds real edge functions and real _shared exports (guard isn't inert)", () => {
    expect(edgeDirs.length).toBeGreaterThan(20)
    expect(exports.size).toBeGreaterThan(20)
  })

  it("every verbatim inline copy of a tested _shared export is pinned above", () => {
    const unpinned: string[] = []
    for (const edge of edgeDirs) {
      const edgeSrc = readEdge(edge)
      for (const [fn, mods] of exports) {
        if (pinned.has(`${edge}::${fn}`)) continue
        const inline = extractFn(edgeSrc, fn)
        if (inline === null) continue
        for (const mod of mods) {
          if (extractFn(readShared(mod), fn) === inline) {
            unpinned.push(`["${mod}", "${fn}", "${edge}", "<why a drift here bites>"],`)
            break
          }
        }
      }
    }
    expect(
      unpinned,
      `${unpinned.length} edge fn(s) hold a VERBATIM copy of a tested _shared export with no ` +
        `pin. Either import the shared module (the ideal end state) or add the pin(s):\n` +
        unpinned.join("\n"),
    ).toEqual([])
  })
})

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
      // ⭐ NON-VACUITY, added 2026-09-19. Before the extractor fix, a function
      // whose return type is an object literal had its TYPE extracted instead of
      // its body, so the pin compared `{ nftId: string; to: string }` on both
      // sides and passed however the bodies diverged. Seven pins were in that
      // state. Asserting a statement keyword makes that state impossible to
      // re-enter, in the place it would re-enter.
      expect(
        shared === null || BODY_TOKEN.test(shared),
        `_shared/${mod}.ts::${fn} extracted no statement keyword — this pin is VACUOUS ` +
          `(a return-type literal was captured instead of the body): ${shared}`,
      ).toBe(true)
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

// ── guards on the GUARD, added 2026-09-19 ───────────────────────────────────
//
// The extractor is the whole mechanism here: if it captures the wrong region,
// every pin above compares the wrong text and passes. That is not theoretical —
// it is what happened to SEVEN pins until this date. These cases pin the two
// shapes that broke it, against fixtures, so the failure cannot return silently.
describe("edge-fn inline-copy drift guard — the EXTRACTOR itself", () => {
  const RETURN_TYPE_LITERAL = `
function extractDeposit(payloadBase64: string): { nftId: string; to: string } | null {
  const raw = JSON.parse(atob(payloadBase64))
  return { nftId: String(raw.id), to: String(raw.to) }
}
`
  const BRACE_IN_STRING = `
function extractScriptResultB64(rawText: string): string | null {
  const trimmed = rawText.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("\\"")) return JSON.parse(trimmed).value
  return trimmed
}
`

  it("captures the BODY, not a return-type object literal", () => {
    const got = extractFn(RETURN_TYPE_LITERAL, "extractDeposit")
    expect(got).not.toBeNull()
    // The bug produced exactly `{ nftId: string to: string }` and nothing else.
    expect(got).toContain("JSON.parse")
    expect(BODY_TOKEN.test(got!)).toBe(true)
  })

  it("is not fooled by a brace inside a string literal", () => {
    const got = extractFn(BRACE_IN_STRING, "extractScriptResultB64")
    expect(got).not.toBeNull()
    expect(got).toContain("return trimmed")
  })

  it("DETECTS a body change — the mutation proof, both directions", () => {
    const a = extractFn(RETURN_TYPE_LITERAL, "extractDeposit")
    const mutated = RETURN_TYPE_LITERAL.replace("String(raw.to)", "String(raw.recipient)")
    const b = extractFn(mutated, "extractDeposit")
    expect(b).not.toBeNull()
    expect(b).not.toBe(a)
    // …and an irrelevant reformat is still equal, so the guard is not brittle.
    const reformatted = RETURN_TYPE_LITERAL.replace(/\n/g, "\n  ") + "\n// trailing comment\n"
    expect(extractFn(reformatted, "extractDeposit")).toBe(a)
  })

  it("every pinned _shared body carries a statement keyword (no vacuous pins)", () => {
    const vacuous = PINS.filter(([mod, fn]) => {
      const body = extractFn(readShared(mod), fn)
      return body !== null && !BODY_TOKEN.test(body)
    }).map(([mod, fn]) => `${mod}::${fn}`)
    expect(vacuous, `vacuous pin(s): ${vacuous.join(", ")}`).toEqual([])
  })
})
