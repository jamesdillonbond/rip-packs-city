# Handoff — NFL All Day per-moment badge ingestion (Claude Code)

**Goal:** give NFL All Day real per-moment badges (Top-Shot-parity), replacing the set-name heuristic. Supersedes item 3 of [handoff-2026-06-26-audit-followups.md](handoff-2026-06-26-audit-followups.md) and the AllDay-badge section of [handoff-2026-06-26-residual-closeout.md](handoff-2026-06-26-residual-closeout.md) — read those for context; this is the executable plan.

Normal markdown, read on desktop.

## What's confirmed (don't re-investigate)

Empirically verified on Dapper Market (`dapper.market/nfl`) 2026-06-26:

- **NFL All Day badges are real, per-moment, structured, and filterable** — NOT set-level and NOT heuristic-derivable. Observed badge facets in the live filter rail: **All Day Debut, Rookie Year, Historical, Launch Codes** (achievement badges), plus position (e.g. QB), tier (Rare/Legendary), and Series. Filtering uses a `?badges=<slug>` param (observed `badges=rookie-year`); slugs are kebab-case. There are more badges behind the rail's **"Select"** button (the visible four are not exhaustive). Moment cards also carry parallel chips (e.g. "Obsidian").
- **The badge↔moment mapping lives in the Dapper / NFL All Day backend.** dapper.market fetches it **server-side** (Next.js App Router RSC — the browser makes no public XHR for the moment list, only Segment analytics), so it's not a casually-scrapable browser endpoint.
- **It's egress-gated, not data-gated.** The source is the same NFL All Day backend (the `nflallday.com/consumer/graphql` family our code already references) that **Cloudflare-WAF-403s our Vercel/worker egress** — the same block behind the 389 AllDay `unmapped_sales`. A **residential IP reaches it fine** (the data rendered in a residential Chrome session). So the existing residential-egress lever is the path.

### Guardrails (important)
- **Do NOT expand `classifyAlldayBadges` / `ALLDAY_BADGE_RULES`** in [lib/allday-badges.ts](../lib/allday-badges.ts). Trevor's correction stands: badges vary per-moment within a set, so any set-name rule smears a single guess across moments that differ. The heuristic is a stopgap to be *replaced*, not widened.
- **Residential egress only** for the WAF'd source. Do not route the badge fetch through the topshot-proxy worker or raw Vercel egress (both 403). Reuse the residential runner already used for the dapper.market/Atlas underpriced-serials ingest (see [[dapper-market-post-flowty-marketplace]] / the underpriced-serials board's Atlas curl-ingest spine).
- **Secret-safety:** never echo any auth header/key from the AllDay GQL into logs or commits.

## Task 1 — confirm the endpoint + exact badge field (residential probe)

The browser RSC path hides the field name, so confirm it from a residential surface, not a DOM scrape:

- Probe the NFL All Day consumer GraphQL (`nflallday.com/consumer/graphql`, worker route `/allday-consumer` per the API-contracts section of CLAUDE.md) from the **residential runner**, requesting per-moment badge/tag fields on the moment/edition resolvers already in use (`searchMomentNFTsV2(byFlowIDs)` / `getMintedMoment(momentId)` — see [lib/chains/flow/alldayGraphql.ts](../lib/chains/flow/alldayGraphql.ts), which currently requests none). Try field names in this order based on the observed taxonomy: `tags`, `badges`, `playerBadges`, `momentBadges`, `play { badges }`, `edition { play { tags } }`. A GraphQL introspection query (if enabled) resolves it definitively.
- Cross-check the slugs against the Dapper filter set: `all-day-debut`, `rookie-year`, `historical`, `launch-codes`, + the rest behind "Select".
- **Output of Task 1:** the exact endpoint + field path + the full slug→title list. If the consumer GQL turns out NOT to expose badges, the fallback source is the dapper.market backend the RSC calls (inspect via the residential runner's own request, since dapper.market is also residential-reachable) — but the consumer GQL is the expected source.

## Task 2 — ingestion writer (mirror badge-sync)

- Add the badge field to the AllDay GQL query in [lib/chains/flow/alldayGraphql.ts](../lib/chains/flow/alldayGraphql.ts) (`GET_ALLDAY_EDITIONS` and/or the per-moment query), run through the **residential** path.
- Replace the string-match writer in [app/api/seed-allday-badges/route.ts](../app/api/seed-allday-badges/route.ts) with a real per-moment-tag writer that maps the resolved badge slugs → titles and writes them to `badge_editions.play_tags` / `set_play_tags` for the AllDay collection (`dee28451-5d62-409e-a1ad-a83f763ac070`). Mirror the normalize/merge logic in [app/api/badge-sync/route.ts](../app/api/badge-sync/route.ts) (`normalizeEdition` / `mergeTags`) so the AllDay rows land in the same shape `get_edition_badges_unified` already reads. Keep the existing AllDay allowlist discipline (the TS badge-sync allowlists real badge titles — do the equivalent for AllDay so position/tier facets don't leak in as "badges").
- Keep it a discrete cron/route like the TS badge-sync; add a `pipeline_runs` row + a `pipeline_cadence_watchlist` entry once it has 2 clean ticks.
- **Display already works:** [get_edition_badges_unified] → the edition page ([app/(collections)/[collection]/edition/[slug]/page.tsx](../app/(collections)/[collection]/edition/[slug]/page.tsx) L631-646) renders `badgeArt.get(normalizeBadgeKey(b))` and falls back to a text pill when no SVG art exists. So new AllDay badges render as honest text pills immediately — no UI change required.

## Task 3 — badge art (optional, follow-on)

- Source NFL All Day badge SVGs for `badge_taxonomy.icon_url` (the TS `nbatopshot.com` badge art won't match NFL badges). Until art exists, the text-pill fallback is correct and fine. This is a content task, not a blocker.

## Revert paths
- Task 2 writer: `git revert` the route/lib commits; the heuristic writer is in git history. `badge_editions` AllDay rows are additive — to roll back data, `DELETE FROM badge_editions WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'` then re-run the old `seed-allday-badges` (heuristic) once.
- New cron/watchlist row: `DELETE FROM pipeline_cadence_watchlist WHERE pipeline='<new-name>'` + remove the cron entry.

## Verification
- After a sync tick: an AllDay edition page shows badges that match Dapper Market for that exact moment (e.g. a rookie's moment shows **Rookie Year** / **All Day Debut**; a non-rookie in the same set does NOT — proving per-moment, not set-level).
- `badge_editions` AllDay distinct titles ≫ the current 4 heuristic types, and align to the Dapper slug taxonomy.
- `check_public_security_invariants()` = 0, `check_secdef_anon_execute_violations()` = `[]` after any DB change.

## Gating decision (Trevor)
This is worth doing iff the residential-egress lever is in scope for badges (it already runs for the underpriced-serials ingest, so the marginal cost is low). The target data is now confirmed real, structured, and per-moment — Task 1 is a bounded probe, not open-ended research.
