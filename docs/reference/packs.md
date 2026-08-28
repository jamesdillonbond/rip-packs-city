<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## Pack ingestion & classification (2026-05-18 session)

### `pack_purchases` architecture

- `seller_address = 0x18eb4ee6b3c026d2` is the **NFTStorefrontV2 escrow contract**, NOT a TokenForwarding receiver. Rows with this seller are **secondary peer-to-peer sales**; the actual selling user is identified by `storefront_resource_id` (980+ distinct values observed).
- `seller_address` has a CHECK constraint requiring `NULL` or `^0x[0-9a-f]{16}$` format. **Do NOT overload with sentinel values like `'mint:<contract>'`** — use the `event_kind` column instead.
- `event_kind` is the source-of-truth classifier with values:
  - `secondary_sale` — `NFTStorefrontV2.ListingCompleted`
  - `primary_withdraw` — TS `PackNFT.Withdraw` from contract reserve
  - `primary_mint` — AllDay `PackNFT.Mint`
- `is_primary_drop` is auto-derived via the `pack_purchases_set_is_primary_drop` trigger, which flips it `true` when `event_kind ∈ ('primary_withdraw', 'primary_mint')` OR `seller` matches the `primary_drop_forwarders` registry. **Workers set `event_kind` at ingest and the trigger handles the rest.**
- Unique constraint is `(tx_hash, pack_nft_id)` for idempotent upserts.

### Primary drop event signatures

- **Top Shot** — `A.0b2a3299cc857e29.PackNFT.Withdraw` where `from = 0x0b2a3299cc857e29` (contract account). Pre-minted reserve pattern. Buyer = matching `PackNFT.Deposit.to` in same tx. `pack_dist_id` is not in the event payload and resolves later (via `pack_rips` on open + a resolution sweep) — platform-wide coverage is normally ~85% of TS `primary_withdraw` rows (measured 2026-07-18; the old "always NULL" phrasing was wrong), but big drops lag (the 07-16/17 14.5k-pack drop crashed daily coverage to ~21–45% → TS-PACK-DIST-NAME-BACKLOG in the ledger). ⚠ **THE PER-WEEK CURVE LOOKS LIKE A COLLAPSING PIPELINE AND IS A MATURATION CURVE — do not open an incident on it (measured 2026-08-16).** By week of `sealed_at`: 98.4% (Apr 20) → 92.5% (May 18) → **59.1%** (Jun 8) → **64.8%** (Jul 13) → 40.0% (Jul 27) → **10.3%** (Aug 3) → **11.3%** (Aug 10). Because `dist_id` resolves **on OPEN**, a recent cohort is *supposed* to read low: of the 4,193 unresolved primary packs in the Jun 8 week, only **82 (2.0%)** have ever been opened. So the aggregate (82.6% at that measurement) is an AGE MIX, and the only genuine laggards are the two big-drop weeks stuck below the ~95% norm for their age — Jun 8 and Jul 13, i.e. the existing backlog item. ⚠ **The durable product consequence:** a pack that is never opened never gets a `dist_id`, so for a still-sealed TS pack we typically know **who holds it but not what it is**.
- **AllDay** — `A.e4cf4bdc1751c65d.PackNFT.Mint`. Mint-on-demand pattern; every `Mint` event is primary by definition (no signer check needed). Event carries `distId` field which populates `pack_dist_id` immediately. Buyer = matching `PackNFT.Deposit.to` in same tx. `seller_address` stays NULL since there's no prior holder.
- **Pinnacle / UFC / Golazos** — event signatures are **UNVERIFIED**. No primary drop activity observed in our data and Trevor's wallet has zero history there. When a primary drop happens on any of these, **decode a tx via Flow REST to confirm the contract path before adding ingestor coverage**. Golazos moments use `A.87ca73a41bb50ad5.Golazos.Withdraw / Deposit` for transfers, but pack path is not confirmed.

### `pack-events-ingest` worker cursors

All 7 cursors:

- `topshot_pack_purchases` (forward) and `topshot_pack_purchases_backfill` (walks forward filling gap) — **both handle ALL event types** in their chunks, so no separate primary backfill is needed for TS.
- `topshot_pack_opens` and `topshot_pack_opens_backfill` — moment delivery events from pack opens.
- `allday_pack_purchases` (forward) and `allday_pack_purchases_backfill` (walks forward, auto-stops within 1000 blocks of forward cursor).
- `topshot_pack_purchases_primary_backfill` is **RETIRED** — was redundant with the TS backfill which already handles all event types. Row left in `event_cursor` at fast-forwarded position `151848205` and watchlist disabled.

