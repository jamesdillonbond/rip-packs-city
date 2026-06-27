# Handoff — 2026-06-01 full-platform audit follow-ups (Claude Code)

Plain-text, paste-into-Claude-Code. Cowork already shipped the 2 DB migrations below (live + verified) — DO NOT redo them; they're listed for context + revert. Everything else is code Cowork can't push. Each item has a revert path. Work directly on main, commit + push, run smoke after.

Context: full audit 2026-06-01. Platform GREEN. The only material product gap is All Day has no offer data source, so "Best offer" is a permanent em-dash on All Day moment/edition pages. The RPC get_edition_high_offer is correct (collection-agnostic) — it's missing ingest, not broken.

ALREADY SHIPPED LIVE BY COWORK (context only):
- audit_20260601_v_moments_needing_hydration_materialized_cte — view rewrite (Merge Anti Join -> Nested Loop over a MATERIALIZED CTE) to kill topshot-moments-hydrator timeouts. Verified 146,792 rows identical, batch read 588ms->167ms. Revert: CREATE OR REPLACE VIEW public.v_moments_needing_hydration AS SELECT nft_id, collection_id, wallet AS owner_address, acquired_date, source_pack_rip_id FROM moment_acquisitions ma WHERE acquisition_method='pack_pull' AND acquisition_confidence='verified' AND NOT EXISTS (SELECT 1 FROM moments m WHERE m.nft_id::text=ma.nft_id AND m.collection_id=ma.collection_id);
- audit_20260601_funnel_events_anon_insert_size_caps — bounded anon insert sizes. Revert: ALTER POLICY funnel_events_anon_insert ON public.funnel_events WITH CHECK (true);

---

H1 [small, CX] — stop rendering a bare "Best offer —" on collections with no offer source.
Where: edition page app/(collections)/[collection]/edition/[slug]/page.tsx (~L393-397) and the real moment page app/moment/[id]/page.tsx (~L691-705). Both read highOffer from get_edition_high_offer.
Fix: only render the "Best offer" StatCell when highOffer?.highest_offer is a positive number; otherwise omit the cell entirely. This removes the permanent em-dash on every All Day page (edition_offers is 100% Top Shot) and on TS editions with no live offer. Tradeoff to confirm with Trevor: omitting loses a "no offers yet" signal — acceptable, the floor/ask cell already carries liquidity context.
Verify: /nfl-all-day/edition/446 no longer shows a "Best offer —" cell; /nba-top-shot/edition/8:133 still shows BEST OFFER $5,000.
Revert: git revert.

H2 [small, CX] — "Top Shot ask" label is hardcoded on All Day pages.
Where: edition page ~L389-392 ("TOP SHOT ASK") and moment page ~L690. On an NFL moment it literally reads "TOP SHOT ASK".
Fix: make the label collection-aware. Suggest "Floor ask" as the neutral cross-collection label, or per-collection ("Top Shot ask" / "All Day ask"). The value source stays low_ask / top_shot_ask.
Verify: /nfl-all-day/edition/446 ask cell no longer says "Top Shot ask".
Revert: git revert.

H3 [medium, DB+code] — surface cross_market_ask for All Day (2,446 editions computed but dropped).
Background: get_edition_detail's standard path (TS/AllDay/Golazos/UFC) builds the FMV jsonb but omits cross_market_ask (the V1-Dapper marketplace ask). The Pinnacle path already selects it. badge_editions.low_ask covers only ~39% of All Day, so cross_market_ask is a free +2,446-edition ask signal.
DB half (apply_migration, additive + safe — adding a jsonb key doesn't break readers): in get_edition_detail, add 'cross_market_ask', fmv.cross_market_ask to the standard-path jsonb_build_object (mirror the Pinnacle path's selection). Re-GRANT after CREATE OR REPLACE (service_role + whatever the current grantees are — verify with \df+ / role_table_grants first; get_edition_detail is anon/authenticated-callable). Revert: re-CREATE the prior body.
Code half: on the edition page, when collection is All Day and the standard ask (low_ask) is null but cross_market_ask is present, render it in the ask cell (label per H2, e.g. "Market ask"). 
Verify: an All Day edition with cross_market_ask (query editions/fmv for one) shows the ask instead of "—".

