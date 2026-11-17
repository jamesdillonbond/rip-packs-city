// Deep-audit R10. Next merges page metadata into the root export at the
// TOP-LEVEL key only: defining `openGraph` (or `twitter`) in a child REPLACES
// the root's block outright, so every field the child omits vanishes from the
// rendered tags.
//
// All three shared helpers in lib/seo.ts defined those blocks and omitted
// fields the root supplies — across ~40 collection tab URLs (pageMetadata), the
// whole entity corpus including ~23.5k editions (buildMeta), and the 5
// collection roots (collectionLayoutMetadata). The visible symptom was that the
// public boards the concierge calls "the most shareable thing RPC has"
// unfurled with NO X byline at all.
//
// app/profile/[username]/layout.tsx documents the same trap and gets it right;
// this pins the generalisation so it cannot silently regress in the helpers
// that cover almost every URL on the site.
import { describe, it, expect } from "vitest"
import { rootMetadata, pageMetadata, collectionLayoutMetadata, editionPageMetadata } from "@/lib/seo"

const rootOg = rootMetadata.openGraph as Record<string, unknown>
const rootTw = rootMetadata.twitter as Record<string, unknown>

// Derived from the root rather than restated, so adding a field at the root
// widens this guard automatically instead of quietly leaving a new hole.
const OG_FIELDS = ["type", "locale", "siteName"] as const
const TW_FIELDS = ["site", "creator", "card"] as const

const CASES: Array<{ name: string; meta: () => Record<string, unknown> }> = [
  { name: "pageMetadata", meta: () => pageMetadata("sniper", "NBA Top Shot", "nba-top-shot") as Record<string, unknown> },
  { name: "collectionLayoutMetadata", meta: () => collectionLayoutMetadata("nba-top-shot") as Record<string, unknown> },
  {
    // `buildMeta` is private, so it is exercised through a real public caller.
    // It backs the whole entity corpus — edition / set / player / team / series
    // — which is ~23.5k edition URLs alone, the largest surface of the three.
    name: "buildMeta (via editionPageMetadata)",
    meta: () =>
      editionPageMetadata(
        { player_name: "Damian Lillard", set_name: "Base Set", external_id: "73:2785" },
        "nba-top-shot",
      ) as Record<string, unknown>,
  },
]

describe("lib/seo shared helpers do not drop root openGraph/twitter fields", () => {
  it("the root actually defines the fields this guard checks (not vacuous)", () => {
    for (const f of OG_FIELDS) expect(rootOg[f], `root openGraph.${f}`).toBeTruthy()
    for (const f of TW_FIELDS) expect(rootTw[f], `root twitter.${f}`).toBeTruthy()
  })

  for (const c of CASES) {
    it(`${c.name} carries every root openGraph field`, () => {
      const og = c.meta().openGraph as Record<string, unknown> | undefined
      expect(og, `${c.name} defines openGraph`).toBeTruthy()
      for (const f of OG_FIELDS) {
        expect(og![f], `${c.name} openGraph.${f}`).toBe(rootOg[f])
      }
    })

    it(`${c.name} carries every root twitter field (the X byline)`, () => {
      const tw = c.meta().twitter as Record<string, unknown> | undefined
      expect(tw, `${c.name} defines twitter`).toBeTruthy()
      for (const f of TW_FIELDS) {
        expect(tw![f], `${c.name} twitter.${f}`).toBe(rootTw[f])
      }
    })

    it(`${c.name} still sets its own title/description (inheritance did not flatten it)`, () => {
      // The opposite direction: spreading the shared block must not overwrite
      // the per-page values, or every page would unfurl with the root's copy.
      const m = c.meta()
      const og = m.openGraph as Record<string, unknown>
      expect(og.title).toBeTruthy()
      expect(og.title).not.toBe(rootOg.title)
      expect(og.description).toBeTruthy()
    })
  }
})
