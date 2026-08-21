import { describe, it, expect } from "vitest"
import {
  FOLDED_TAB_PARENT,
  foldedTabCanonical,
  PUBLIC_TAB_PAGES,
} from "@/lib/seo"
import { publishedCollections, collectionHasPage } from "@/lib/collections"
import { isPublicPath } from "@/proxy"

// BAN: a folded tab must never canonicalise to a URL an anonymous crawler
// cannot fetch.
//
// ── THE BUG THIS PINS ──────────────────────────────────────────────────────
// `pack-sniper` / `challenges` / `hot-floors` had no layout, so they inherited
// `collectionLayoutMetadata()` and emitted `canonical=/<collection>`. The
// collection ROOT is auth-gated — verified live 2026-08-20, `GET /nba-top-shot`
// returns `x-matched-path: /login` — so four anon-public URLs were telling
// Google their canonical was a page it would be redirected away from.
//
// ⚠ THE ASSERTION IS ON THE PROPERTY, NOT THE MAPPING. Pinning
// "challenges -> play" would pass just as happily on the day `/play` gets
// gated, which is the whole failure mode. So the load-bearing case below
// re-derives every canonical and asks `isPublicPath` whether a crawler can
// actually fetch it. The mapping itself is pinned separately and loosely.

const FOLDED = Object.keys(FOLDED_TAB_PARENT)

function path(url: string): string {
  return new URL(url).pathname
}

describe("folded-tab canonicals point at something an anonymous crawler can fetch", () => {
  it("the folded set is real and still OUT of the self-canonical set (not vacuous)", () => {
    // If a folded tab ever gains a PAGE_META entry it self-canonicalises, joins
    // the sitemap, and this whole file stops applying to it — so that has to be
    // a visible decision, not a silent one.
    expect(FOLDED.length).toBeGreaterThan(0)
    for (const p of FOLDED) {
      expect(PUBLIC_TAB_PAGES, `${p} must NOT have a PAGE_META entry`).not.toContain(p)
    }
    expect(publishedCollections().length).toBeGreaterThan(3)
  })

  it("the instrument can still see a gated URL (control)", () => {
    // Without this the file passes trivially if `isPublicPath` starts returning
    // true for everything — and the exact URL the bug pointed at is the most
    // honest control available, since it is what regressing would produce.
    for (const c of publishedCollections()) {
      expect(isPublicPath(`/${c.id}`, "GET"), `/${c.id} is the auth-gated root`).toBe(false)
    }
  })

  it("every folded tab on every published collection canonicalises to an anon-public URL", () => {
    const bad: string[] = []
    let checked = 0
    for (const c of publishedCollections()) {
      for (const p of FOLDED) {
        checked++
        const target = path(foldedTabCanonical(p, c.id))
        if (!isPublicPath(target, "GET")) bad.push(`/${c.id}/${p} -> ${target}`)
      }
    }
    expect(checked).toBeGreaterThan(10)
    expect(bad, "these folded tabs canonicalise to a URL that 302s an anonymous crawler").toEqual([])
  })

  it("falls back to /overview when the collection does not ship the parent", () => {
    // The trap the fallback exists for: UFC ships no `play`, so a naive
    // challenges->play mapping would have moved the broken target rather than
    // fixed it. Derived from the registry so it keeps testing something real if
    // UFC's tab set changes.
    const noParent = publishedCollections().flatMap((c) =>
      FOLDED.filter((p) => !collectionHasPage(c.id, FOLDED_TAB_PARENT[p] as never)).map((p) => [c.id, p] as const),
    )
    expect(noParent.length, "expected at least one collection missing a folded tab's parent").toBeGreaterThan(0)
    for (const [id, p] of noParent) {
      expect(path(foldedTabCanonical(p, id))).toBe(`/${id}/overview`)
    }
  })

  it("uses the parent tab when the collection does ship it", () => {
    const withParent = publishedCollections().flatMap((c) =>
      FOLDED.filter((p) => collectionHasPage(c.id, FOLDED_TAB_PARENT[p] as never)).map((p) => [c.id, p] as const),
    )
    expect(withParent.length).toBeGreaterThan(0)
    for (const [id, p] of withParent) {
      expect(path(foldedTabCanonical(p, id))).toBe(`/${id}/${FOLDED_TAB_PARENT[p]}`)
    }
  })

  it("never canonicalises a folded tab to itself", () => {
    // Self-canonical is the OTHER option that was considered and rejected
    // (it would put these in query competition with their own parents). If a
    // future edit flips them to self-canonical, that should be a deliberate
    // change to FOLDED_TAB_PARENT plus a PAGE_META entry, not a side effect.
    for (const c of publishedCollections()) {
      for (const p of FOLDED) {
        expect(path(foldedTabCanonical(p, c.id))).not.toBe(`/${c.id}/${p}`)
      }
    }
  })
})
