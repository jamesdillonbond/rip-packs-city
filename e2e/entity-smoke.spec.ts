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
// ⚠ An arm may also assert CONTENT, via `expectText` on its ENTITY_SPEC entry.
// `edition_golazos` does: it is the only instrument in the repo that can see the
// edition page's outbound Dapper CTA, because the coverage gates include
// `app/**/route.ts` but NOT `page.tsx`, and jsdom renders no page at all. A red
// there means the CTA stopped rendering, NOT that the page is down — read the
// assertion before assuming an outage.

const TYPES = Object.keys(ENTITY_SPEC) as EntityType[]

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
