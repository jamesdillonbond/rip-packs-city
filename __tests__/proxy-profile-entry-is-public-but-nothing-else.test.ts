import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { isPublicPath } from "@/proxy"

// ── Un-gating `/profile` must not have un-gated anything else ───────────────
//
// 🚨 WHY THIS EXISTS (2026-08-29, register R36). `proxy.ts` is the auth gate and
// this repo names it off-limits for unattended change, so the one line added there
// gets a guard that states its blast radius as a TEST rather than as a comment.
//
// The change: `/profile` (bare, no trailing slash) is now public, because it is
// served by `app/profile/page.tsx` — a SERVER component that redirects a signed-in
// visitor to `/dashboard` and renders a no-account wallet lookup for everyone else.
// Before it, the leftmost mobile tab measured `/profile` → 308 → `/dashboard` →
// 307 → `/login?next=%2Fdashboard`: two hops into a login wall from the first tab
// a phone visitor taps.
//
// ⚠ THE HAZARD IS A LATER "TIDY-UP", not this commit. The neighbouring rule is a
// PREFIX (`startsWith("/profile/")`) carrying two explicit carve-outs for
// `/profile/edit`. Someone folding the new exact match into that prefix — the
// obvious simplification — would open the signed-in bio editor to the world. So
// the assertions below pin BOTH halves: what opened, and what must not have.
const ROOT = path.resolve(__dirname, "..")
const GET = "GET"

describe("the /profile entry page is public", () => {
  it("bare /profile is public — the tab no longer dead-ends at /login", () => {
    expect(isPublicPath("/profile", GET)).toBe(true)
  })

  it("is not vacuous: the gate still rejects a plainly private path", () => {
    // Without this, a gate that returned true for everything would satisfy the
    // assertion above while proving nothing at all.
    expect(isPublicPath("/dashboard", GET)).toBe(false)
  })
})

describe("and nothing else was un-gated with it", () => {
  it("🚨 /profile/edit and its subtree stay GATED", () => {
    expect(isPublicPath("/profile/edit", GET)).toBe(false)
    expect(isPublicPath("/profile/edit/", GET)).toBe(false)
    expect(isPublicPath("/profile/edit/bio", GET)).toBe(false)
  })

  it("the signed-in surfaces behind the tab stay GATED", () => {
    for (const p of ["/dashboard", "/dashboard/alerts", "/dashboard/api-keys", "/dashboard/notifications"]) {
      expect(isPublicPath(p, GET), `${p} became public`).toBe(false)
    }
  })

  it("CONTROL — public profile cards were already public and still are", () => {
    // The pre-existing prefix rule. If this broke, the share flow broke.
    expect(isPublicPath("/profile/ripcity", GET)).toBe(true)
  })

  it("🚨 the new rule is an EXACT match, so no near-miss path rides along", () => {
    // `/profileedit` and `/profile-admin` share the prefix `/profile` but are not
    // `/profile`. A `startsWith("/profile")` implementation would let them through.
    expect(isPublicPath("/profileedit", GET)).toBe(false)
    expect(isPublicPath("/profile-admin", GET)).toBe(false)
  })
})

describe("the source states the shape it relies on", () => {
  const src = readFileSync(path.join(ROOT, "proxy.ts"), "utf8")

  it("is not vacuous: the profile rules are still in proxy.ts", () => {
    expect(src).toContain('pathname.startsWith("/profile/")')
  })

  it("uses `===` for the entry path, never a prefix", () => {
    // Pinned as the PROPERTY the security argument rests on: an exact match
    // cannot reach /profile/edit no matter how the carve-outs below it change.
    expect(src).toContain('if (pathname === "/profile") return true')
    expect(src).not.toMatch(/startsWith\("\/profile"\)/)
  })
})

describe("the page behind it cannot leak personalization", () => {
  const page = readFileSync(path.join(ROOT, "app/profile/page.tsx"), "utf8")

  it("is not vacuous: the page exists and resolves the session", () => {
    expect(page).toContain("getCurrentUser")
  })

  it("redirects a signed-in visitor rather than rendering their data", () => {
    // The anonymous branch is the ONLY thing this public path can render, which
    // is what makes un-gating it safe.
    expect(page).toMatch(/if \(user\) redirect\("\/dashboard"\)/)
  })

  it("🚨 the branch is decided on the SERVER — no client session state is added", () => {
    // The filed repair needed client session state, whose three states are the
    // recorded React #418 shape. Fixing the destination avoids it entirely, and
    // this assertion is what keeps it avoided.
    expect(page).not.toContain('"use client"')
    expect(page).not.toContain("useEffect")
    expect(page).not.toContain("useState")
  })

  it("promises only things the read-only product actually has", () => {
    // CLAUDE.md rule 1 binds every surface: never offer an action the product
    // lacks. RPC has no cart, no trading, no gifting.
    //
    // ⚠ THIS READS STRING LITERALS, NOT THE SOURCE — and the first version did
    // not, and fired on THIS FILE'S OWN NEIGHBOURING COMMENT, which spells out
    // "no cart, no trading, no gifting" to explain the rule. That is the seventh
    // recorded instance in this repo of a guard reddening on the documentation of
    // the thing it protects, caught while writing it. A comment is not a string
    // literal, so extracting literals sidesteps the problem instead of depending
    // on a comment-stripper being right.
    // ⚠⚠ DOUBLE QUOTES AND BACKTICKS ONLY — NOT `'`. The first version included
    // single quotes and immediately mis-fired: an APOSTROPHE inside a prose
    // comment ("the root layout's title template") is an unbalanced quote, so the
    // extractor swallowed an arbitrary span of source as one "literal" and matched
    // a banned word that appears nowhere in the copy. A scraper is only as good as
    // its delimiter set, and prose is full of apostrophes — so the delimiter that
    // prose abuses is the one to drop.
    const literals = [...page.matchAll(/(["`])((?:\\.|(?!\1)[^\n])*)\1/g)].map((m) => m[2])
    expect(literals.length, "no string literals extracted — this guard reads nothing").toBeGreaterThan(20)
    const copy = literals.join(" \u0000 ")
    for (const banned of [/\bbuy now\b/i, /\bsell\b/i, /\btrade\b/i, /\bgift\b/i, /\bcart\b/i]) {
      expect(copy, `copy promises an action the product lacks: ${banned}`).not.toMatch(banned)
    }
    // Guards-the-guard, both directions. (a) the extractor sees the real copy:
    expect(copy).toMatch(/No account needed/)
    // (b) an apostrophe in a comment cannot make it swallow source as "copy" —
    // the exact mis-fire that produced a false positive while this was written.
    const apostropheHazard = `// the root layout's title template\nconst x = "safe copy"\n// cart`
    const scraped = [...apostropheHazard.matchAll(/(["`])((?:\\.|(?!\1)[^\n])*)\1/g)].map((m) => m[2]).join(" ")
    expect(scraped).toBe("safe copy")
  })
})
