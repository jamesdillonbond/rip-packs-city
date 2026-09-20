import { describe, it, expect } from "vitest"
import { COLLECTIONS, publishedChainsBadge, type Collection } from "@/lib/collections"

// ─────────────────────────────────────────────────────────────────────────────
// `publishedChainsBadge()` renders the SITE-WIDE provenance claim — the footer
// badge on every page and the default OG card. It is derived from the `dbChain`
// of every collection with `published: true`, which means a boolean flip on ONE
// collection silently rewrites a factual claim made on EVERY page.
//
// That is not hypothetical. Measured 2026-09-20: with Panini still carrying the
// stale `dbChain: "ethereum"` (the OpenSea bridge plane — a plane RPC holds ZERO
// rows from, and which #64 explicitly did NOT choose as the collection), the
// pending `published` flip moved the badge from
//
//     BUILT ON FLOW + SOLANA   →   BUILT ON FLOW + ETHEREUM + SOLANA
//
// on every page of the site. Nothing in the flip's own checklist would have
// shown that, because the flip is one word in a different file. The registry
// value has since been corrected to null; this guard is what keeps the class
// from coming back on the next collection.
//
// THE PROPERTY: flipping `published` on a single currently-unpublished
// collection must not, by itself, widen the site-wide chain claim. A collection
// that genuinely ships a new chain SHOULD change this badge — but that is a
// decision taken WITH the flip, and this guard makes it a visible, deliberate
// diff instead of an inherited side effect of a stale registry field.
//
// ⚠ Deliberately NOT an allowlist of chains: an allowlist goes stale silently
// and would have passed the exact defect above. The check is a ban at zero over
// a tree walk of the registry, and it is satisfiable at a population of zero
// unpublished collections.
// ─────────────────────────────────────────────────────────────────────────────

/** Run `fn` with `patch` applied to a registry entry, then restore it exactly. */
function withPatchedEntry<T>(index: number, patch: Partial<Collection>, fn: () => T): T {
  const original = { ...COLLECTIONS[index] }
  Object.assign(COLLECTIONS[index], patch)
  try {
    return fn()
  } finally {
    // Restore by key so a patch that ADDED a key is removed, not left behind.
    for (const k of Object.keys(COLLECTIONS[index]) as (keyof Collection)[]) {
      if (!(k in original)) delete (COLLECTIONS[index] as unknown as Record<string, unknown>)[k]
    }
    Object.assign(COLLECTIONS[index], original)
  }
}

describe("the site-wide chain claim cannot be widened by a `published` flip alone", () => {
  it("states today's claim, and the population it was derived from", () => {
    const published = COLLECTIONS.filter((c) => c.published)
    const unpublished = COLLECTIONS.filter((c) => !c.published)

    // ASSERT THE COUNT INSPECTED — a walk that silently enumerated nothing
    // passes every assertion below while measuring no collection at all.
    expect(COLLECTIONS.length).toBe(published.length + unpublished.length)
    expect(published.length).toBeGreaterThan(0)
    expect(unpublished.length).toBeGreaterThan(0)

    expect(publishedChainsBadge()).toBe("BUILT ON FLOW + SOLANA")
  })

  it("no unpublished collection changes the badge when flipped on its own", () => {
    const baseline = publishedChainsBadge()
    let inspected = 0

    for (let i = 0; i < COLLECTIONS.length; i++) {
      if (COLLECTIONS[i].published) continue
      inspected++
      const after = withPatchedEntry(i, { published: true }, () => publishedChainsBadge())
      expect(
        after,
        `flipping published on "${COLLECTIONS[i].id}" (dbChain=${String(COLLECTIONS[i].dbChain)}) ` +
          `rewrites the site-wide provenance claim from "${baseline}" to "${after}". ` +
          `If that chain is genuinely shipping, change this guard IN THE SAME COMMIT as the flip ` +
          `and say so — do not let a stale registry field make the claim for you.`,
      ).toBe(baseline)
    }

    // The loop must actually have run over the unpublished collections.
    expect(inspected).toBe(COLLECTIONS.filter((c) => !c.published).length)
  })

  it("POSITIVE CONTROL — the guard above can actually fire", () => {
    // Without this, "no unpublished collection changes the badge" would read as
    // coverage even if publishedChainsBadge() were hardcoded or the patch helper
    // silently failed to mutate the registry.
    const baseline = publishedChainsBadge()
    const i = COLLECTIONS.findIndex((c) => !c.published)
    expect(i).toBeGreaterThanOrEqual(0)

    const widened = withPatchedEntry(i, { published: true, dbChain: "ethereum" }, () =>
      publishedChainsBadge(),
    )
    expect(widened).not.toBe(baseline)
    expect(widened).toContain("ETHEREUM")

    // …and the restore is exact, or every later test in the file is measuring a
    // registry this one corrupted.
    expect(publishedChainsBadge()).toBe(baseline)
    expect(COLLECTIONS[i].published).toBe(false)
  })

  it("Panini specifically: the flip is inert, which is the fix this guard records", () => {
    const panini = COLLECTIONS.find((c) => c.id === "panini-blockchain")
    expect(panini, "panini-blockchain left the registry — re-point this guard").toBeDefined()
    expect(panini!.published).toBe(false)
    // null, not "ethereum": RPC holds 5,074 WC Prizm editions and zero rows from
    // the OpenSea bridge plane that value used to name.
    expect(panini!.dbChain ?? null).toBeNull()
  })
})
