import { expect, test } from "playwright/test"
import { assertHealthyPage } from "./healthy-page"
import { discoverEntityPath, ENTITY_SPEC, type EntityType } from "./entity-urls"

// Rendered-DOM monitor for the ENTITY/DETAIL pages that smoke.spec.ts omits:
// /edition, /moment, /set, /player, /team, /series, /pack. These are the
// slug-keyed, scraper-hammered pages behind the pooler-saturation Sentry
// incidents (NEXTJS-1Y team, NEXTJS-20 player) — exactly the "200-but-broken-
// DOM" class the API smoke gate can't see. Each URL is discovered live from the
// app's own sitemap at run time (see entity-urls.ts), so the probe always hits
// a currently-valid entity and never rots on a hardcoded slug. A type absent
// from the sitemap is SKIPPED, not failed — a thin catalog must not red the
// monitor. Runs in the scheduled e2e-smoke workflow, not the PR gate.
//
// `edition` and `edition_golazos` are two arms of the same page for a reason:
// the first resolves from sitemap segment 1 (Top Shot only), so until the
// second was added, the edition arm could not see the AllDay / Golazos / UFC
// edition pages at all.
//
// ⚠ An arm may also assert CONTENT, via `expectText` on its ENTITY_SPEC entry.
// `edition_golazos` does: it is the only instrument in the repo that can see the
// edition page's outbound Dapper CTA, because the coverage gates include
// `app/**/route.ts` but NOT `page.tsx`, and jsdom renders no page at all. A red
// there means the CTA stopped rendering, NOT that the page is down — read the
// assertion before assuming an outage.

const TYPES = Object.keys(ENTITY_SPEC) as EntityType[]

// ── BAN AT ZERO ON DISCOVERY ITSELF ────────────────────────────────────────
//
// Every arm below is fail-soft by design: a type with no live URL is SKIPPED,
// because a thin catalog segment must not red the monitor. That is correct
// per type and it leaves one hole, which this test closes.
//
// 🚨 `fetchSitemapLocs` returns `[]` on ANY non-200 or fetch error — its own
// docstring says so — so if sitemap discovery breaks, EVERY arm skips and this
// workflow reports SUCCESS having inspected ZERO pages. That matters more here
// than almost anywhere: Sentry has dropped every event since 2026-08-18, so the
// scheduled E2E DOM smoke is the ENTIRE client-side detection surface, and a
// monitor that silently inspects nothing is indistinguishable from a healthy one
// at the badge.
//
// ⚠ It is not hypothetical. The sitemap has already served PARTIAL data under a
// 200 once (known-issues #28: `/sitemap/3.xml` returned 24k of 27.2k URLs
// because a paged read `break`-ed on error), and a 20 s fetch timeout on a
// saturation spell produces the same `[]`.
//
// ⛔ DELIBERATELY A BAN AT ZERO, NOT A FLOOR. Asserting "at least N of 8
// resolve" would red whenever a segment legitimately thins out, and this repo
// has recorded what a cry-wolf arm does to the board it lives on. Zero resolved
// types cannot be a thin catalog — the sitemap carries ~27k URLs — so it is
// either discovery breaking or the catalogue being empty, and both are things
// this monitor exists to say out loud rather than skip past.
test("entity · sitemap discovery resolved at least one live entity URL", async ({ request }) => {
  const resolved: string[] = []
  const missing: string[] = []
  for (const type of TYPES) {
    const path = await discoverEntityPath(request, type)
    ;(path ? resolved : missing).push(path ? `${type}=${path}` : type)
  }
  expect(
    resolved.length,
    "Sitemap discovery resolved NO entity URLs, so every arm below will skip and\n" +
      "this monitor will report success having rendered nothing. Check that\n" +
      "/sitemap/<id>.xml returns 200 with <loc> entries — fetchSitemapLocs turns\n" +
      "any non-200, parse failure or 20s timeout into an empty list.\n" +
      `Resolved: ${resolved.length}/${TYPES.length}. Unresolved: ${missing.join(", ")}`,
  ).toBeGreaterThan(0)

  // Surfaced in the run log so a reader sees WHAT was inspected, not just that
  // something passed — the count is the point of this test.
  console.log(
    `[entity-smoke] discovery resolved ${resolved.length}/${TYPES.length}: ${resolved.join(" · ")}` +
      (missing.length ? ` | unresolved: ${missing.join(", ")}` : ""),
  )
})


for (const type of TYPES) {
  test(`entity · ${type} detail page renders`, async ({ page, request }) => {
    const path = await discoverEntityPath(request, type)
    test.skip(!path, `no live ${type} URL in the sitemap right now`)
    await assertHealthyPage(page, {
      path: path!,
      name: `${type} detail`,
      expectText: ENTITY_SPEC[type].expectText,
    })
  })
}
