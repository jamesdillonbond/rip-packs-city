import { test } from "playwright/test"
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
// ⚠ These arms assert page HEALTH, not page CONTENT. The Golazos edition page
// gained an outbound "View edition on Dapper" CTA (dapperMarketEditionUrl,
// 2026-08-22) whose rendering NO instrument currently verifies — the coverage
// gates include `app/**/route.ts` but not `page.tsx`, and jsdom cannot render
// it. Asserting it here is one line — add
// `expectText: /View edition on Dapper/i` to the edition_golazos check — but
// it was deliberately NOT added blind: a scheduled monitor that reds on its
// first run is indistinguishable from a broken one. Confirm the CTA in a
// browser once, THEN pin it here.

const TYPES = Object.keys(ENTITY_SPEC) as EntityType[]

for (const type of TYPES) {
  test(`entity · ${type} detail page renders`, async ({ page, request }) => {
    const path = await discoverEntityPath(request, type)
    test.skip(!path, `no live ${type} URL in the sitemap right now`)
    await assertHealthyPage(page, { path: path!, name: `${type} detail` })
  })
}
