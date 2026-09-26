import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Trevor, 2026-09-25: "We shouldn't be considering or mentioning paid accounts
// anywhere on the website ... until we get to 100 weekly active users."
//
// That day removed every paid-tier surface: /pricing (now a redirect home), the
// PRO badge (component deleted), the alerts / collection-table "Upgrade to Pro"
// copy, the concierge's "Upgrade to RPC Pro" limit message, the rewards "Pro"
// item, and the per-plan saved-wallet cap. This walk keeps it that way: a ban at
// ZERO over the code a visitor can reach (app/ + components/), comments
// stripped, so a new upsell cannot land quietly.
//
// SUPPRESSIONS ARE CLAIMS, each with the reason it is not a visible surface.
// Remove an entry the day its reason stops being true.
const SUPPRESSED: Record<string, string> = {
  // Empty on 2026-09-25. The unreferenced Stripe plumbing (app/api/stripe/*,
  // components/pricing/StripeSubscribeButton.tsx) matches no pattern below.
}

const ROOTS = ["app", "components"]

// What a visitor would read as a paid tier. Patterns, not a word list, so the
// NFL "Pro Bowl" badge and words like "profile" never match.
const BANNED: Array<[string, RegExp]> = [
  ["RPC Pro", /RPC\s+Pro\b/],
  ["Upgrade to Pro", /upgrade\s+to\s+(rpc\s+)?pro\b/i],
  ["Pro plan(s)", /\bPro\s+plans?\b/],
  ["Free plan / free tier", /\bfree\s+(plan|tier)\b/i],
  ["/pricing link", /href=["'`{]\s*["'`]?\/pricing\b/],
  ["upgrade_url field", /\bupgrade_url\b/],
  ["Pro badge", /\bProBadge\b/],
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue
      out.push(...walk(full))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const ROOT = process.cwd()
const files = ROOTS.flatMap((r) => walk(join(ROOT, r)))

describe("no paid tier is named on the site (until 100 WAU)", () => {
  it("inspects a real population", () => {
    // A broken walk would pass the ban below vacuously.
    expect(files.length).toBeGreaterThan(500)
    expect(files.map((f) => relative(ROOT, f))).toContain("app/pricing/page.tsx")
  })

  it("no reachable file names a paid tier", () => {
    const hits: string[] = []
    for (const full of files) {
      const rel = relative(ROOT, full)
      if (rel in SUPPRESSED) continue
      const code = stripComments(readFileSync(full, "utf8"))
      for (const [label, re] of BANNED) {
        if (re.test(code)) hits.push(`${rel}: ${label}`)
      }
    }
    expect(hits, "a paid tier is named on the site — Trevor: none until 100 weekly active users").toEqual([])
  })

  it("a suppression is removed when its file stops matching or disappears", () => {
    for (const rel of Object.keys(SUPPRESSED)) {
      let code: string
      try {
        code = stripComments(readFileSync(join(ROOT, rel), "utf8"))
      } catch {
        throw new Error(`${rel} is suppressed but no longer exists — delete the entry`)
      }
      const stillMatches = BANNED.some(([, re]) => re.test(code))
      expect(stillMatches, `${rel} is suppressed but names no paid tier any more — delete the entry`).toBe(true)
    }
  })

  it("the detector catches a planted upsell (not vacuous)", () => {
    const planted = `export const C = () => <a href="/pricing">Upgrade to Pro</a>`
    const labels = BANNED.filter(([, re]) => re.test(planted)).map(([l]) => l)
    expect(labels).toEqual(expect.arrayContaining(["Upgrade to Pro", "/pricing link"]))
    // …and ignores the NFL badge and ordinary words.
    const benign = `const t = "Pro Bowl"; const p = "profile"; const x = "provider"`
    expect(BANNED.some(([, re]) => re.test(benign))).toBe(false)
  })
})
