import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN AT ZERO: an outbound marketplace click logged WITHOUT its collection.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// outbound_clicks rows are matched to the marketplace sale that follows them
// (audit_20260930, click_attributed_purchases) on (collection, moment id) or
// (collection, edition key). A moment id is unique only WITHIN a collection
// (CLAUDE.md, #142), so a click that does not say which collection it belongs
// to can only be matched by sniffing its URL host — which says nothing for
// dapper.market packs, Magic Eden, or an internal fallback href. Before this
// guard every one of the ~20 tracked call sites omitted it.
//
// ── WHAT IT WALKS ───────────────────────────────────────────────────────────
// A TREE WALK over app/ components/ lib/ (.ts/.tsx; __tests__, node_modules,
// .next, .claude excluded — the last is a second checkout, see CLAUDE.md
// "PERFECT RATIO"). It finds, in comment-stripped source:
//   1. every `trackOutboundClick(` CALL (lib/track-click.ts),
//   2. every `<TrackedOutboundLink` element,
//   3. every `trackClick(` call in a file that imports trackClick from
//      @/lib/sniper/helpers,
// and requires the call's ARGUMENT span (or the element's opening tag) to name
// `collection` as an object key — `collection:` or the shorthand `collection,`
// / `collection }`. Function DEFINITIONS (`function trackOutboundClick(`) are
// not calls and are skipped.
//
// No allowlist. A caller that genuinely does not know its collection writes
// `collection: null` — explicit, greppable, and a claim a reviewer can check —
// never an omission and never a Top Shot default (CLAUDE.md "SUBSTITUTION").
//
// ── WHAT THIS IS STRUCTURALLY SILENT ABOUT, stated rather than implied ──────
//  1. Whether the VALUE is right. `collection: "nba-top-shot"` on an All Day
//     row passes. It reads the key's presence, never its truth.
//  2. A payload built in a variable and passed by name (`trackOutboundClick(p)`)
//     fails here even if `p` carries a collection — a false POSITIVE, by design:
//     write the key at the call.
//  3. A local wrapper (MarketClient's trackListingClick, PackTable's
//     trackPackBuyClick, …) is checked at its inner trackOutboundClick call,
//     not at the wrapper's call sites; its signature makes the argument
//     required, which tsc enforces.
//  4. An outbound <a> that is not tracked AT ALL. The second describe below
//     covers the subset whose href NAMES a marketplace URL; an href held in a
//     generic variable (`m.href`) is invisible to it.

const ROOT = join(__dirname, "..")
const ROOTS = ["app", "components", "lib"]
const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next", ".claude"])

function walk(dir: string, out: string[]) {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
}

const FILES: string[] = []
for (const r of ROOTS) walk(join(ROOT, r), FILES)

/** Text from `open` (an index of "(" or "<") to its balanced close. */
function balancedParenSpan(src: string, openIdx: number): string {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1)
    }
  }
  return src.slice(openIdx)
}

/** A JSX opening tag from `<Name` to the `>` / `/>` at brace depth 0. */
function openingTagSpan(src: string, ltIdx: number): string {
  let depth = 0
  for (let i = ltIdx + 1; i < src.length; i++) {
    const c = src[i]
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === ">" && depth === 0) return src.slice(ltIdx, i + 1)
  }
  return src.slice(ltIdx)
}

const NAMES_COLLECTION = /(^|[{,\s])collection\s*(:|,|\})/

export type Site = { file: string; line: number; kind: string; ok: boolean }