H4 [medium, ingest — the real All Day best-offer fix] — All Day offers-sweep.
Build app/api/cron/offers-sweep equivalent for All Day: walk All Day's marketplace GQL (consumer endpoint via topshot-proxy /allday-consumer; look for a highestOffer / top-bid field per edition like TS searchMarketplaceEditions exposes), upsert into edition_offers with collection_id = dee28451-5d62-409e-a1ad-a83f763ac070 keyed on external_id. Once rows exist, get_edition_high_offer surfaces them automatically (no RPC change) and H1's hidden cell reappears with real data. Add a cron-job.org entry (~*/20, Bearer INGEST_SECRET_TOKEN). If All Day GQL exposes no offer field, document that and keep H1 (hide) as the permanent answer.
Verify: edition_offers gets All Day rows; /nfl-all-day/edition/<id> shows BEST OFFER.

H5 [small/data] — All Day "Found in these packs" shows generic "Pack" labels. ROOT CAUSE CONFIRMED (verified this pass): it's a DATA gap, not a render bug. get_edition_in_packs(collection_id, slug) for /nfl-all-day/edition/446 returns 3 packs (dist_id 3/4/12) with pack_title=NULL (also pack_image_url/total_minted/depletion_pct NULL) because there are ZERO matching rows in pack_distributions for those All Day dist_ids — the LEFT JOIN finds no title. So the page correctly has no name to render.
Two fixes (pick one): (a) backfill pack_distributions title/image for the All Day dist_ids (proper); or (b) in the edition page render, hide the "Found in these packs" card (or show a neutral label) when pack_title is null, so it stops rendering bare "Pack" placeholders. (b) is the quick CX win.
Verify: pack cards show real names, or the section renders cleanly without orphan "Pack" tiles.

H6 [cosmetic] — league:"NBA" hardcoded in the collection-grid server mapper.
Where: app/(collections)/[collection]/collection/page.tsx ~L940 (serverMomentToRow) sets league:"NBA" for every collection. All Day moments get tagged NBA. Derive from collection instead. Legacy monolith, low priority.

---

CLEANUP (bundle into the same PR or a quick follow-up):

C1 — git rm lib/pro/gate.tsx (dead stub, 0 importers, misleading "TODO: wire Stripe"; real gate is components/ProGate.tsx). Then npx tsc --noEmit. Revert: git revert.

C2 — Doc fixes:
- CLAUDE.md Known-issue #14: sniper/page.tsx "~2,485" -> "~2,070".
- CLAUDE.md Known-issue #15: mark resolved — the livetoken-portfolio*.json / test fixtures are already untracked (git ls-files shows none); nothing to git rm.
- Scrub topshot_rookies_board -> topshot_2025_rookie_index wherever used as a live reference (the former view does not exist in the DB). The line-84 correction note can stay as history.
- docs/operations/cron-schedule.md: add RPC Offers Sweep (/api/cron/offers-sweep, ~*/20, Bearer INGEST_SECRET_TOKEN — verified firing 43x/24h all-ok) and evm-transfers-ingest (Base/Beezie) to the Active table; dial back / re-note the "FMV Recalc Force Stale" 3,13,... -> 8,28,48 (first sweep long complete).
- app/api/cron/offers-sweep/route.ts header (~L20-23): drop the stale "Operator: add a cron-job.org entry... until then readers fall back" note — the cron is live.

C3 [optional, cosmetic] — rpc-pipeline.yml: relabel the 4 "Refresh Flowty listings" steps (routes live, Flowty fetch gated off; names misleading). Confirm ts-listing-ingest.yml + scripts/ts-ingest.js + FLOWTY_PROXY_TOKEN still hit a live feed, and that /api/backfill still does useful work.

---

OPERATOR (not code, Trevor):
- cron-job.org: dial RPC FMV Recalc Force Stale from 3,13,23,33,43,53 back to 8,28,48.
- Cowork Scheduled: delete the spent one-shot chain-abstraction-phase-d-f-closeout (already fired 06-01 17:10, disabled).
- Sentry: NEXTJS-1B is 24h+ clean -> mark resolved.