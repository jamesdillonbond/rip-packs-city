---
name: rpc-insights-qa
description: Pre-ship checklist for a Rip Packs City public /insights surface — triggers on "ship an insights surface", "new /insights page", "launch a squeeze/pack-reality/rookies board", "review insights before deploy", or touching any public insights route+page+OG. Covers backing-view security, smoke, sitemap, canonical, drill-downs, freshness, brand.
---

# /insights surface launch QA

Run before shipping or after touching any public `/insights/*` surface. RPC ships these weekly and the 14→3 SECDEF-view regression came in through exactly this path, so treat it as a gate.

For each surface, verify:

1. **Backing data** — the backing view returns rows. Empty/erroring view = broken public surface. The `rpc-insights-health` artifact shows live counts per surface; check it after deploy.
2. **Security (the regression magnet):**
   - The backing view ships `WITH (security_invoker = on)` — otherwise it lands as a Supabase `security_definer_view` ERROR.
   - Every base table it reads has RLS on; anon holds `SELECT` only (no INSERT/UPDATE/DELETE).
   - Re-check via the `rpc-security-drift` artifact or `SELECT * FROM check_public_security_invariants();` (expect 0 rows).
3. **Route + page + OG** — `/api/public/insights/<x>` returns 200 JSON; `/insights/<x>` renders for anon (the front door is public); the OG card (`/api/og/...`) returns 200. Smoke all three.
4. **Sitemap** — the route is listed in `app/sitemap.ts`. The whole `/insights` wedge is the distribution thesis; crawlers must be told (a surface was shipped once with zero sitemap entries).
5. **Canonical** — the page sets a param-stripped self-canonical (via its `layout.tsx`) so `?wallet=` / `?player=` / `?set=` filtered URLs don't index as duplicate content (the tc-report gap, fixed 2026-05-30).
6. **Drill-downs** — any `?player=` / `?set=` filter passes `min_squeeze=0` (or the equivalent floor drop) so partial-match rows render instead of an empty page (the Dylan Harper 48.9%-squeeze empty-page bug).
7. **Freshness + honesty** — the data source recomputes on its cron (FMV / pack-EV / badge cadence); drill-downs with no rows show an honest empty state, not a blank.
8. **Brand** — RPC tokens only (`var(--rpc-red)`, `var(--font-display)`, `var(--font-mono)`), never hardcoded `#E03A2F` / `'Barlow Condensed'`.

After ship: smoke every insights surface in one pass (commit `91186b5` smoke-confirmed all 21 at once — routes + pages + OG cards); if it's a new standing dataset, add it to the `rpc-insights-health` artifact's surface list. Any route/.tsx change can't be pushed from Cowork — package it with the `rpc-handoff` skill.
