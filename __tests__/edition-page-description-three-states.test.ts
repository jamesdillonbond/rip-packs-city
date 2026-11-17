import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { editionDescriptionText, editionDescriptionSnippet, EDITION_DESCRIPTION_META_MAX } from "@/lib/edition/description"
import { editionPageMetadata } from "@/lib/seo"

// Review item E4 (2026-10-11). `editions.description` — the upstream prose for
// the play — reaches the public edition page and its <meta description> through
// get_edition_detail (migration 20261012232629). This pins the THREE states on
// every layer that reads it:
//
//   content          → the paragraph renders; the meta description LEADS with
//                      the first sentence (≤ 160 chars) and keeps today's text
//   NULL (no prose)  → nothing rendered; the meta description is EXACTLY what it
//                      was — not an empty lead, not a stand-in
//   "" / whitespace  → identical to NULL. An empty string is not a paragraph.
//
// ⚠ The page is an async server component that no jsdom gate can render, so its
// half is a SOURCE property — comments stripped first, because the fix's own
// comments quote the banned copy to explain themselves (sixth instance of that
// trap in this repo). The property pinned is the GATE: the paragraph renders on
// the helper's result, never on the raw column, because `detail.description !=
// null` is true for "" and renders an empty <p>. Proved with that planted defect
// before this file was committed (gate swapped to `detail.description != null &&`
// → the gate assertion below reds).

const ROOT = path.resolve(__dirname, "..")
const PAGE = "app/(collections)/[collection]/edition/[slug]/page.tsx"
const PROSE = "Lillard pulls up from the logo. The shot drops at the buzzer."

function pageSource(): string {
  return stripComments(readFileSync(path.join(ROOT, PAGE), "utf8"))
}

describe("editionDescriptionText — three states, two answers", () => {
  it("returns the prose, whitespace-collapsed", () => {
    expect(editionDescriptionText("  Lillard pulls up\n\n from the logo.  ")).toBe("Lillard pulls up from the logo.")
  })
  it("is null for NULL, a non-string, an empty string and whitespace", () => {
    // ⚠ "" is the load-bearing row: a `!= null` gate passes it and renders an
    // empty paragraph. Asserted as null, not as falsy, so "" cannot leak back.
    expect(editionDescriptionText(null)).toBeNull()
    expect(editionDescriptionText(undefined)).toBeNull()
    expect(editionDescriptionText(42)).toBeNull()
    expect(editionDescriptionText("")).toBeNull()
    expect(editionDescriptionText(" \n\t ")).toBeNull()
  })
})

describe("editionDescriptionSnippet — the first sentence, capped", () => {
  it("stops at the first sentence", () => {
    expect(editionDescriptionSnippet(PROSE)).toBe("Lillard pulls up from the logo.")
    expect(editionDescriptionSnippet("Did it drop? It did. Twice.")).toBe("Did it drop?")
  })
  it("does not mistake an abbreviation for the end of a sentence", () => {
    expect(editionDescriptionSnippet("Vol. 2 of the series opens with a dunk. Then a block.")).toBe(
      "Vol. 2 of the series opens with a dunk.",
    )
  })
  it("caps a run-on at the limit on a word boundary and says so", () => {
    const runOn = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")
    const out = editionDescriptionSnippet(runOn)!
    expect(out.length).toBeLessThanOrEqual(EDITION_DESCRIPTION_META_MAX)
    expect(out.endsWith("…")).toBe(true)
    expect(out).not.toMatch(/ …$/)
    // a custom cap is honoured, so the 160 is a default and not a hidden constant
    expect(editionDescriptionSnippet(runOn, 40)!.length).toBeLessThanOrEqual(40)
  })
  it("is null exactly when the text helper is null", () => {
    for (const v of [null, undefined, "", "   ", 7]) expect(editionDescriptionSnippet(v)).toBeNull()
  })
})

describe("editionPageMetadata — the description seed", () => {
  const base = {
    route_slug: "5:145",
    player_name: "Damian Lillard",
    set_name: "Base Set",
    tier: "COMMON",
    fmv: { fmv_usd: 250.5 },
  }
  const without = editionPageMetadata(base, "nba-top-shot").description as string

  it("leads with the first sentence of the prose and keeps today's text after it", () => {
    const m = editionPageMetadata({ ...base, description: PROSE }, "nba-top-shot")
    const d = m.description as string
    expect(d.startsWith("Lillard pulls up from the logo. ")).toBe(true)
    expect(d).not.toContain("The shot drops at the buzzer.")
    expect(d.endsWith(without)).toBe(true)
    expect(d.slice(0, d.indexOf(" Damian Lillard Base Set")).length).toBeLessThanOrEqual(EDITION_DESCRIPTION_META_MAX)
  })

  it("is byte-identical to today's text when the prose is NULL, absent, empty or whitespace", () => {
    // ⚠ Asserted as EQUALITY with the no-key payload, not as "does not contain
    // the prose": an empty lead ("  Damian …") or a stand-in would fail here and
    // pass a weaker containment check.
    for (const description of [null, undefined, "", " \n "]) {
      expect(editionPageMetadata({ ...base, description }, "nba-top-shot").description).toBe(without)
    }
    expect(without.startsWith("Damian Lillard Base Set is worth")).toBe(true)
  })

  it("never publishes a stand-in sentence for missing prose", () => {
    expect(without).not.toMatch(/no description/i)
  })
})

describe("the edition page renders the paragraph on the helper's answer, never the raw column", () => {
  it("is not vacuous: the page declares the field and reads it through the helper", () => {
    const src = pageSource()
    expect(src).toMatch(/^\s*description: string \| null$/m)
    expect(src).toMatch(/const editionDescription = editionDescriptionText\(detail\.description\)/)
  })

  it("gates the <p> on editionDescription — the ONLY place the column is consulted", () => {
    const src = pageSource()
    // The render block: `{editionDescription && (<p …>{editionDescription}</p>)}`.
    const block = /\{editionDescription && \(\s*<p[^>]*>\s*\{editionDescription\}\s*<\/p>\s*\)\}/.exec(src)
    expect(block, "the paragraph must be gated on the helper result").not.toBeNull()
    // The raw column is read ONCE (into the helper) and never gates anything:
    // `detail.description &&`, `!= null`, `!== null`, `?.length` all render "".
    const raw = src.match(/detail\.description/g) ?? []
    expect(raw).toHaveLength(1)
    expect(src).not.toMatch(/detail\.description\s*(&&|!=|!==|\?\.|\.length|\.trim)/)
  })

  it("the paragraph uses tokens, not brand hex, and the page keeps one <h1>", () => {
    const src = pageSource()
    const start = src.indexOf("{editionDescription && (")
    const block = src.slice(start, src.indexOf(")}", start))
    expect(block).toMatch(/var\(--rpc-/)
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(block).not.toMatch(/<h[1-6]/)
    // The page's own hero <h1> plus the detail-failed fallback <h1> are two
    // RENDER PATHS, never both in one response; the prose must not add a third.
    expect((src.match(/<h1\b/g) ?? []).length).toBe(2)
  })

  it("carries no 'No description' copy anywhere on the page", () => {
    expect(pageSource()).not.toMatch(/no description/i)
  })
})
