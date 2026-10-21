// __tests__/site-app-json-ld-is-homepage-only.test.ts
//
// 2026-10-21 (Google Rich Results Test on /nba-top-shot/edition/90:3571): the
// page was read as Product + Merchant listing + Breadcrumbs + **Software App**.
// The Software App was the site-wide WebApplication (`organizationJsonLd`, a
// free FinanceApplication) emitted by the ROOT layout, so it rode on every
// card, player and pack page — structured data describing the site rather
// than the page's subject, competing with the Product. It now lives on the
// homepage only. This pins both halves: absent from the root layout, present
// on the homepage component the anonymous `/` renders.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const read = (p: string) => stripComments(readFileSync(join(__dirname, "..", p), "utf8"))

describe("the site-wide WebApplication JSON-LD is homepage-only", () => {
  it("the root layout does not emit it", () => {
    const layout = read("app/layout.tsx")
    expect(layout).not.toMatch(/organizationJsonLd/)
    expect(layout).not.toMatch(/application\/ld\+json/)
  })

  it("the homepage component emits it", () => {
    const home = read("components/HomePageMarketing.tsx")
    expect(home).toMatch(/JSON\.stringify\(organizationJsonLd\)/)
  })

  it("the anonymous homepage renders that component", () => {
    expect(read("app/page.tsx")).toMatch(/<HomePageMarketing\s*\/>/)
  })
})
