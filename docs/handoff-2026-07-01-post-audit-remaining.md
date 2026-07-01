# Handoff — 2026-07-01 post-audit remaining work (Cowork → Claude Code)

Full-stack audit + autonomous fix pass ran 2026-07-01 (Cowork, interactive with Trevor). Platform health GREEN; 6 fixes shipped live (below). This doc packages what's left — items that are sensitive (deal/sniper/pricing logic), route-heavy and collision-prone with in-flight daytime work, storage-cost decisions, or genuinely new builds. Read on desktop; normal markdown.

## Already shipped this session (LIVE on main — do NOT redo; listed for coordination)

DB migrations (via MCP, result-identical, `check_public_security_invariants()`=[]):
- `optimize_get_collection_stats_fmv_coverage_lateral_20260701` — get_collection_stats(text) FMV-coverage: full-history DISTINCT ON -> per-edition LATERAL LIMIT 1. 4125ms->369ms. Fixed the All Day overview hang + /nfl-all-day/overview smoke timeout. Revert: CREATE OR REPLACE back to the DISTINCT ON (prior def in migration history).
- `optimize_get_fmv_movers_lateral_20260701` — get_fmv_movers latest+previous CTEs -> LATERAL. 7139ms->236ms. Revert: same.

Route commits on main:
- `6ebcc8f` perf(overview): computeHighMediumPct -> LATERAL (/api/collection-stats ~2s->~0.5s).
- `aa7224b6` fix(csp): img-src allow cdn.nba.com + cdn.wnba.com (team logos render; verified live).
- `dbfce047` fix(pack-hero): onLoad naturalWidth===0 -> montage fallback (defensive; the "blank" Seeing Stars hero was actually dark art, a real 1835px image).
- `054701fb` fix(sentry): tracesSampleRate 1 -> 0.1 in instrumentation-client / server / edge configs (stops the /envelope 429 rate-limiting that was dropping event signal).

