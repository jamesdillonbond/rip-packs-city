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

const TYPES = Object.keys(ENTITY_SPEC) as EntityType[]

for (const type of TYPES) {
  test(`entity · ${type} detail page renders`, async ({ page, request }) => {
    const path = await discoverEntityPath(request, type)
    test.skip(!path, `no live ${type} URL in the sitemap right now`)
    await assertHealthyPage(page, { path: path!, name: `${type} detail` })
  })
}