export function inspectSource(file: string, raw: string): Site[] {
  const src = stripComments(raw)
  const sites: Site[] = []
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length

  const callRe = /\btrackOutboundClick\s*\(/g
  for (let m; (m = callRe.exec(src)); ) {
    const before = src.slice(Math.max(0, m.index - 20), m.index)
    if (/function\s+$/.test(before)) continue
    const span = balancedParenSpan(src, m.index + m[0].length - 1)
    sites.push({ file, line: lineOf(m.index), kind: "trackOutboundClick", ok: NAMES_COLLECTION.test(span) })
  }

  const linkRe = /<TrackedOutboundLink\b/g
  for (let m; (m = linkRe.exec(src)); ) {
    const span = openingTagSpan(src, m.index)
    sites.push({ file, line: lineOf(m.index), kind: "TrackedOutboundLink", ok: NAMES_COLLECTION.test(span) })
  }

  if (/import\s*\{[^}]*\btrackClick\b[^}]*\}\s*from\s*["']@\/lib\/sniper\/helpers["']/.test(src)) {
    const tcRe = /\btrackClick\s*\(/g
    for (let m; (m = tcRe.exec(src)); ) {
      const before = src.slice(Math.max(0, m.index - 20), m.index)
      if (/function\s+$/.test(before)) continue
      const span = balancedParenSpan(src, m.index + m[0].length - 1)
      sites.push({ file, line: lineOf(m.index), kind: "sniper trackClick", ok: NAMES_COLLECTION.test(span) })
    }
  }
  return sites
}

const SITES: Site[] = FILES.flatMap((f) => inspectSource(relative(ROOT, f), readFileSync(f, "utf8")))

describe("every outbound marketplace click carries its collection (ban at zero)", () => {
  it("inspects a real population (a guard that inspected nothing has not passed)", () => {
    const byKind = SITES.reduce<Record<string, number>>((acc, s) => {
      acc[s.kind] = (acc[s.kind] ?? 0) + 1
      return acc
    }, {})
    // Stated, so a run that suddenly says nothing is visibly SILENT, not green.
    console.log(`[outbound-clicks-carry-their-collection] walked ${FILES.length} files, inspected ${SITES.length} sites`, byKind)
    expect(FILES.length).toBeGreaterThan(100)
    expect(SITES.length).toBeGreaterThan(0)
    expect(byKind["trackOutboundClick"] ?? 0).toBeGreaterThan(0)
    expect(byKind["TrackedOutboundLink"] ?? 0).toBeGreaterThan(0)
    expect(byKind["sniper trackClick"] ?? 0).toBeGreaterThan(0)
  })

  it("no call site omits `collection`", () => {
    const missing = SITES.filter((s) => !s.ok).map((s) => `${s.file}:${s.line} (${s.kind})`)
    expect(missing).toEqual([])
  })

  // Planted defects — the guard must SEE a missing key, in each of its three
  // shapes, and must not be satisfied by an identifier merely CONTAINING the
  // word (collectionUrlSlug) or by a comment.
  it("reds a planted defect in each shape (and is not fooled by look-alikes)", () => {
    const bad = [
      `trackOutboundClick({ surface: "x", momentId: "1" })`,
      `<TrackedOutboundLink href={u} payload={{ surface: "x", collectionUrlSlug: s }}>go</TrackedOutboundLink>`,
      `import { trackClick } from "@/lib/sniper/helpers";\ntrackClick(deal, null, { href: u, linkKind: "listing" })`,
      `trackOutboundClick({ surface: "x" /* collection: c */ })`,
    ]
    for (const src of bad) {
      const sites = inspectSource("planted.tsx", src)
      expect(sites.length, src).toBeGreaterThan(0)
      expect(sites.every((s) => !s.ok), src).toBe(true)
    }
    const good = [
      `trackOutboundClick({ surface: "x", collection: null })`,
      `trackOutboundClick({ surface, collection, momentId })`,
      `<TrackedOutboundLink href={u} payload={{ collection: coll.dbSlug }}>go</TrackedOutboundLink>`,
      `import { trackClick } from "@/lib/sniper/helpers";\ntrackClick(deal, null, { collection: c, href: u, linkKind: "dapper" })`,
    ]
    for (const src of good) {
      const sites = inspectSource("planted.tsx", src)
      expect(sites.length, src).toBeGreaterThan(0)
      expect(sites.every((s) => s.ok), src).toBe(true)
    }
    // A definition is not a call.
    expect(inspectSource("d.ts", `export function trackOutboundClick(payload: P): void {}`)).toEqual([])
  })
})

// ── Second guard: an <a> whose href NAMES a marketplace URL must be tracked ──
// Narrow by construction (see silence #4 above): it reads only anchors whose
// href is an EXPRESSION (a per-item URL) that mentions a marketplace URL builder, a marketplace host, or a
// buy/listing/dapper URL variable, and requires an onClick on the same opening
// tag. <TrackedOutboundLink> is a different element and is covered above.
const MARKETPLACE_HREF =
  /\b(marketplaceMomentUrl|dapperMarket\w*|topshotPackUrl|paniniEditionUrl|buy_?url|buyUrl|listing_?url|listingUrl|dapper\w*Url|viewUrl|ddUrl|ddDapper)\b|nbatopshot\.com|nflallday\.com|laligagolazos\.com|disneypinnacle\.com|dapper\.market|magiceden\.io|paniniamerica\.net|ufcstrike\.com/i

export function inspectAnchors(file: string, raw: string): Site[] {
  const src = stripComments(raw)
  const out: Site[] = []
  const re = /<a\b/g
  for (let m; (m = re.exec(src)); ) {
    const tag = openingTagSpan(src, m.index)
    // Only an EXPRESSION href. A string-literal href is the same URL for every
    // reader (FastBreak's "Official Fast Break page", a marketplace homepage)
    // and names no listing, so there is no sale to attribute it to.
    const hrefM = /\bhref=\{/.exec(tag)
    if (!hrefM) continue
    const hrefExpr = balancedParenSpan(tag, hrefM.index + hrefM[0].length - 1)
    if (!MARKETPLACE_HREF.test(hrefExpr)) continue
    // Only the image/asset CDN hosts are not marketplace pages.
    if (/assets\.|media\.|\/img\//.test(hrefExpr)) continue
    out.push({ file, line: src.slice(0, m.index).split("\n").length, kind: "marketplace <a>", ok: /\bonClick=/.test(tag) })
  }
  return out
}

const ANCHORS: Site[] = FILES.filter((f) => f.endsWith(".tsx")).flatMap((f) =>
  inspectAnchors(relative(ROOT, f), readFileSync(f, "utf8")),
)

describe("a marketplace <a> carries a click tracker", () => {
  it("inspects a real population", () => {
    console.log(`[outbound-clicks-carry-their-collection] inspected ${ANCHORS.length} marketplace anchors`)
    expect(ANCHORS.length).toBeGreaterThan(0)
  })

  it("every one has an onClick", () => {
    const untracked = ANCHORS.filter((s) => !s.ok).map((s) => `${s.file}:${s.line}`)
    expect(untracked).toEqual([])
  })

  it("reds a planted untracked anchor", () => {
    const sites = inspectAnchors("p.tsx", `<a href={dapperUrl} target="_blank" rel="noopener noreferrer">Dapper</a>`)
    expect(sites).toHaveLength(1)
    expect(sites[0].ok).toBe(false)
    const ok = inspectAnchors("p.tsx", `<a href={dapperUrl} onClick={() => t()}>Dapper</a>`)
    expect(ok[0].ok).toBe(true)
  })
})
