import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { rootMetadata, OG_INHERITED, TWITTER_INHERITED } from "@/lib/seo"

// BAN: an `app/**` metadata export that defines its own `openGraph` / `twitter`
// object must carry the fields the ROOT supplies — by spreading OG_INHERITED /
// TWITTER_INHERITED, or by restating them.
//
// ── THE TRAP ───────────────────────────────────────────────────────────────
// Next merges page metadata into the root export at the TOP-LEVEL key only.
// Defining `openGraph` (or `twitter`) in a child REPLACES the root's block
// outright, so every field the child omits is simply gone from the rendered
// tags. `lib/seo.ts` documents this (deep-audit R10) and fixes it for its three
// shared helpers.
//
// ── WHY THIS FILE EXISTS: THE R10 GUARD NAMED THREE HELPERS INSTEAD OF WALKING
//    THE TREE, AND THE POPULATION IT COULD NOT SEE WAS 43 FILES ─────────────
// `seo-shared-helpers-inherit-og-twitter.test.ts` pins `pageMetadata`,
// `collectionLayoutMetadata` and `buildMeta`. That is correct and stays. But it
// is a CURATED LIST, so every `app/**` file that builds its metadata inline was
// outside it by construction — measured 2026-08-17: **43 files**, of which
// **31 were the /insights board layouts**, each setting `creator` and omitting
// `site`.
//
// ⚠ THAT IS THE EXACT SYMPTOM R10 WAS FILED FOR. lib/seo.ts:60-63 records it:
// "`site` attributes the CARD to the account … X shows the site handle in the
// card byline, and it was missing at the root — so every page that does not
// define its own twitter block unfurled with no attribution at all." The root
// was fixed; the boards define their own block, so they kept dropping it, on
// the surface this repo calls the most shareable thing it has. **A guard that
// names its instances is silent about the population it did not name** — the
// repo's most-repeated lesson, and this is its SEO instance.
//
// ⚠ REQUIRED FIELDS ARE DERIVED, NEVER RESTATED. They come from the exported
// OG_INHERITED / TWITTER_INHERITED, and a separate case asserts those actually
// match `rootMetadata`. So adding a field at the root and to the inherited const
// widens this ban for free, instead of leaving a new hole that reads as covered.

const APP_DIR = join(process.cwd(), "app")

const OG_FIELDS = Object.keys(OG_INHERITED)
const TW_FIELDS = Object.keys(TWITTER_INHERITED)

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p)
  }
  return out
}

/**
 * Balanced-brace extraction of every `<key>: { … }` object literal.
 *
 * ⚠ A regex over the call head is not enough: these blocks nest (`images: [{…}]`)
 * and run to 20 lines, so the fields we care about can sit anywhere inside. The
 * leading-boundary group keeps `openGraph:` from matching `foo.openGraph:`.
 *
 * ⚠ AND THE SCANNER MUST BE STRING-AWARE, which the first version was not — my
 * own nested fixture caught it. A `}` inside a quoted `alt:` string closes the
 * block early, so the tail is never read and the guard reports fields that ARE
 * present. A FALSE POSITIVE is the expensive direction here: it reds CI on
 * correct code, and the next person weakens the guard to get green. Backticks
 * matter most — these files build URLs as `${SITE_URL}/…` templates.
 */
