import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// EVERY MOMENT THUMBNAIL REACHES AN <img> THROUGH THE IPFS PROXY.
//
// ⚠ THIS IS A LIVE DEFECT CLASS, MEASURED IN PRODUCTION 2026-09-13, not a
// precaution. All **518** UFC Strike editions and **2,368** pre-2022 Top Shot
// editions store a PUBLIC IPFS GATEWAY url (2,886 rows in total, live count).
// Probed from the database's own egress:
//
//   · `ipfs.io` (UFC)               5 of 6 sampled TIMED OUT at 15,001 ms —
//     DNS and TLS fine, then nothing; a separate probe answered **429** with a
//     gateway RETIREMENT notice ("switching to a service worker gateway only").
//   · `ipfs.dapperlabs.com` (Top Shot)  10 of 10 alive — Dapper serves its own
//     pinned CIDs, so THAT half is fine today and is the reason this reads as a
//     UFC problem rather than a 2,886-row one. ⚠ It is one gateway policy change
//     away from not being.
//
// `lib/ipfs-media.ts` → `proxyIpfsUrl()` rewrites those urls onto our own
// edge-cached `/api/public/ipfs-media/<cid>`, which races three gateways. A
// surface that skips it hotlinks a host that currently times out.
//
// ⭐ AND IT WAS NOT HYPOTHETICAL ON ANY OF THEM: `/api/search?q=adesanya` in
// PRODUCTION returns **3 raw `ipfs.io` urls and 0 proxied**, and
// `components/search/GlobalSearch.tsx` rendered `h.thumbnailUrl` straight into
// an `<img src>`. That is how this class was found — by probing the API, not by
// reading the component.
//
// ⚠ WHY A TREE WALK AND NOT A LIST: the rewrite already existed and was applied
// in 9 places and skipped in 13. A curated list of "surfaces that show Moments"
// is exactly what went stale — the defect spreads by copy-paste, so the
// population has to be the tree.
// ─────────────────────────────────────────────────────────────────────────────

const ROOTS = ["components", "app"]

/** Identifiers that carry EDITION/MOMENT art, i.e. the ones that can be IPFS. */
const THUMB =
  /(thumbnail_url|thumbnailUrl|thumb_url|thumbUrl|portrait_thumbnail|max_pull_thumbnail)/

/**
 * Helpers that resolve a moment thumbnail. Each either calls `proxyIpfsUrl`
 * itself (`getThumbnailUrl`, `thumbnailSrc`, `resizedThumb`, `tsTileImg`) or is
 * composed with it at the call site (`hiResThumb`).
 *
 * ⚠ ASSERTED, NOT LISTED FROM MEMORY — the case below reads each helper's
 * source and fails if one stops rewriting, which is what stops this list from
 * becoming a set of exemptions nobody re-checks.
 */
const REWRITERS = /(proxyIpfsUrl|getThumbnailUrl|thumbnailSrc|resizedThumb|tsTileImg|hiResThumb)/

/** Helpers whose OWN body must contain the rewrite for the exemption to hold. */
const REWRITER_SOURCES: Array<[string, string]> = [
  ["lib/collection/helpers.ts", "getThumbnailUrl"],
  ["lib/pack-dist-format.ts", "tsTileImg"],
  ["lib/pack-lifecycle-format.ts", "resizedThumb"],
]

/**
 * ⛔ SUPPRESSION, NOT AN EXEMPTION LIST — one entry, and it is a limit of the
 * MATCHER rather than of the rule: the value is proxied one line earlier
 * (`const thumbUrl = getThumbnailUrl(row, collectionSlug)`), which an
 * expression-local check cannot see. Pinned with the reason so a future reader
 * can re-derive it instead of trusting it.
 */
const SUPPRESSED = new Set(["components/collection/CollectionMomentTable.tsx"])

/**
 * `app/api/og/**` is excluded because those routes never emit an `<img src>` a
 * browser resolves: every url goes through `ogImageDataUri` → `ogImageTarget`,
 * which performs the SAME rewrite server-side and hands satori a data URI.
 * ⚠ That is a claim about another module, so it is asserted below rather than
 * trusted — `lib/og/img-data.ts` must still carry the gateway rewrite.
 */
