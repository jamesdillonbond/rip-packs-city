import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// SURFACE CONTRACT — /insights/deals must describe the board it actually serves,
// and must not publish internal FMV scoring vocabulary while doing it.
//
// ── Why (2026-07-28) ───────────────────────────────────────────────────────
// Two defects on the same public, unauthenticated, SEO-indexed page:
//
//  1. UNDISCLOSED COLLECTION. cross_collection_deals_board UNIONs THREE legs —
//     Top Shot, NFL All Day, Disney Pinnacle. All Day is the LARGEST of them
//     (measured live: 68 of 142 rows, 47%, at the default >=10% gap). Every
//     surface describing the board named only Top Shot + Pinnacle, there was no
//     All Day filter chip, and the public API's VALID_COLLECTIONS allowlist
//     returned HTTP 400 for collection=nfl_all_day with an error naming the
//     only "valid" values. A consumer could not filter to the biggest slice of
//     the payload and was told it did not exist.
//
//  2. INTERNAL CONFIDENCE VOCABULARY. The FMV-basis control published our
//     HIGH / MEDIUM enum as user-facing chip text and prose. A visitor cannot
//     calibrate those labels. Per the standing no-confidence-UI policy the
//     CONTROL stays (on a deals board, "only show me well-established fair
//     values" is the most honest filter there is) but the vocabulary comes off
//     — it is now Standard / Strict, with identical behaviour and an unchanged
//     confidence=HIGH query param.
//
// If a leg is added to or removed from the view, update these expectations —
// do not weaken them. Silence about a leg is the bug this file exists to catch.
//
// ── 2026-09-19: a FOURTH leg, Candy MLB ────────────────────────────────────
// mv_cross_collection_deals gained a candy_mlb arm (41 editions at the time,
// third largest of the four). Every expectation below was extended rather than
// relaxed, because the 2026-07-28 defect was not "All Day specifically" — it
// was a leg shipping into the view while every surface stayed silent about it,
// and the allowlist answering HTTP 400 for rows the payload already contained.
//
// ⚠ ONE THING IS DELIBERATELY *NOT* CLAIMED FOR CANDY: the Net-of-fees column.
// `sellerFeeFor("candy_mlb")` returns null — Magic Eden's seller rate has not
// been read from the source and lib/marketplace-fees.ts requires a sourceUrl
// and a verifiedOn date — so those rows render an em-dash. That is the file's
// documented behaviour for an unverified rate, and inventing a rate on a
// net-proceeds column is worse than showing nothing. The column header says so.

const REPO = process.cwd()

const CLIENT = path.join(REPO, "app", "insights", "deals", "DealsBoardClient.tsx")
const LAYOUT = path.join(REPO, "app", "insights", "deals", "layout.tsx")
const OG = path.join(REPO, "app", "api", "og", "insights", "deals", "route.tsx")
const API = path.join(REPO, "app", "api", "public", "insights", "deals", "route.ts")
const HUB = path.join(REPO, "app", "insights", "page.tsx")

const read = (p: string) => readFileSync(p, "utf8")

/**
 * Strip comments so the "do not reintroduce" notes — which must name the
 * removed labels to be useful — don't trip the vocabulary scan.
 */