⚠ **A FROZEN TS BACKFILL CURSOR IS COMPLETE, NOT STALLED.** `topshot_pack_purchases_backfill` and `topshot_pack_opens_backfill` both stop at the worker's `TARGET_END_BLOCK` (**151,610,000**) and have not moved since 2026-05-21/22 — by design, so the historical and live ranges never overlap. The practical consequence is worth stating plainly: **Top Shot on-chain pack-purchase coverage genuinely begins ~2026-04** and will not extend backward without a new backfill range. ⚠ Conversely `allday_pack_purchases_backfill` **never terminates** (measured 2026-08-16: **50,877 rows found / 0 written in 7 days**, harmless via `ON CONFLICT`, pure waste). ⚠ **But the mechanism is NOT "a moving cursor never lets it reach" the target, which is how this line read until 2026-08-16 — it reaches the target constantly.** `alldayBackfillCatchupTarget` is recomputed on EVERY invocation as `forward − 1,000` from the *current* forward cursor, and **nothing LATCHES the caught-up state**: each tick the backfill walks up to the target, is marked `caught_up` for that invocation only, and the target then slides ~1 block/sec ahead of it, forever. Re-measured live 2026-08-17 01:09Z: backfill **161,576,600** vs forward **161,578,670** — **2,070 behind a 1,000-block threshold**, i.e. about to re-walk ground the FORWARD cursor has already ingested, which is why rows are found and ~none written. Fixing it is a `workers/pack-events-ingest` change needing an operator `wrangler deploy`. ⚠ **A prior session considered this latch and DECLINED it on merit — do not reopen it by guessing.** The correct terminal condition is a FIXED end block (what both TS cursors use, `TARGET_END_BLOCK` / `TS_PRIMARY_BACKFILL_END_BLOCK`), the AllDay forward cursor's seed point is **not** in the worker source, and "a guessed seed constant would create a real data gap". The waste is harmless; the wrong constant is not.

⚠ **`v_pack_pipeline_health` is the standing instrument, and it had all three failure modes this repo keeps documenting — rebuilt 2026-08-16 (`c9cd1c69`).** ⚠ **That rebuild is APPLIED and LIVE** — `20260816185749_audit_20260816_pack_pipeline_health_allday_arms_and_static_vs_wedged`, confirmed in `schema_migrations` and by the live column list (`collection_slug, stream, lane, cursor_id, pipeline, …, rows_attributable, status`), which is the post-rebuild shape; this bullet said "migration committed UNAPPLIED" for hours after it landed, the same stale-annotation class as the freshness view above. It was (a) **Top-Shot-only**, so four live All Day cursors appeared nowhere and All Day pack ingest could stop entirely with the view green; (b) **crying wolf** by rendering the two by-design-complete cursors above as a `seconds_since_update` that had reached **2,098 h and could only grow** — the `ufc_fmv_stale_hours` cost again; and (c) **unrunnable**, because two bare `count(*)` over `pack_purchases` + `pack_rips` blew the 60 s budget outright. It now carries both collections, uses `reltuples` estimates with recency riding `idx_pack_{purchases,rips}_collection_time`, and returns instantly. ⚠ **Its load-bearing property is a REFUSAL: `pack-events-ingest-backfill` drives FOUR cursors and writes ONE `pipeline_runs` row per invocation, so its `rows_found` is not attributable to any one cursor** — dividing it would have marked both *finished* TS cursors `wedged`, an incident manufactured from the monitor's own blind spot. Hence `rows_attributable=false` → the neutral status `static`. Statuses: `missing_cursor | map_broken | not_running | live | wedged | quiescent | static`; `map_broken` (fresh cursor, zero runs) exists because this view hardcodes a cursor→pipeline map that a worker rename would silently invalidate. Pinned by `supabase/tests/v_pack_pipeline_health.sql`.

⚠ **`rpc-topshot-pack-opens-history` (pg_cron jobid 56) returns `done: true` on every tick — that is a DELIBERATE STANDBY, do not unschedule it.** Everything above `SPORK_FLOOR` is ingested and the sporks below it are decommissioned, so the edge fn is inert-safe and "resumes exactly where it left off if the old sporks ever return." ~96 no-op calls/day is the price of that. (Recorded because it looks exactly like a dead cron on every instrument: 614 runs, 0 rows found, cursor unmoved for 10 days.)

### Wallet pack RPCs

- `get_wallet_pack_summary(p_wallet)` — totals split as `primary_drops` / `secondary_buys` plus currency breakdown and per-collection rollup. `primary_spent_usd` falls back to `pack_distributions.metadata->>'retail_price_usd'` joined via `pack_dist_id` (AllDay direct) or `pack_rips.dist_id` (TS post-open). Surfaces `primary_spend_unknown_count` for honest accounting when the dist / retail chain can't resolve.
- `get_wallet_pack_history(p_wallet, p_collection_slug, p_status, p_limit, p_offset)` — paginated per-pack timeline with `event_kind` per row and statuses `ripped` / `flipped` / `sold` / `held` / `other`, plus virtual status `sold_any` = `flipped OR sold` (added 2026-07-18 — the classifier marks a bought-then-sold sealed pack `flipped`, so a Sold tab wired to `sold` alone would drop the common case). Uses window functions to avoid N-fold lateral joins (v3 fix). Drives the Packs sub-tabs (Unopened→`held`, Opened→`ripped`, Sold→`sold_any`) on the wallet `?section=packs` view; Moments Owned·Sold uses `?moments=sold` + `/api/wallet/transaction-history?kind=sells`.
- `get_pack_for_simulator(p_collection_id, p_dist_id)` — bundles pack metadata, grail metrics, and full edition pool with `drop_weight` / `hit_probability` where probabilities sum to 1.0 because zero-weight editions are filtered server-side.
- `get_pack_lifecycle(p_pack_nft_id)` — canonical pack timeline (purchase → ownership chain → open → pulls).