const EXCLUDED_PREFIX = "app/api/og/"

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== "node_modules") tsxFiles(p, out)
    } else if (e.name.endsWith(".tsx")) out.push(p)
  }
  return out
}

function offenders(): string[] {
  const found: string[] = []
  const files = ROOTS.flatMap((r) => tsxFiles(path.join(process.cwd(), r)))
  expect(files.length, "no .tsx files scanned — the walk is measuring nothing").toBeGreaterThan(100)
  for (const abs of files) {
    const rel = path.relative(process.cwd(), abs).replace(/\\/g, "/")
    if (rel.startsWith(EXCLUDED_PREFIX) || SUPPRESSED.has(rel)) continue
    const src = stripComments(fs.readFileSync(abs, "utf8"))
    for (const m of src.matchAll(/src=\{([^}]*)\}/g)) {
      const expr = m[1]
      if (THUMB.test(expr) && !REWRITERS.test(expr)) {
        const line = src.slice(0, m.index).split("\n").length
        found.push(`${rel}:${line}  src={${expr.trim().slice(0, 60)}}`)
      }
    }
  }
  return found
}

describe("a Moment thumbnail cannot reach an <img> without the IPFS proxy", () => {
  it("BAN AT ZERO — no surface renders a raw moment thumbnail", () => {
    expect(
      offenders(),
      "these render a stored thumbnail straight into an <img>. 2,886 editions " +
        "carry a public IPFS gateway url and the UFC half currently TIMES OUT, so a " +
        "raw render is a broken tile. Wrap it: proxyIpfsUrl(x) ?? undefined.",
    ).toEqual([])
  })

  it("the helpers this guard exempts really do rewrite", () => {
    // ⚠ An exclusion justified by another instrument is a CLAIM about it. Each
    // helper below is exempted because it proxies internally; if one stops, the
    // exemption silently becomes a hole.
    for (const [file, fn] of REWRITER_SOURCES) {
      // ⛔ COMMENTS STRIPPED, and this was NOT belt-and-braces — the first draft
      // asserted on the raw source and a mutation that deleted the actual
      // `proxyIpfsUrl(...)` call still PASSED, because the comment I had written
      // above it explaining the rewrite still contained the word. A guard
      // satisfied by its own documentation is the vacuous kind this repo keeps
      // finding; it was caught by mutating it rather than by reading it.
      const src = stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"))
      expect(src, `${file} no longer defines ${fn}`).toContain(fn)
      expect(src, `${fn} no longer rewrites IPFS urls — its exemption is now a hole`).toContain(
        "proxyIpfsUrl(",
      )
    }
  })

  it("the OG exclusion holds — those cards rewrite server-side instead", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/og/img-data.ts"), "utf8")
    expect(src).toContain("IPFS_GATEWAY_RE")
    expect(src).toContain("/api/public/ipfs-media/")
  })

  it("the rewriter still covers the two gateways the catalogue actually stores", () => {
    // Live counts 2026-09-13: ipfs.io 518 (UFC), ipfs.dapperlabs.com 2,368 (Top
    // Shot pre-2022). A regex that drops either silently un-proxies that half.
    const src = fs.readFileSync(path.join(process.cwd(), "lib/ipfs-media.ts"), "utf8")
    expect(src).toContain("ipfs.io")
    expect(src).toContain("ipfs.dapperlabs.com")
  })

  it("the matcher can SEE an offender — a guard that cannot is indistinguishable from a clean tree", () => {
    // The positive control. Without it a typo in THUMB reads as "zero offenders".
    const probe = 'const x = <img src={row.thumbnail_url} alt="" />'
    expect(THUMB.test(probe)).toBe(true)
    expect(REWRITERS.test(probe)).toBe(false)
    const fixed = 'const x = <img src={proxyIpfsUrl(row.thumbnail_url) ?? undefined} alt="" />'
    expect(THUMB.test(fixed) && !REWRITERS.test(fixed)).toBe(false)
  })
})