Two audit findings that were false alarms (verified, no action): Pinnacle render-page sales history already works (pinnacle_sales 99.99% render-linked, 2,186 traded renders; the pin first QA'd was untraded). Pack hero "blank" = dark pack art, not broken.

---

## 1. All Day ask / deal-finding wiring  (HIGH — marquee All Day parity gap)

All Day has full FMV but its Sniper/deal boards read empty and its edition floor is stale, because the deal path still reads the FROZEN `cached_listings`. The fresh ask data already EXISTS and is not wired in:
- `allday_edition_floor_ask` (edition_id, floor_ask, floor_ask_listed_at, floor_listing_resource_id, floor_flow_id) — 3,981 editions with a live floor ask, newest listed 2026-07-01 14:16, 490 in last 3d. Keyed by editions.id (uuid).
- `cached_listings_v2` (collection_id, edition_id, price_usd, completed_at, ...) — 21,514 OPEN All Day listings.

Scope (mirror the Top Shot deal path, don't invent a new discount algorithm — discount = (fmv - ask)/fmv, threshold 15%):
1. Populate `badge_editions.low_ask` for All Day (currently 0/1,572 — a documented gap in CLAUDE.md "Deferred hardening"). Source = `allday_edition_floor_ask.floor_ask`, joined edition_id -> editions.id -> editions.external_id -> badge_editions.external_id. Add a pg_cron refresh (CLAUDE.md explicitly prescribes "add a cron that walks the listing source and upserts min(ask) -> badge_editions.low_ask"). VERIFY the join is 1:1 and asks are sane vs FMV before enabling (no absurd floors -> fake deals).
2. Wire All Day into the deal surfaces: the `get_collection_stats` non-TS/non-Pinnacle sniper_deals branch currently reads `cached_listings` (frozen) — point it at the fresh source (or badge_editions.low_ask once populated). Check whether `cross_collection_deals_board` (/insights/deals) should gain an All Day branch too.
3. All Day edition page floor ask: currently reads the frozen source; surface `allday_edition_floor_ask.floor_ask`.

Guardrails: this feeds deal alerts (build_deal_alerts) — currently 0 subscribers so low blast radius, but verify no fake All Day deals before shipping. This is deal-finding logic (sensitive); test in the dev loop. Revert: each surface change is git-revertable; the low_ask populate is `UPDATE badge_editions SET low_ask=NULL WHERE collection='nfl_all_day'` + unschedule the cron.

## 2. Continue edition-page fan-out reduction  (MED — COORDINATE with in-flight daytime work)

Edition page (`app/(collections)/[collection]/edition/[slug]/page.tsx`) fires ~13 queries across two Promise.all blocks: line ~472 `[history, highOffer, insightLinks, ipfsAssets, badgeArt, subSiblings, repSales]` (7) and line ~909 `[sales, parallels, packs, notableSerials, packProvenance]` (5), plus get_edition_detail + get_edition_special_serials. Under concurrent load this exhausts the PostgREST pool ("Timed out acquiring connection from connection pool" — the dominant edition-page error class).

The daytime team is ALREADY on this (today: `705fb202` bundled squeeze/deal/first-mint into get_edition_insight_links; `e46249e` removed dead special_serial_holders). Continue the same pattern — bundle more single-row reads (candidates in block 1: highOffer + ipfsAssets + badgeArt + subSiblings are single-row lookups) into one SECDEF RPC to cut pooled connections/render. COORDINATE so you don't collide — this file changed multiple times on 2026-07-01. Note get_edition_fmv_history is already fast (30ms); the issue is query COUNT, not any single slow one.

## 3. get_player_top_sales index  (LOW-MED — storage decision for Trevor)

`get_player_top_sales` sorts by price_usd DESC over all of a player's editions' sales; slow for high-volume players (LeBron ~1.35s warm, trips its 8s statement_timeout cold). sales_2026 has `(edition_id, sold_at DESC)` (helps get_team_activity) but NO `(edition_id, price_usd DESC)`. Adding it would let the top-price sort use an index. It is already streamed via Suspense + 8s-guarded, so it's bounded, not breaking. Storage cost on the partitioned sales table -> Trevor's cost-flat call. If approved:
`CREATE INDEX CONCURRENTLY sales_2026_edition_id_price_usd_idx ON public.sales_2026 (edition_id, price_usd DESC);` (standalone execute_sql, NOT in apply_migration, per CLAUDE.md; repeat per active partition or on the parent). Revert: DROP INDEX.

## 4. PostgREST DB pool size  (OPERATOR config — highest single lever for the pool-timeouts)

The "Timed out acquiring connection from connection pool" (PGRST003) errors across edition/pack/player/team pages are app-side pool exhaustion. The DB itself has large headroom (14/90 connections in use). Raising the PostgREST `db-pool` / connection-pooler size in Supabase (Settings -> Database) would relieve this across all heavy detail pages at once. Not settable via SQL/MCP — dashboard/Management-API action. Do this in tandem with #2.

## 5. Pinnacle Pack EV  (BUILD — the one true Pack-EV parity gap)

Pack EV is full for Top Shot + All Day but absent for Pinnacle/Golazos/UFC. Pinnacle is the highest-value target. Pinnacle pack-drop event signatures are UNVERIFIED (per CLAUDE.md) — decode a real Pinnacle pack tx via the Cadence MCP / Flow REST first to confirm the contract path, then reuse the existing pack-EV machinery (pack_ev_latest / v_*_pack_lifecycle / realized_ev). If Pinnacle pack activity is too thin to index reliably, document and deprioritize.

## 6. Lower-priority

- All Day parity cleanup: surface cross_market_ask, backfill null pack titles, video_url (audit_20260624_allday_video_backfill_v2 exists — check status first). Also a stray blank team hero thumbnail (a moment whose thumbnail didn't resolve).
- FMV cold-tail coverage (All Day NO_DATA ~22%, Pinnacle tail): GATED — this is central pricing logic; extend the ASK_ONLY / honest-floor treatment only with review (per the fmv-pipeline-patch-restraint discipline). Do NOT autonomously edit the FMV writer.
- Retire dead columns: editions.first_minted_at (0/24,779 populated) + last_updated_at (147/24,779) — confirm no live consumer, then drop or populate so they can't mislead future queries.

---

## Addendum (2026-07-01, later) — team_activity is NOT a real problem + a plan trap

While chasing the residual `[team] activity` statement-timeouts I measured `get_team_activity` properly: it's **~187ms warm** (Lakers); the earlier ~2s reads were COLD. So the rare 8s-timeouts are cold/contended runs, not a hot-path problem — low priority, the pool bump (#4) covers it.

TRAP (verified the hard way — I shipped this, saw the regression, reverted): a naive per-edition LATERAL merge rewrite of `get_team_activity` REGRESSES to ~18s. Inside the function `v_variants` is a plpgsql-variable text[], so `e.team_name = ANY(v_variants)` does NOT use the `(collection_id, team_name)` index — the planner runs the LATERAL over ALL ~17k collection editions instead of the team's ~580. (A standalone test with an INLINE array plans differently and hides this.) If you ever optimize it: first `SELECT array_agg(id) INTO v_edition_ids FROM editions WHERE collection_id=... AND team_name=ANY(v_variants)` as its own statement, then filter the main query on the editions PK (`e.id = ANY(v_edition_ids)`) so the plan is stable — and verify the plan IN a plpgsql context, not standalone. Net change to the function this session: zero (reverted to the original JOIN form).

## Addendum 2 — get_platform_stats is a DEAD endpoint (removal candidate, not an optimization target)

`get_platform_stats()` times out (>8s): it runs the latest-FMV `DISTINCT ON` coverage scan THREE times — once GLOBAL/unfiltered over all `fmv_snapshots` (the killer) + twice per-collection. BUT `/api/platform-stats` (its only caller) is **fetched by nothing** — a repo-wide content search for "platform-stats" hits only 2 archived docs, no page/component/lib. So the timeout is moot (orphaned endpoint).

Recommendation: **remove** `get_platform_stats()` + `app/api/platform-stats/route.ts` (dead code). If instead you want to keep/revive it, the fix is NOT a naive LATERAL swap — I measured the global correlated LATERAL (`WHERE fs.collection_id = e.collection_id`) and it ALSO times out (~173k partition probes, correlated collection_id → bad plan). The correct fix is to compute the total as the SUM of the per-collection counts (each with a CONSTANT collection_id → the fast plan proven in get_collection_stats): build `per_collection` first, then `v_total_fmv_covered := SUM((col->>'fmv_covered')::int)`. Low priority either way (dead).

## Net of the "keep-going" pass (for honesty)
Probed the two remaining perf residuals directly. Both were non-actionable-safely: `get_team_activity` is ~187ms warm (not a real problem; a LATERAL rewrite regressed to 18s — reverted), and `get_platform_stats` is a dead endpoint. Net new production change from this pass: zero. Conclusion: the safe Cowork-shippable optimization surface is exhausted; the real remaining work is the CC builds (#1 residual matviews, #5 Pinnacle Pack EV) + the operator pool bump (#4).
