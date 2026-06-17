# Handoff 2026-06-16 — Underpriced #1s deal board: ingest route + public page (GREENLIT; Cowork DB scaffolding shipped)

Trevor **greenlit the build 2026-06-16** — this overrides the standing 2026-06-08 Atlas-defer decision. The Atlas feed is fully captured (no schema guessing left), the DB foundation + a clean set of service-role helpers are shipped and verified live, and the enumeration design is settled. What remains is route/.tsx code (CC's domain): the ingest, the public page, and the alert filters.

Companion docs (read first): `docs/handoff-2026-06-16-dapper-atlas-listings-source.md` (the captured Atlas spec — method/body/response/headers/egress), `docs/handoff-2026-06-16-buyer-backfill-maxduration.md` (the after()/maxDuration lesson — apply it here).

---

## DB interfaces ready (Cowork-shipped this session, live + verified, service_role-only)

Migration `audit_20260616_deal_board_ingest_scaffolding`. All three are `SECURITY DEFINER`, `service_role`-only (no anon/public leak — `check_secdef_anon_execute_violations` stays `[]`).

1. **`topshot_serial_board_candidates(p_min_no1_estimate numeric DEFAULT 0)`** → `TABLE(rpc_edition_id uuid, external_id text, set_id_onchain int, play_id_onchain int, series smallint, tier text, circulation_count int, edition_fmv_usd numeric, confidence text, no1_estimate_usd numeric, perfect_estimate_usd numeric)`. The ingest's "what to query" source — board-eligible TS editions (latest FMV HIGH/MEDIUM, `set_id_onchain`+`play_id_onchain` NOT NULL so the inert UUID dupes are excluded, circ>0), with the #1 and perfect serial-FMV estimates (same `serial_fmv_estimate` gating the board view uses). Scoped by a $-floor on the #1 estimate to bound Atlas volume. **Counts: 3,067 at $0 · 1,977 at ≥$50 · 1,078 at ≥$100.**
2. **`upsert_topshot_active_listings(p_rows jsonb)`** → `int` (rows upserted). Bulk upsert on the PK `(edition_id, serial_number)`; sets `active=true, last_seen_at=now()`. Each array element: `{edition_id(uuid), edition_key, serial_number(int), nft_id, ask_usd(numeric), serial_fmv_usd(optional), listing_resource_id, listing_url, listed_at(optional ts)}`. **Verified end-to-end**: seeded a Curry `2:147` #1 at $6,576.93 → surfaced on the board at 50% discount vs its $13,153.85 estimate → cleaned; table back to 0.
3. **`deactivate_stale_topshot_active_listings(p_max_age interval DEFAULT '6 hours')`** → `int`. Flips `active=false` on listings not re-seen within the window (call once at sweep end so delisted serials drop off the board).

The board view **`topshot_underpriced_serials_board`** (CC, prior) reads `topshot_active_listings` + `serial_fmv_estimate`, surfaces active `serial=1 OR serial=circulation_count` rows where `ask_usd < estimate_usd`, ranked by `discount_pct`. It's inert until the ingest fills the table.

Revert (DB scaffolding): `DROP FUNCTION public.topshot_serial_board_candidates(numeric); DROP FUNCTION public.upsert_topshot_active_listings(jsonb); DROP FUNCTION public.deactivate_stale_topshot_active_listings(interval);`

---

## Atlas feed — new findings this session (beyond the captured-spec doc)

- **Serial sort works; there is NO server-side serial *filter*.** `sortByOption:"SERIAL_NUMBER"` + `sortByDirection` is honored (DESC `limit:1` → highest listed serial = perfect when `==numMinted`, live-verified serial 35000; ASC `limit:1` → lowest listed serial = #1 when `==1`). But a `{serialNumber:1}` filter is **silently ignored** (Connect-RPC drops unknown fields — tested int and string, both returned non-#1 rows). **Do not look for a serial filter; it isn't there.** → per-edition boundary queries are required; you can't stream "all #1s" in one call.
- **The global query (no `editionId`) works** (`{product:"nba",completed:false,...}` returns cross-edition listings), but **`pagination.totalCount` is unreliable at global scope** (returned "3" for the whole NBA market). Don't size anything off it.
- **Atlas `setId` == RPC `set_id_onchain`** — VERIFIED (Atlas edition 2017 = Base Set/Series 2 `setId:26`; RPC Base Set S2 = `set_id_onchain 26`, 533 editions). This is the basis for the edition-id map below.

---

## Enumeration design (settled): scoped per-candidate, serial-boundary

1. `topshot_serial_board_candidates($floor)` — **recommend `$100` (1,078 editions) to start**, or `$50` (1,977) for wider coverage; tune to the Atlas budget. (A $3 common's #1 isn't a deal-board entry, so a floor is correct, not just a perf hack.)
2. Per candidate: **one ASC `limit:1`** (the #1 end) **+ one DESC `limit:1`** (the perfect end) on `SearchMarketplaceTransactions{completed:false, editionId, sortByOption:"SERIAL_NUMBER"}`. Accept the ASC row only if its `serialNumber == "1"`; accept the DESC row only if `serialNumber == numMinted` (else that special serial simply isn't listed → no row). ~2 calls/candidate → ~2,156 calls/sweep at the $100 floor.
3. **Atlas-`editionId` map** (the one build-time piece): the candidate gives `(set_id_onchain, play_id_onchain)`, but Atlas queries need Atlas's integer `editionId`. Build the map once via Atlas `EditionService/SearchEditions{product:"nba", limit:"50", offset paginated}` (returns per edition: `id, setId, seriesId, editionTemplateId, tier, numMinted`), joined to RPC `editions` on `set_id_onchain = setId` **AND** `play_id_onchain = editionTemplateId`. **Confirm `editionTemplateId == play_id_onchain` with one `GetEdition` against a known RPC edition before trusting the join** (`setId==set_id_onchain` is already verified; the play-level half is the only unconfirmed bit). Persist as a tiny table `(rpc_edition_id uuid, atlas_edition_id text, …)`, refreshed occasionally for new editions. *Fallback:* every listing row carries `nftId` (RPC's indexed moment id), so listing→RPC-edition resolution at write time works even if the edition map is imperfect — but you still need `atlas_edition_id` to *target* the per-candidate query, so build the map.
4. **Cadence/fragility**: Atlas rate-limits (6 rapid probes → HTTP 200 with empty `transactions`). Be gentle: ~1–2 calls/sec, chunk candidates, self-budget under ~250s/run, **resumable cursor** (offset into the candidate list, stored in `pipeline_runs.extra`), multiple runs per full sweep.

---

## Ingest route — `/api/cron/topshot-active-listings-ingest`

- Auth `Bearer INGEST_SECRET_TOKEN`/`CRON_SECRET`. Mirror the **buyer-backfill/tshb** safety pattern — and heed `handoff-2026-06-16-buyer-backfill-maxduration.md`: if you `after()`-wrap, make sure the background work finishes under `maxDuration` (set `maxDuration` with headroom, ≤ 800); a synchronous self-budgeted route is also fine. Log `pipeline_runs` (`pipeline='topshot-active-listings-ingest'`) on every path; support `?dryRun`.
- Per run: resume cursor → next N candidates → resolve each to `atlas_edition_id` → 2 Atlas calls → keep matching #1/perfect rows → `upsert_topshot_active_listings(jsonb)` → advance cursor. At end of a full sweep, call `deactivate_stale_topshot_active_listings('6 hours')`.
- **Headers** (egress confirmed from a plain Vercel server POST — no Worker needed): `connect-protocol-version: 1`, `content-type: application/json`, `Origin: https://dapper.market`, `Referer: https://dapper.market/`, a real browser `User-Agent`.
- **Write mapping**: `serialNumber→serial_number`, `priceCents/100→ask_usd`, `nftId→nft_id`, `uuid→listing_resource_id`, `listedAt→listed_at`; `edition_key` = RPC `external_id`; `listing_url` = a dapper.market deep link. Optionally stash the candidate's `no1_estimate_usd`/`perfect_estimate_usd` into `serial_fmv_usd` at write time (the board recomputes it live anyway).
- **PII**: the row's `seller` object carries `dapperId`(auth0)/`username`/`profileImageUrl` — **store only `sellerAddress`** (the table has no seller column today; if you add one, address-only).

## Operator (after the route ships)
- Add a cron-job.org entry (Bearer `INGEST_SECRET_TOKEN`, **www** host, fire-and-forget 202), low cadence (every 30–60 min). The board is inert until it runs once — same activation pattern as the omni-channel alerts.

## Public surface (after the table fills)
- `/api/public/insights/underpriced-serials` — read `topshot_underpriced_serials_board` via `supabaseAdmin`, mirror `/api/public/insights/serial-premiums` (tier 400-on-invalid, `min_discount`, `headline=no1|perfect`, sort, `limit` clamp ≤100, 15-min `s-maxage`).
- `/insights/underpriced-serials` page + `layout.tsx` (metadata/JSON-LD, param-stripped self-canonical) + OG route + `sitemap.ts` entry. **Run the `rpc-insights-qa` checklist.** Honest empty state (the board can legitimately be empty when nothing's underpriced).
- **Drill-down + outbound link**: `nft_id → /moment/<id>` (RPC moment page) + the real dapper.market buy link **`https://dapper.market/nba/moment/<nft_id>`** (RPC `nft_id` == dapper's moment id). **Re-confirmed live 2026-06-16**: `dapper.market/nba/moment/49220771` renders the board's Jalen Green LEGENDARY perfect #50/50 with a live **"Moment listed for $79 · Purchase"** button — so this is a true buy target, not just a detail page. Board rows are by-definition currently-listed so they resolve (the 404 coverage caveat only hits unlisted/unindexed moments). The ingest can populate `listing_url` with this directly — no browser discovery needed.
- **Honest presentation via `estimate_quality`** (additive column, shipped live `audit_20260616_underpriced_board_estimate_quality`): each row is `'tight'` or `'coarse'`. **`tight`** (28/43 today — perfect-mints, non-COMMON tiers, or HIGH-base editions) = trustworthy discount → lead with these. **`coarse`** (15/43 — a COMMON #1 on a MEDIUM-base big common) = the population multiplier is empirically grounded (the COMMON·#1 cells are `is_reliable` on 136/152/22 real sales) but coarse — it has no player-desirability axis, so the discount magnitude is right for stars and overstated for role players (e.g. McLaughlin Base #1/4099 $14 vs a $110 population estimate). Present `coarse` rows with an "estimate — varies by player" framing or ranked below `tight`, **not** a precise headline `-87%`. Don't hide them (some are real star deals); just don't oversell. (Long-term fix = a player-desirability factor in the #1-common estimate — a serial-FMV *methodology* change, review-gated, not a launch dependency.)

## Serial deal alerts — matcher SHIPPED (live + verified); dispatcher wiring is CC's live-path step

The per-serial matcher is shipped: **`topshot_serial_deal_alerts_for_subscription(p_subscription_id uuid)`** (migration `audit_20260616_topshot_serial_deal_alert_matcher`, SECDEF, service_role-only). It mirrors `build_deal_alerts_for_subscription`'s return shape but matches the subscription against the **per-serial** `topshot_underpriced_serials_board`. (The existing `build_deal_alerts_for_subscription` matches the edition-level `cross_collection_deals_board`, which has **no serial dimension** and so cannot enforce serial filters — that's why this is a separate fn, not an edit to it.) **Verified**: a `require_last_mint=true` test sub returned 10 perfect-mint `tight` deals, top Jalen Green #50/50 @ 84.3% with the dapper `listing_url` (test sub cleaned up; 0 subs remain).

- **Enforced** (in the fn): `estimate_quality='tight'` (hard default — alerts never push the coarse role-player #1 noise the public board shows labelled), `min_discount`, `min_price`, `max_price`, `tiers`, `player_names`, `set_names`, `min_serial`, `max_serial`, `require_last_mint`. TS-only (gated on the sub including Top Shot's collection id).
- **Not enforceable yet** (returned in the fn's `unenforced_filters` for transparency): `require_jersey_serial` (needs `players.jersey_number == serial`; jersey coverage ~18%), `require_never_sold` (needs per-serial sales history), `require_low_ask` (every board row is already an underpriced ask), `badges`, `team_names`.
- **CC — the live-path step (do when activating alerts):** wire `topshot_serial_deal_alerts_for_subscription` into `dispatch_due_deal_alerts` so a subscription with any serial filter set also gets serial-board deals queued. It's a drop-in (same `{deals_count, deals[], owner_key, channels}` shape). The alert system is inert today (0 subs / 0 channels), so this is safe to wire whenever. **Do not modify `build_deal_alerts_for_subscription`** — keep the per-serial path separate.

## Player-desirability factor for #1-common estimates (VALIDATED 2026-06-16 — real + significant; review-gated build)

The coarse concern is **confirmed by data, and the direction is inverse** to the naive intuition. Over TS COMMON editions (circ≥1000) with a real #1 sale in the last 180d, bucketed by edition-FMV tercile, the realized #1 *multiple* falls sharply as edition FMV rises:
- low FMV ($0.31–1.10): median realized **~37×** (median #1 price $25)
- mid FMV ($1.12–2.23): median realized **~19×** (median #1 price $34)
- high FMV ($2.25–40.55): median realized **~10.8×** (median #1 price $45)

The population `serial_fmv_multipliers` cell applies a flat ~52× to all of them, so it **overstates the most desirable (high-FMV) commons the most (~5×)** — the absolute #1 price rises with desirability ($25→$45) but the premium-as-a-multiple compresses. (Exact calibration vs the grid's per-band multipliers needs band/window reconciliation, but the inverse direction is unambiguous.)

- **Guard already corrected** (live, `audit_20260616_underpriced_board_estimate_quality_fix_common_no1`): every COMMON #1 is now `coarse` regardless of base confidence. The prior "HIGH base → tight" carve-out had mislabeled exactly the worst-overstated rows — e.g. Cade Cunningham COMMON #1, $59 ask vs a $118 population est but a **~$25 realized** #1 value (so $59 is *over* value, not a 50% deal). `tight` is now perfect-mints + non-COMMON tiers only (today: 27 tight / 16 coarse).
- **The real fix (review-gated `serial_fmv_estimate` change)**: make the #1-common multiplier FMV-aware — scale it **down** as the edition's FMV percentile rises within its `(tier, circ_band)` peer group, fitting the multiple as a function of FMV-percentile (the tercile data above is the evidence). This would let many COMMON #1 rows return to `tight` honestly. Same gate: don't edit the live pricing fn inline; propose + review.
- Non-COMMON tiers + perfect mints kept `tight` (far lower multipliers — RARE #1 5.45×, LEGENDARY #1 2.56×, perfect 7.78× — so much smaller absolute overstatement; validate similarly before extending the fix there).

## Guardrails
Atlas spec is capture-verified — **don't re-guess param names** (the serial filter is confirmed absent). Gentle Atlas cadence (it rate-limits). Direct-to-`main`, PowerShell git, full-file writes, `maxDuration ≤ 800`. Insights surface → `rpc-insights-qa`. CC's direct inspection wins over this doc.
