import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "fs"
import path from "path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ARCHITECTURE GUARD — no FMV confidence-tier labels on user surfaces.
//
// Standing policy (set 2026-07-11): the internal FMV confidence tiers
// (HIGH / MEDIUM / LOW / ASK_ONLY / STALE) are a scoring artifact, not a
// reader-actionable signal, and they were deliberately removed from every
// public/user surface. A reader cannot do anything differently on seeing
// "MED"; what they can act on is the honest per-row caveat ("thin data — FMV
// uncertain") or an em-dash where a value is genuinely absent.
//
// This has now regressed TWICE:
//   - 2026-07-25 (am) — re-fixed on the Candy board
//   - 2026-07-25 (pm) — app/insights/deals/DealsBoardClient.tsx still shipped a
//     HI/MED chip on an UNAUTHENTICATED page, missed by the original sweep
// so it gets a mechanical guard rather than a third code review.
//
// SCOPE — user surfaces only. Internal/admin surfaces are explicitly exempt and
// listed in EXEMPT_PREFIXES below; they exist to inspect the pipeline and the
// tier is the whole point there.
//
// If this test fails: delete the chip, don't add an exemption. The honest
// alternatives are the thin-data caveat and an em-dash.

const REPO = process.cwd()
const APP = path.join(REPO, "app")

// Internal / non-reader surfaces where naming a tier is legitimate.
const EXEMPT_PREFIXES = [
  path.join(APP, "admin"), // operator dashboards (fmv-health, etc.)
  path.join(APP, "(analytics)"), // logged-in analytics + the public API docs page
  path.join(APP, "api"), // server routes: data, not rendered labels
  // The methodology explainer documents what the tiers MEAN. It is prose about
  // the model, not a per-row badge stuck next to a price.
  path.join(APP, "legal", "fmv-methodology"),
]

function walkTsx(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      out.push(...walkTsx(full))
    } else if (e.name.endsWith(".tsx")) {
      out.push(full)
    }
  }
  return out
}

// Each pattern is a shape that only appears when a tier is being PAINTED.
const BANNED: Array<{ re: RegExp; what: string }> = [
  // `confidence === "HIGH" ? "HI" : "MED"` and friends — the exact chip that
  // survived on the Below FMV board.
  {
    re: /confidence[^\n]{0,40}===\s*["'](?:HIGH|MEDIUM)["'][^\n]{0,40}\?\s*["'](?:HI|MED|HIGH|MEDIUM)["']/i,
    what: 'a tier-abbreviation ternary (e.g. confidence === "HIGH" ? "HI" : "MED")',
  },
  // Chip/badge class names minted for tier pills.
  { re: /["'`][\w-]*conf(?:idence)?-chip/i, what: "a confidence-chip CSS class" },
  { re: /\bconfidenceLabel\b/, what: "a confidenceLabel render" },
  // A tier string used directly as visible chip/badge text.
  { re: /<span[^>]*>\s*\{?\s*["'](?:ASK_ONLY|STALE)["']/, what: "an ASK_ONLY / STALE badge" },
]

function isExempt(file: string): boolean {
  return EXEMPT_PREFIXES.some((p) => file.startsWith(p + path.sep) || file === p)
}

describe("invariant: no FMV confidence-tier labels render on user surfaces", () => {
  it("has files to scan (guard against a silently-empty walk)", () => {
    const files = walkTsx(APP).filter((f) => !isExempt(f))
    expect(files.length).toBeGreaterThan(50)
  })

  it("no user-facing .tsx paints a HIGH/MEDIUM/ASK_ONLY/STALE tier label", () => {
    const offenders: string[] = []
    for (const file of walkTsx(APP)) {
      if (isExempt(file)) continue
      const src = readFileSync(file, "utf8")
      // Strip comments so a "do not reintroduce" note (like the one left in
      // DealsBoardClient) can describe the removed chip without tripping this.
      const code = stripComments(src)
      for (const { re, what } of BANNED) {
        const m = re.exec(code)
        if (m) {
          const line = code.slice(0, m.index).split("\n").length
          offenders.push(`${path.relative(REPO, file)}:${line} — ${what}`)
        }
      }
    }
    expect(offenders, `confidence tiers must not render on a user surface:\n${offenders.join("\n")}`).toEqual([])
  })
})