### Pack grail metrics

- `pack_grail_metrics` is a **view**.
- `pack_grail_metrics_mv` is a **materialized view** with one row per `(collection_id, dist_id)`, refreshed via the `refresh_pack_grail_metrics_mv()` `SECURITY DEFINER` function doing `REFRESH MATERIALIZED VIEW CONCURRENTLY` on hourly cron at `:23` via `/api/cron/refresh-pack-grail-metrics-mv`.
- Computed on pullable editions only (`drop_weight > 0`).
- Exposes `weighting_method` (`'uniform'` for NFL / UFC / Pinnacle / Golazos, `'weighted'` for Top Shot) and per-slot probabilities (`prob_grail_25/100/500/1000_per_slot`, `prob_ultimate_per_slot`).
- **EV methodology:** `ev_per_slot` here and `pack_ev_latest.gross_ev / slots` both use `drop_weight`-weighted FMV averages via `compute_pack_ev_per_edition_weighted`. The previous "10% trimmed-mean against equal weights" note for `pack_ev_latest` was outdated — both surfaces should now reconcile. (Stale note corrected 2026-05-24.)

### Pack rip metadata

- `pack_rips.dist_id` and `pull_value_usd` are denormalized via the hourly `backfill_pack_rip_metadata(p_limit => 500)` sweep at `:53`, which finds rips where `metadata_updated_at IS NULL OR < now() - 7 days`, resolves `dist_id` via `drop_pool` edition overlap, and sums FMV across linked `moment_acquisitions`.
- ~25% of historical rips do not resolve to a `dist_id` (drop pool coverage only goes back to April 2026), so the frontend shows "Unknown distribution" gracefully.

### Pack-pull intelligence pipeline gotchas

- `pack_drop_pool` has zero-weight rows (~13K of 118K) representing exhausted editions, so all grail metrics and the simulator pool **MUST filter `drop_weight > 0`**.
- `pack_distributions.metadata.number_of_pack_slots` coverage is **83% for Top Shot and 0% for NFL / UFC / Pinnacle / Golazos**, so the frontend falls back to live `pack-ev` API's `momentsPerPack` or a 5-slot default with an "approx" badge.
- `pack_distributions.metadata.retail_price_usd` value range: `$0` for reward / quest packs and `$2+` for paid drops. `~$1M+` values would need `/1e8` satoshi conversion but no current Top Shot values exceed that, so flat numeric reading works.
- **Quest reward / set completion packs flow through the same `PackNFT.Withdraw` / `PackNFT.Mint` events as paid drops** and get `is_primary_drop = true` correctly. UI distinguishes via `pack_distributions.metadata.retail_price_usd = 0`.

### ⛔ Two `pack_drop_pool` columns that are NOT the instrument they look like (2026-08-28)

Both were nearly used to verify the pool-backfill fix, and both would have given a wrong answer.

- **`min(last_refreshed_at)` per `dist_id` is NOT a first-conversion timestamp.** The column is
  rewritten on every refresh, so grouping by it reports "conversions per hour" for hours **before** the
  change being tested — it read **64–136/hour** across a window whose true rate was ~25, including
  pre-fix hours. The pool is written delete-then-insert, so **no first-write history survives.**
- **`count(*)` over `pack_drop_pool` is NOT a progress measure.** It spans every collection and several
  writers, so it moves for reasons unrelated to whatever is being watched.

✅ **What to measure instead:** the sampler's own `pipeline_runs.extra->>'dists_ok'` for
`topshot-pack-pool-backfill`, cross-checked against the count of distributions that have pool rows.
On 2026-08-28 those agreed exactly — **`dists_ok` summed to 51 and TS dists-with-pool rose 1,715 →
1,766** — which is the kind of two-table agreement worth building the check around.

⚠ And read the backlog as a STOCK: it fell 368 → 330 while 51 converted, because 13 new distributions
arrived in the same window. A stock moving by less than the flow is not a stalled drain.

### Cron endpoints

Both endpoints use admin-auth via `INGEST_SECRET_TOKEN`:

- `POST /api/cron/refresh-pack-grail-metrics-mv` on schedule `23 * * * *` with 30s timeout.
- `POST /api/cron/backfill-pack-rip-metadata` on schedule `53 * * * *` with 30s timeout.

Both routes match the data-integrity admin-auth pattern with auth header `Authorization: Bearer ${INGEST_SECRET_TOKEN}`. **The apex domain returns 308 → www, so cron-job.org URLs must use `www.rippackscity.com`.**

