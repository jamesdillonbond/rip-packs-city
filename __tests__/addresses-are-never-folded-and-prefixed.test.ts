import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isMarkerSuppressed } from "../scripts/lib/marker-suppression.mjs"

// BAN AT ZERO on FOLD-AND-PREFIX: `"0x" + something.toLowerCase()`.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// CLAUDE.md names it directly: *"Fold-and-prefix on a DISPLAYED address is a
// FABRICATION, not an absence."* Flow/EVM hex is case-insensitive and
// `0x`-prefixed, so folding and prefixing is the right normalisation there.
// Solana base58 is CASE-SENSITIVE and un-prefixed, so the same expression turns
// `12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK` into
// `0x12j1uhkqcbyauomkvxdp2ma6mst3k8wx8ohhhv8genak` — **a string that is not an
// address on any chain.** It does not error, it does not return empty; it
// returns a confident wrong answer.
//
// ⚠ WHY THIS SHAPE AND NOT `.toLowerCase()` GENERALLY. A tree walk for an
// address-shaped receiver folded to lower case returns ~26 sites, and most are
// legitimately Flow- or EVM-only, or fold BOTH sides of a comparison. **A ban
// over all of them would be an allowlist wearing a guard's clothes** — the thing
// CLAUDE.md warns about by name. Fold-and-prefix is different: it is the
// sub-shape that FABRICATES rather than merely mismatching, and its population
// is FOUR, every one of them provably hex-only. That is a curated SUPPRESSION
// list of four, not an allowlist of twenty-six.
//
// ── WHAT IT HAS COST ────────────────────────────────────────────────────────
//   * `/candy-mlb/player/*` and `/candy-mlb/edition/*` rendered `0x2at8…jrqw`
//     as a wallet label while the `title=` on the SAME element carried the
//     correct-case mint.
//   * `WalletLink` built `/<collection>/collection?wallet=<mangled>` — an HREF,
//     so every owner link sent the reader to an analyzer that resolved nothing.
//   * The `/profile` aggregations keyed on it and dropped 1,726 Moments while
//     still counting the wallet as ATTEMPTED.
//   * `/api/mcp/keys` (found 2026-09-20 building this guard): the set is not
//     inert — POST defaulted to `userWallets[0]`, so a key could be ISSUED
//     against the fabricated address, and GET echoes each entry back to the
//     user as `wallet_address`.
//
// ── THE ESCAPE HATCH ────────────────────────────────────────────────────────
// `// base58-fold: intentional — <why>` within the lookback. Use it only where
// the value CANNOT be base58 by construction — a 20-byte EVM topic slice, a
// Cadence `owner` from an on-chain event. ⚠ "This collection is Flow today" is
// NOT such a reason; `lib/address.ts` exists for that case.
//
// ── WHAT THIS IS STRUCTURALLY SILENT ABOUT, stated rather than implied ──────
//  1. A fold and a prefix separated across statements (`const a = x.toLowerCase()`
//     … later … `"0x" + a`). Single-line/adjacent only — a false NEGATIVE.
//  2. `normalizeAddress`/`walletQueryKey`/`displayAddress` misuse. They are the
//     remedy, so a call to one is invisible here by design.
//  3. Whether a hex-only site is REALLY hex-only. It reads the marker's
//     existence, never its truth.

const ROOTS = ["app", "components", "lib", "workers", "scripts"]

// ⚠ `supabase/functions` IS EXCLUDED, AND THE EXCLUSION IS CHECKED RATHER THAN
// ASSUMED — see the arm below. Two reasons, in this order:
//
//  1. THE PROPERTY IS NOT TRUE THERE TODAY. Measured 2026-09-20: across all 41
//     edge functions, ZERO files mention candy / solana / base58 / magic_eden.
//     The edge tree is a Flow-ingest fleet; chain two lives in `app/api/cron/*`
//     and `workers/`. ⚠ CLAUDE.md: *"A control's POPULATION must be the set the
//     property is TRUE of, not a proxy that coincides today — a proxy expires
//     silently."* So the arm below re-derives that census on every run and goes
//     red the day an edge function gains a Solana surface, which is the day this
//     exclusion stops being sound.
//
//  2. THE SUPPRESSION WOULD COST ANOTHER INSTRUMENT. `check-edge-fn-drift`
//     compares repo source to the DEPLOYED bundle through a dialect ladder and
//     WATCHES WHICH RUNG each function lands on ("canonical decaying to
//     canonical_tight … is the early warning"). Measured directly with
//     `scripts/lib/eszip-source.mjs`: adding a comment to an edge function leaves
//     `tightNormalise` identical but changes `canonicaliseSource`. So an in-file
//     marker here does not cause drift — it demotes the function one rung and
//     fakes that instrument's decay signal. **A suppression that perturbs another
//     guard's metric is not free.**
const EDGE_ROOT = "supabase/functions"
const SOLANA_SURFACE = /candy|solana|base58|magic_eden/i

/** `"0x" + …toLowerCase()` in either order. */
const FOLD_AND_PREFIX =
  /["'`]0x["'`]\s*\+\s*[^;\n]{0,80}?\.toLowerCase\(\)|\.toLowerCase\(\)[^;\n]{0,80}?\+\s*["'`]0x["'`]/

