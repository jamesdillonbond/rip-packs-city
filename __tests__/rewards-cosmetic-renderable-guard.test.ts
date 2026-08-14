import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Source guard: the rewards page must not sell or equip a cosmetic it cannot draw.
//
// ── WHY A SOURCE GUARD ──────────────────────────────────────────────────────
//
// `app/rewards/page.tsx` is a `"use client"` `page.tsx`, which NEITHER coverage
// gate measures (the component gate's include is `app/**/*Client.tsx`; the
// primary gate stops at `route.{ts,tsx}`), so a source property is the only
// automated check available until it is split. Same reason as
// `client-pages-failed-vs-empty-guard`; tracked by `client-page-gate-ratchet`.
//
// ── THE DEFECT IT PINS ──────────────────────────────────────────────────────
//
// A cosmetic SKU is a row in `shop_items` (`metadata: {slot, value}`) — a pure
// DB insert, no deploy — while its appearance lives in `lib/cosmetics.ts`, which
// ships with the bundle. Nothing joined the two, and BOTH lookups fail soft by
// design (an unknown value resolves to `null` rather than throwing). So a SKU
// inserted ahead of its style was fully redeemable: the collector spent credits,
// equipped it, and their public profile was unchanged — no error on any surface.
// The owned-cosmetics tile even drew a grey `#333`/`#666` placeholder, which
// reads as a legitimately dark cosmetic rather than as an absence.
//
// This is the money-touching direction of the "failed read renders as an answer"
// class: an unrenderable cosmetic rendered as a purchasable one.
//
// ⚠ The guard checks BOTH surfaces because they fail differently and a fix to
// one reads as done. The shop is where credits are spent; the owned list is
// where an already-bought one would still be equipped onto a profile.

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8")
}

/**
 * `//`-comment lines removed.
 *
 * ⚠ Required, not tidiness: the page's own comments NAME the helper and quote
 * the copy, so an un-stripped guard passes on its own prose. This repo has been
 * bitten by exactly that at least four times (`pack-dist-contents-not-streamed`,
 * `collection-analytics-failed-vs-empty-guard`, the concierge rich-text guard,
 * the OG impossible-claim sweep, whose first run reported the comment
 * documenting the fix as the only offender).
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n")
}

describe("rewards — a cosmetic with no artwork is not for sale and cannot be worn", () => {
  // ⚠ Stripped BEFORE any assertion. It is not currently load-bearing — the
  // page's comments happen not to quote the copy these tests match on — but that
  // is an accident of today's wording, and the first comment someone writes that
  // does quote it turns this guard green against its own prose. Cheap insurance
  // against a failure mode this repo has hit at least four times.
  const src = stripComments(read("app", "rewards", "page.tsx"))

  it("is not vacuous — the file still renders both the shop and the owned cosmetics", () => {
    // If either section is renamed or moved out, the assertions below would pass
    // against a file that no longer does the thing.
    expect(src).toContain("shop.map(")
    expect(src).toContain("cosmetics.map(")
  })

  it("imports the renderability check from the shared style module", () => {
    // It must come from lib/cosmetics — a local re-derivation would drift from
    // the maps it is supposed to be checking against.
    expect(src).toMatch(/import\s*\{[^}]*hasCosmeticStyle[^}]*\}\s*from\s*["']@\/lib\/cosmetics["']/)
  })

  it("gates the shop's Redeem button on it", () => {
    expect(src).toContain("hasCosmeticStyle(")
    // The disabled expression must actually consume the verdict; computing it and
    // leaving the button live is the shape of a fix that looks applied.
    expect(src).toMatch(/const disabled\s*=[\s\S]{0,240}?unrenderable/)
  })

  it("gates the Equip button on it too", () => {
    expect(src).toMatch(/disabled=\{[^}]*unrenderable[^}]*\}/)
  })

  it("says why, rather than silently disabling", () => {
    // A dead button with no explanation is its own small dishonesty — the reader
    // cannot tell "you cannot afford this" from "this does not work yet".
    expect(src).toMatch(/Not ready to wear yet/)
    expect(src).toMatch(/needs an app update/)
  })

  it("still lets an already-equipped one be taken OFF", () => {
    // ⚠ The trap in the obvious fix. If an unrenderable cosmetic were simply
    // inert, anyone who equipped one before the style was pulled would be stuck
    // wearing an invisible cosmetic with no way to clear the slot — recreating
    // the dead end the unequip path was built to fix. The gate is
    // `unrenderable && !equippedNow` on the SHOP-side action only.
    expect(src).toContain("unrenderable && !equippedNow")
  })
})