export function objectLiterals(src: string, key: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${key}\\s*:\\s*\\{`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index + m[0].length - 1)
    let i = open + 1
    let depth = 1
    let quote: string | null = null
    while (i < src.length && depth > 0) {
      const c = src[i]
      const prev = src[i - 1]
      if (quote) {
        if (c === quote && prev !== "\\") quote = null
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c
      } else if (c === "{") depth++
      else if (c === "}") depth--
      i++
    }
    out.push(src.slice(open + 1, i - 1))
  }
  return out
}

export function blockSatisfies(body: string, field: string, konst: string): boolean {
  if (new RegExp(`\\.\\.\\.\\s*${konst}\\b`).test(body)) return true
  return new RegExp(`(^|[\\s{,])${field}\\s*:`).test(body)
}

type Hit = { file: string; key: string; missing: string[] }

function scan(): { hits: Hit[]; blocksSeen: number; filesSeen: number } {
  const hits: Hit[] = []
  let blocksSeen = 0
  let filesSeen = 0
  for (const full of walk(APP_DIR)) {
    const src = readFileSync(full, "utf8")
    if (!/export\s+(async\s+)?(const|function)\s+(metadata|generateMetadata)/.test(src)) continue
    filesSeen++
    const rel = relative(process.cwd(), full).split(sep).join("/")
    for (const [key, fields, konst] of [
      ["openGraph", OG_FIELDS, "OG_INHERITED"],
      ["twitter", TW_FIELDS, "TWITTER_INHERITED"],
    ] as const) {
      for (const body of objectLiterals(src, key)) {
        blocksSeen++
        const missing = fields.filter((f) => !blockSatisfies(body, f, konst))
        if (missing.length) hits.push({ file: rel, key, missing })
      }
    }
  }
  return { hits, blocksSeen, filesSeen }
}

describe("inline app/** metadata blocks inherit the root openGraph/twitter fields", () => {
  it("the walk still finds the metadata population (not vacuously passing)", () => {
    // ⚠ Asserts on the ENUMERATOR, never on how many blocks are still dirty — a
    // not-vacuous check must be satisfiable at a population of ZERO, which is
    // where the violation set now sits. Measured 2026-08-17: 86 files, 87
    // blocks; the floors are set well under so ordinary churn does not red CI,
    // while a walker that silently stopped seeing the tree does.
    const { filesSeen, blocksSeen } = scan()
    expect(filesSeen).toBeGreaterThan(60)
    expect(blocksSeen).toBeGreaterThan(65)
  })

  it("the inherited constants really are what the root supplies", () => {
    // Closes the loop: the ban is only meaningful if the fields it demands are
    // the fields a child actually loses. Restating them here would let the two
    // drift silently, which is the failure this whole file is about.
    const og = rootMetadata.openGraph as Record<string, unknown>
    const tw = rootMetadata.twitter as Record<string, unknown>
    for (const [k, v] of Object.entries(OG_INHERITED)) expect(og[k], `root openGraph.${k}`).toBe(v)
    for (const [k, v] of Object.entries(TWITTER_INHERITED)) expect(tw[k], `root twitter.${k}`).toBe(v)
    expect(OG_FIELDS.length).toBeGreaterThan(0)
    expect(TW_FIELDS.length).toBeGreaterThan(0)
  })

  it("no inline block drops a field the root supplies", () => {
    const { hits } = scan()
    const report = hits.map((h) => `${h.file} — ${h.key} missing ${h.missing.join(", ")}`).join("\n")
    expect(
      report,
      "these blocks REPLACE the root block and lose fields (spread OG_INHERITED / " +
        "TWITTER_INHERITED into them):\n" + report,
    ).toBe("")
  })

  // ── guards-the-guard ──────────────────────────────────────────────────────

  it("flags the exact pre-fix /insights board twitter block", () => {
    // ⚠ Pinned as SOURCE, not as a file path — three guards in this repo have
    // died on a rename. This is app/insights/squeeze/layout.tsx as it stood
    // before this pass: creator set, `site` absent.
    const preFix = [
      "  twitter: {",
      '    card: "summary_large_image",',
      '    title: "Top Shot Lock-Rate Squeeze Board",',
      '    images: [`${SITE_URL}/api/og/insights/squeeze`],',
      '    creator: "@RipPacksCity",',
      "  },",
    ].join("\n")
    const [body] = objectLiterals(preFix, "twitter")
    expect(body).toBeTruthy()
    expect(TW_FIELDS.filter((f) => !blockSatisfies(body, f, "TWITTER_INHERITED"))).toEqual(["site"])

    // ...and the shipped fix — a spread — clears every field at once.
    const [fixed] = objectLiterals(preFix.replace("  twitter: {", "  twitter: {\n    ...TWITTER_INHERITED,"), "twitter")
    expect(TW_FIELDS.filter((f) => !blockSatisfies(fixed, f, "TWITTER_INHERITED"))).toEqual([])
  })

  it("reads a field out of a block that nests arrays and objects", () => {
    // The `images: [{ … }]` shape is why the extractor is brace-balanced rather
    // than a head regex: a naive match stops at the first inner `}` and would
    // report `siteName` missing on a block that has it.
    const nested = [
      "openGraph: {",
      '  title: "x",',
      "  images: [{ url: `${U}/og`, width: 1200, height: 630, alt: `a } b` }],",
      '  siteName: "Rip Packs City",',
      '  locale: "en_US",',
      '  type: "website",',
      "},",
    ].join("\n")
    const [body] = objectLiterals(nested, "openGraph")
    expect(OG_FIELDS.filter((f) => !blockSatisfies(body, f, "OG_INHERITED"))).toEqual([])
  })

  it("does not credit a field that is merely a SUBSTRING of another key", () => {
    // `siteName:` must not satisfy a demand for `site:`, or every openGraph
    // block would silently satisfy the twitter rule and the ban would pass
    // over nothing.
    expect(blockSatisfies('siteName: "Rip Packs City",', "site", "TWITTER_INHERITED")).toBe(false)
    expect(blockSatisfies('site: "@RipPacksCity",', "site", "TWITTER_INHERITED")).toBe(true)
  })

  it("does not credit the WRONG spread", () => {
    // Spreading OG_INHERITED into a twitter block supplies none of its fields.
    expect(blockSatisfies("...OG_INHERITED, title: 'x'", "site", "TWITTER_INHERITED")).toBe(false)
    expect(blockSatisfies("...TWITTER_INHERITED, title: 'x'", "site", "TWITTER_INHERITED")).toBe(true)
  })
})