describe("/insights/deals names every collection it serves", () => {
  it("the client exposes an All Day filter chip alongside Top Shot and Pinnacle", () => {
    const src = read(CLIENT)
    expect(src).toContain('key: "nba_top_shot"')
    expect(src).toContain('key: "nfl_all_day"')
    expect(src).toContain('key: "disney_pinnacle"')
    expect(src).toContain('key: "candy_mlb"')
    // The union type must admit them too, or the chips won't typecheck.
    expect(src).toMatch(/type CollectionFilter =[^\n]*nfl_all_day/)
    expect(src).toMatch(/type CollectionFilter =[^\n]*candy_mlb/)
  })

  it("the public API allowlists nfl_all_day and candy_mlb", () => {
    const src = read(API)
    const m = /const VALID_COLLECTIONS = new Set\(\[([^\]]*)\]\)/.exec(src)
    expect(m, "VALID_COLLECTIONS literal not found").toBeTruthy()
    const listed = m![1]
    expect(listed).toContain("nba_top_shot")
    expect(listed).toContain("nfl_all_day")
    expect(listed).toContain("disney_pinnacle")
    // A leg in the view but not in the allowlist answers HTTP 400 for rows the
    // payload already carries — the 2026-07-28 defect, repeated.
    expect(listed).toContain("candy_mlb")
  })

  it.each([
    ["client board", CLIENT],
    ["SEO layout", LAYOUT],
    ["OG card", OG],
    ["insights hub card", HUB],
  ])("%s names All Day, not just Top Shot + Pinnacle", (_label, file) => {
    const code = stripComments(read(file))
    expect(code).toMatch(/All Day/)
  })

  it.each([
    ["client board", CLIENT],
    ["SEO layout", LAYOUT],
    ["OG card", OG],
    ["insights hub card", HUB],
  ])("%s names Candy MLB, the fourth leg", (_label, file) => {
    const code = stripComments(read(file))
    expect(code).toMatch(/Candy MLB/)
  })

  it("no surface still claims the board is Top-Shot-plus-Pinnacle only", () => {
    const offenders: string[] = []
    for (const file of [CLIENT, LAYOUT, OG, HUB]) {
      const code = stripComments(read(file))
      // The exact shape of the old claim: Top Shot and Pinnacle adjacent with
      // no All Day between them.
      // ⚠ The old TWO-collection claim. It is still the thing to catch: a
      // surface that lists Top Shot and Pinnacle adjacent with nothing between
      // them has dropped both later legs at once.
      const re = /Top Shot\s*(?:\+|and)\s*(?:Disney\s*)?Pinnacle/i
      const m = re.exec(code)
      if (m) offenders.push(`${path.relative(REPO, file)} — "${m[0]}"`)
    }
    expect(offenders, `these still describe a two-collection board:\n${offenders.join("\n")}`).toEqual([])
  })
})

describe("/insights/deals publishes no internal FMV confidence vocabulary", () => {
  // The one legitimate technical use: the client passes the tier to the API as
  // a query param. That is data on the wire, not a rendered label.
  const ALLOWED = [/params\.set\("confidence", "HIGH"\)/g]

  it.each([
    ["client board", CLIENT],
    ["SEO layout", LAYOUT],
    ["OG card", OG],
  ])("%s renders no HIGH/MEDIUM/ASK_ONLY/STALE label", (_label, file) => {
    let code = stripComments(read(file))
    for (const re of ALLOWED) code = code.replace(re, "")
    // Case-SENSITIVE, word-boundary: the enum is uppercase. This deliberately
    // does not match `low_ask` / `low_confidence_fmv` (lowercase identifiers)
    // or the word "BELOW" (no boundary before LOW).
    const m = /\b(?:HIGH|MEDIUM|ASK_ONLY|STALE)\b/.exec(code)
    expect(
      m ? `${path.relative(REPO, file)} — "${m[0]}" at char ${m.index}` : null,
      "internal confidence tiers must not appear as user-facing text",
    ).toBeNull()
  })

  it("the old chip labels are gone and the control still exists", () => {
    const code = stripComments(read(CLIENT))
    expect(code).not.toMatch(/High \+ Med/)
    expect(code).not.toMatch(/High only/)
    // Relabelled, not deleted — the filter is the reader's defence against a
    // discount computed off an FMV we don't fully trust.
    expect(code).toContain(">\n            Standard\n          </button>")
    expect(code).toContain(">\n            Strict\n          </button>")
    expect(code).toContain('params.set("confidence", "HIGH")')
  })

  it("no surface still says 'confidence-rated'", () => {
    const offenders: string[] = []
    for (const file of [CLIENT, LAYOUT, OG, HUB]) {
      if (/confidence-rated/i.test(stripComments(read(file)))) {
        offenders.push(path.relative(REPO, file))
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("/insights/deals methodology states the real minimum ask", () => {
  // The board's minimum ask is NOT uniform: Top Shot gates at $5, All Day and
  // Pinnacle at $1, so ~40% of rows sit under $5. The copy asserted a blanket
  // "$5+" floor, which was false for two of the three legs.
  it("does not assert a blanket $5 floor across the whole board", () => {
    const code = stripComments(read(CLIENT))
    expect(code).not.toMatch(/board is gated to a floor of/i)
    // Both real thresholds are named.
    expect(code).toMatch(/\$5\+/)
    expect(code).toMatch(/\$1\+/)
  })
})