const MARKER = /base58-fold:\s*intentional/i
const LOOKBACK = 6

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue
      walk(full, out)
    } else if (/\.(ts|tsx|mjs)$/.test(entry) && !entry.includes(".test.")) {
      out.push(full)
    }
  }
  return out
}

type Hit = { file: string; line: number; text: string }

function scan(): { hits: Hit[]; filesInspected: number } {
  const hits: Hit[] = []
  let filesInspected = 0
  for (const file of ROOTS.flatMap((r) => walk(r))) {
    filesInspected++
    const raw = readFileSync(file, "utf8")
    const rawLines = raw.split("\n")
    // Strip comments for the MATCH (a documented example must not be a hit)…
    stripComments(raw)
      .split("\n")
      .forEach((line, i) => {
        if (!FOLD_AND_PREFIX.test(line)) return
        // …but read the marker off the RAW lines, because it lives in a comment.
        if (isMarkerSuppressed(rawLines, i, MARKER, LOOKBACK)) return
        hits.push({ file, line: i + 1, text: line.trim().slice(0, 140) })
      })
  }
  return { hits, filesInspected }
}

describe("no address is fold-and-prefixed without saying why", () => {
  const { hits, filesInspected } = scan()

  it("the scan actually ran — ASSERT THE COUNT IT INSPECTED", () => {
    // THE TELL IS SILENCE. A guard that normally states its count and then says
    // nothing has not passed, it has not spoken: a bad root or a moved
    // directory would make this whole file a green no-op.
    expect(filesInspected).toBeGreaterThan(1000)
    console.log(`[fold-and-prefix guard] ${filesInspected} source file(s) inspected`)
  })

  it("is satisfiable at a population of ZERO — it does not punish its own success", () => {
    // A guard that requires instances to exist dies the day the class is gone.
    expect(Array.isArray(hits)).toBe(true)
  })

  it("THE EXCLUSION'S PREMISE STILL HOLDS: no edge function has a Solana surface", () => {
    // This is what makes skipping `supabase/functions` an exclusion rather than
    // a blind spot. The day an edge function starts handling a Candy address,
    // this arm reds and the root has to come back into ROOTS (and the two
    // known fold-and-prefix sites there — the Cadence `owner` in
    // _shared/pack-opens-rip-parse.ts and backfill-pack-opens-api/index.ts —
    // have to be re-examined rather than marked).
    const edgeFiles = walk(EDGE_ROOT)
    expect(edgeFiles.length).toBeGreaterThan(20) // the census ran
    const withSolana = edgeFiles.filter((f) => SOLANA_SURFACE.test(readFileSync(f, "utf8")))
    console.log("DEBUG cwd", process.cwd(), "files", edgeFiles.length, "withSolana", JSON.stringify(withSolana), "re", String(SOLANA_SURFACE))
    expect(
      withSolana,
      withSolana.length === 0
        ? ""
        : "an edge function now has a Solana surface, so supabase/functions can no longer be " +
          "excluded from the fold-and-prefix ban. Put it back in ROOTS and re-examine the two " +
          "Cadence-by-construction sites there:\n" + withSolana.join("\n"),
    ).toEqual([])
    console.log(`[fold-and-prefix guard] ${edgeFiles.length} edge function file(s) censused, 0 with a Solana surface`)
  })

  it("POSITIVE CONTROL: the matcher sees the real shape, and the marker hides it", () => {
    // A guard nobody has watched fail is indistinguishable from one that
    // inspects nothing, so plant the exact expression rather than trusting it.
    const planted = [
      `const w = a.startsWith("0x") ? a.toLowerCase() : "0x" + a.toLowerCase();`,
      `const k = (raw ?? "").toLowerCase() + "0x";`,
    ]
    for (const p of planted) expect(FOLD_AND_PREFIX.test(p)).toBe(true)

    // …and things that merely look similar must NOT match.
    for (const ok of [
      `const w = normalizeAddress(a);`,
      `const w = walletQueryKey(a);`,
      `const t = tier.toLowerCase();`,
      `const s = "0x" + hash;`,
    ]) {
      expect(FOLD_AND_PREFIX.test(ok)).toBe(false)
    }

    // The hatch opens: marker on the line above the match.
    const withMarker = [
      `// base58-fold: intentional — a 20-byte EVM topic slice is hex by construction`,
      planted[0],
    ]
    expect(isMarkerSuppressed(withMarker, 1, MARKER, LOOKBACK)).toBe(true)
    // …and does not open without it.
    expect(isMarkerSuppressed(["// something else", planted[0]], 1, MARKER, LOOKBACK)).toBe(false)
  })

  it("no unmarked fold-and-prefix survives in the tree", () => {
    expect(
      hits,
      hits.length === 0
        ? ""
        : "these build an address by folding to lower case and prepending 0x, which DESTROYS a base58 " +
          "(Solana/Candy) address and publishes the wreckage as a fact. Use lib/address.ts — " +
          "`normalizeAddress` for a storage key, `walletQueryKey` for a DB key, `displayAddress` for a " +
          "rendered label — or, where the value cannot be base58 BY CONSTRUCTION, add " +
          "`base58-fold: intentional — <why>` in a comment above it:\n" +
          hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n"),
    ).toEqual([])
  })
})
