-- 2026-08-08 · UFC arm re-pointed: `ufc_fmv_stale_hours` → `ufc_flow_revival_sales_30d`.
-- Snapshot of the LIVE v_rpc_trust_health.
--
-- ⚠ REPO CATCH-UP MIGRATION. Applied to production via MCP as
-- `audit_20260808_ufc_arm_repoint_revival_detector` with no committed file;
-- this commits the resulting definition verbatim from pg_get_viewdef, so it is a
-- NO-OP against prod and byte-identical to what runs. Third instance of this
-- prod/repo drift class this week (after get_wallet_collection_stats on 08-06
-- and the candy coverage arms earlier today).
--
-- WHAT CHANGED, and why re-point rather than retire or re-threshold.
-- The retired arm measured hours since the last UFC FMV recompute. UFC Strike's
-- market has been closed since May 2026, so after the 2026-08-03 confidence-cap
-- trigger its value grows WITHOUT BOUND: it read 103.6 against a breach at 30 and
-- was PERMANENTLY RED. Its own note had already recorded the decision owed and
-- ruled out the lazy fix: "Do NOT simply raise breach_at: an unbounded value
-- defers the crossing without making the reading honest."
--
--   ufc_flow_revival_sales_30d — count of UFC-on-Flow sales with sold_at in the
--   last 30 days. breach_at 1. Reads 0 (ok) today; FIRES the moment UFC trades
--   again. Baseline at install: 0 in 30d, 3 in 90d, last UFC sale of any kind
--   2026-05-13 (87 days).
--
-- THREE REASONS RE-POINTING BEAT RETIRING:
--   1. A permanently-red arm is worse than no arm — it teaches the operator to
--      skim past all 38 arms.
--   2. On revival the old arm would merely FALL SILENT, and nobody watches for
--      silence. Same shape as the dispatch-vs-outcome error class.
--   3. ⚠ Nothing else fires on UFC revival — checked, not assumed. The
--      `ufc_sales` suppression (lapses 2027-01-29) hides an arm that fires on
--      SILENCE and therefore structurally cannot fire on RESUMPTION; the
--      `unmapped-sales-ufc_strike` suppression (lapses 2027-01-25) hides the only
--      arm keyed on fresh inflow; and the `ufc-sales-indexer` cadence row is a
--      TOTAL-STOP signal, not a restart signal. Revival was undetectable. This
--      closes a gap rather than trading one signal for another.
--
-- ⚠ KEYS ON `sold_at`, NOT INGEST TIME — load-bearing. `ufc-sales-history-backfill`
-- and `ufc-studio-sales-history-backfill` are both ACTIVE and add ~200 historical
-- rows/24h; an ingest-time predicate would read that backfill as a revival.
-- Confirmed empirically: 0 rows in the 30-day sold_at window while both backfills
-- were running. Also does not filter on price, so a zero-price or unpriced trade
-- cannot slip past. UFC volume is a floor, not a census — but this arm only ever
-- separates zero from nonzero, so an undercount can suppress a true positive and
-- can NEVER manufacture a false one.
--
-- No FMV coverage is lost: Step 6 of /api/fmv-recalc is collection-agnostic and
-- separately covered by the topshot/allday/golazos/candy freshness arms.
--
-- ⚠ THE ALTER VIEW BELOW IS LOAD-BEARING. CREATE OR REPLACE VIEW WIPES
-- reloptions, and this exact view silently lost security_invoker=on that way on
-- 2026-08-03. The two statements must always ship together. Verify by reading
-- reloptions back — NOT by a predicate like `'security_invoker=true' = any(...)`,
-- which reports OFF when it is ON, because Postgres stores the token you passed
-- (`=on`). That false negative reads as a security regression.
--
-- REVERT: re-splice the view replacing the `ufc_flow_revival_sales_30d` branch
-- with the original `ufc_fmv_stale_hours` branch (COALESCE over
-- max(fmv_snapshots.computed_at) for collection 9b4824a8-…, breach 30), then
-- re-run the ALTER VIEW. The retired note's substantive content is preserved in
-- docs/handoff-2026-08-05-fmv-sweep-wedge-incident.md and the 08-04 UFC closure
-- docs; nothing load-bearing was lost with the arm.

CREATE OR REPLACE VIEW public.v_rpc_trust_health AS
 WITH packev AS (
         SELECT max(EXTRACT(epoch FROM now() - topshot_pack_reality_top_ev.snapshotted_at) / 86400::numeric) AS max_stale_days,
            round(100.0 * count(*) FILTER (WHERE topshot_pack_reality_top_ev.depletion_pct >= 90)::numeric / NULLIF(count(*), 0)::numeric, 0) AS pct_depleted
           FROM topshot_pack_reality_top_ev
        ), pre AS (
         SELECT p.metric,
                CASE
                    WHEN p.computed_at < (now() - '24:00:00'::interval) THEN 999::numeric
                    ELSE p.value
                END AS value
           FROM rpc_trust_health_precompute p
        ), raw AS (
         SELECT 'pack_ev_board_max_stale_days'::text AS metric,
            ( SELECT packev.max_stale_days
                   FROM packev) AS value,
            2::numeric AS breach_at,
            'stale pack-EV board (hit 44d on 2026-06-05)'::text AS catches
        UNION ALL
         SELECT 'pack_ev_board_pct_depleted'::text AS text,
            ( SELECT packev.pct_depleted
                   FROM packev) AS pct_depleted,
            30::numeric AS "numeric",
            'depleted packs ranked as top EV'::text AS text
        UNION ALL
         SELECT 'ts_uuid_dupes_created_24h'::text AS text,
            ( SELECT count(*)::numeric AS count
                   FROM editions
                  WHERE editions.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND editions.external_id::text !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text AND editions.created_at > (now() - '24:00:00'::interval)) AS count,
            200::numeric AS "numeric",
            'DQ4 dupe-writer leak re-polluting the editions table'::text AS text
        UNION ALL
         SELECT 'edition_integrity_flags'::text AS text,
            ( SELECT COALESCE(sum(v.canonical_bad_circulation + v.canonical_missing_tier + v.canonical_missing_thumbnail), 0::numeric) AS "coalesce"
                   FROM v_edition_integrity_flags v) AS count,
            250::numeric AS "numeric",
            'canonical editions defects summed across collections: null/0 circulation + missing tier + missing thumbnail. Excludes accepted TS UUID-dupe residue and the structurally-null candy/ufc on-chain-id columns. FIXED 2026-07-28: previously counted ROWS of the per-collection GROUP BY view (always 5) so it never summed defects and could not breach. breach_at 250 sits above the continuous thumbnail-hydration baseline to catch a real deterioration (dupe-writer leak, hydration-cron death, whole-set tier/circ wipe) not normal churn'::text AS text
        UNION ALL
         SELECT 'fmv_sweep_wedge_hours'::text AS text,
            ( SELECT w.hours_since_cursor_advance
                   FROM v_fmv_sweep_wedge w) AS "coalesce",
            3::numeric AS "numeric",
            'the fmv-recalc catalogue sweep WEDGED at an interior cursor offset -- runs keep firing but stop making progress, so the catalogue silently stops being repriced. Hours since the sweep cursor last ADVANCED (a successful run whose cursor_after differs from cursor_before; the end-of-catalogue wrap, cursor_after NULL with has_more=false, counts as an advance). THIS IS THE ARM fmv_sweep_stall_pct_24h STRUCTURALLY CANNOT BE: that one measures the share of runs starting at cursor_before=0, i.e. the 2026-08-03 restart-at-page-0 class, and a sweep stuck at an INTERIOR offset never restarts at 0 -- it read 4.3 = ok through the entire 2026-08-05 incident, in which throughput fell from about 3,000 editions/h to 7-46/h for eight hours while every per-collection freshness arm also stayed green (other writers -- cold-tail, thin-sales-guard, ask_only -- keep touching computed_at, which is why the *_fmv_stale_hours family cannot see a sweep outage either). Calibrated on the retained 72h window INCLUDING that incident: 293 advances, gap p50 0.20h, p95 0.55h, max 6.00h. breach_at 3 is 5.5x the healthy p95 and would have fired on 08-05. Deliberately ABOVE the sibling fmv-recalc cron_silent alert (120 min), which detects ABSENCE of runs; this detects runs that happen and achieve nothing. INLINE, not precomputed: index-served on pipeline_runs_pipeline_started_idx at 4 buffers / ~11ms, so it costs nothing and carries no precompute staleness. pipeline_runs retains only ~73h, so if the sweep were wedged longer than the whole retention window there would be no advancing run at all -- that reports 999 and BREACHES, because absence must never read as health.'::text AS text
        UNION ALL
         SELECT 'fmv_stale_touch_hours'::text AS text,
            COALESCE(( SELECT round(EXTRACT(epoch FROM now() - max(pr.started_at)) / 3600.0, 1) AS round
                   FROM pipeline_runs pr
                  WHERE pr.pipeline = 'fmv-recalc'::text AND pr.extra ? 'stale_touch'::text AND ((pr.extra ->> 'stale_touch'::text)::integer) > 0), 999::numeric) AS "coalesce",
            36::numeric AS "numeric",
            'Step 6 of /api/fmv-recalc -- the force_stale LIVENESS TOUCH -- stopped touching anything. Hours since a fmv-recalc run last reported extra->>stale_touch > 0. THIS IS THE ONLY ARM COVERING STEP 6: it keeps about 692 HIGH/MEDIUM editions with no in-window sales from ageing (579 Top Shot + 113 All Day), and every per-collection *_fmv_stale_hours arm is structurally blind to it, because those read max(computed_at) across the WHOLE collection and the sweep writes TS and All Day constantly -- measured 2026-08-05, those arms sat at 0.0-0.1h while their Step-6 cohort aged to 36h. If Step 6 died every other arm would stay green. WHY THIS SHAPE: the direct cohort-age measurement costs 379s and about 930k buffers (measured via a cron_heavy one-shot, since it exceeds a 60s client budget: TS cohort 579 at min 12.6 / p50 16.7 / max 36.2h, All Day 113 at 12.6 / 16.7 / 36.1h -- TS is NOT worse than All Day). That is too expensive to run every 6h for a cohort whose staleness has no user-facing effect, since Step 6 only touches editions with NO recent sales so the VALUE is unchanged and only computed_at moves. Watching the writer own reported output instead is index-served and safe inline. WARNING, MEASURED NOT ASSUMED: substituting the stored fmv_snapshots.sales_count_30d for the live 30-day sales anti-join collapses the cohort 692 to 22, because that column is the count AT COMPUTE TIME and fossilises as sales age out of the window -- the same self-contradiction class the 2026-08-03 fmv_snapshots_zero_stale_sales_count trigger exists for. Do NOT optimise the cohort query that way. CALIBRATION over the roughly 73h pipeline_runs retention window, which INCLUDES the 2026-08-05 saturation incident: 22 touching runs, 1,388 rows touched, about one touch every 3.3h, current gap 14.9h elevated because the incident ate force_stale runs. breach_at 36 is 1.5x Step 6 own 24h gate and about 2.4x that incident-elevated gap, so an ordinary bad day cannot page but a dead Step 6 surfaces within 36h; only ~73h of history exists to calibrate on, so revisit once pipeline_runs_daily has depth. KNOWN LIMIT, stated not hidden: this is a GLOBAL signal -- if Step 6 kept touching Top Shot but stopped for All Day this arm stays green; the 379s cohort arm would catch that, and that trade is deliberate. Reports 999 when no touching run exists in the retention window, because absence must BREACH rather than read as health.'::text AS text
        UNION ALL
         SELECT 'fmv_sanity_flags'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'fmv_sanity_flags'::text), 999::numeric) AS "coalesce",
            1::numeric AS "numeric",
            'impossible FMV (WAP > max sale, negative, etc.). Fires only when a TopShot edition''s FMV is BOTH under 12% of its set median (set median >$100, >=4 priced peers, HIGH/MED confidence, >$50 gap) AND under 60% of that edition''s OWN 30d sales median on >=4 of its own priced sales with a >$50 gap -- the 2026-08-01 own-sales corroboration that killed the star-set false positive, since a genuinely cheap role player in an expensive set is honest intra-set dispersion, not a mispricing. PRECOMPUTED (2026-08-02): inline, this arm cost 22.5s COLD and 2.1s WARM (~80k buffers -- a per-edition LATERAL latest-FMV probe across 12,984 canonical TopShot editions, then a per-set median), which made it the single largest STRUCTURAL cost in this view and the only arm still expensive when warm. It pushed the whole view to 38-64s, past the service_role 30s statement_timeout, so /api/sentinel could not read this board AT ALL -- the monitor failed BLIND, because a timeout reads as "0 breaches". Its ~80k-buffer working set was also evicting the cheaper arms from cache on Micro (offer_edition_gap measured 7.4s cold vs 68ms warm), so removing it speeds up arms it does not touch. Now read from rpc_trust_health_precompute, refreshed 6-hourly by cron job rpc-trust-health-precompute-refresh (jobid 222, cron_heavy, 600s budget), and computed there by selecting v_fmv_sanity_flags ITSELF rather than a copy of its predicate, so the corroboration logic can never drift from what this arm reports. TRADE: up to 6h of staleness on a metric whose baseline is 0 and whose breach_at is 1 -- acceptable because an impossible-FMV condition persists until fixed rather than self-clearing within the window, and the alternative was a board nobody could read. A missing or >24h-old precompute row reports 999 and BREACHES rather than reading 0.'::text AS text
        UNION ALL
         SELECT 'pinnacle_fmv_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(pc.fmv_computed_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM pinnacle_catalog pc
                  WHERE pc.fmv_usd IS NOT NULL) AS "coalesce",
            30::numeric AS "numeric",
            'render-FMV recompute (pinnacle_fmv_recalc_render_all via daily pinnacle-sync) frozen'::text AS text
        UNION ALL
         SELECT 'pinnacle_render_floor_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(pc.floor_ask_updated_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM pinnacle_catalog pc
                  WHERE pc.floor_ask_updated_at IS NOT NULL) AS "coalesce",
            30::numeric AS "numeric",
            'render-keyed floor (pinnacle_catalog.floor_ask powers ASK_ONLY FMV + every public render/edition/set page) frozen: daily floor-map writer pinnacle_catalog_set_floor_asks stalled. NOT caught by pinnacle_ask_stale_hours, which watches the narrow pinnacle_editions.ask table'::text AS text
        UNION ALL
         SELECT 'pinnacle_fmv_impossible_flags'::text AS text,
            ( SELECT count(*)::numeric AS count
                   FROM v_pinnacle_fmv_sanity_flags) AS count,
            3::numeric AS "numeric",
            'render-keyed Pinnacle FMV impossible/grossly-overpriced (fmv<=0, or HIGH/MED fmv > 3x max 90d sale); the global fmv_sanity_flags metric is TopShot-only so Pinnacle FMV correctness was unmonitored'::text AS text
        UNION ALL
         SELECT 'offer_edition_gap_max_usd'::text AS text,
            ( SELECT COALESCE(max(f.gap_usd), 0::numeric) AS "coalesce"
                   FROM v_offer_sanity_flags f
                  WHERE f.has_sub_serial = false AND (f.offers_refreshed_at > f.top_offer_created_at OR f.top_offer_created_at < (now() - '02:00:00'::interval))) AS "coalesce",
            50::numeric AS "numeric",
            'edition-grain on-chain offer not surfaced in edition_offers (raise_edition_offers_from_chain / offers-sweep stalled). GRACE (2026-07-31): a gap counts only if offers-sweep has actually run for that edition since the offer landed (offers_refreshed_at > top_offer_created_at) OR the offer is older than 2h (6x the 20-min sweep cadence) -- the second arm is what still catches a fully stalled sweep, which the first arm alone would go blind to. Without this the metric read 178 with the sweep at 72/72 runs ok: all five flagged offers were 7-15 min old and had simply not been swept yet. Latency was being reported as a correctness defect'::text AS text
        UNION ALL
         SELECT 'board_mv_refresh_stale_hours'::text AS text,
            board_mv_refresh_max_stale_hours() AS "coalesce",
            8::numeric AS "numeric",
            'a MATERIALIZED public board serving stale data. Three boards were materialized 2026-08-01/02 for real wins (perfect-mint 16,992ms->1.5ms, pack-reality 9,798ms->0.14ms, market-index 5,809ms->0.46ms), but an MV changes the FAILURE MODE: a dead refresh reads as plausible stale data, and BOTH board-liveness arms are blind to it because a stale MV still returns plenty of rows, fast. check_pgcron_recent_failures() catches a refresh that RUNS AND FAILS but CANNOT catch one that is never SCHEDULED (no run rows to fail). This measures the OUTCOME - hours since the last SUCCESSFUL refresh - so unscheduled, deactivated, dropped and persistently-failing all stop the clock identically. All three jobs are hourly, so 8h = 8 missed ticks; a never-scheduled MV yields 999 and breaches immediately, because an unscheduled refresh must be LOUD not silently green.'::text AS text
        UNION ALL
         SELECT 'unmapped_resolution_backlog_max'::text AS text,
            ( SELECT COALESCE(max(z.cnt), 0::bigint)::numeric AS "coalesce"
                   FROM ( SELECT count(*) AS cnt
                           FROM unmapped_sales us
                          WHERE us.resolved_at IS NULL AND COALESCE(us.price_usd, 0::numeric) > 0::numeric AND us.sold_at > (now() - '30 days'::interval) AND us.sold_at < (now() - '24:00:00'::interval) AND COALESCE(us.resolution_hint ->> 'promote_blocked'::text, ''::text) <> 'sales_tx_hash_unique_collision'::text
                          GROUP BY us.collection_id) z) AS "coalesce",
            100::numeric AS "numeric",
            'a collection''s RECENT (30d) priced sales failing edition-resolution (live resolver/WAF stall) -> sales undercount; aged residual excluded (e.g. accepted AllDay April V1 tail), AND multi-item-transaction rows that idx_sales_tx_hash makes structurally unstorable excluded (they can never be drained by any resolver -- measured separately in v_sales_tx_collision_loss), so this signals NEW stalls not the historical floor. FINDING 2026-08-01 (metric BREACHED at 100/100, resolver HEALTHY at ~2.2k resolved/24h): the excluded floor is CONTINUOUSLY REPLENISHED, not historical. AllDay carries 29,598 aged-out permanently-unresolvable rows (21,667 v1_dapper, oldest 2026-01-20) and ~100 more arrive per 30d, all attempted, none carrying a failure reason. So the in-window count is this month cohort of a PERMANENT class, and age-based exclusion cannot separate it from a real stall. DO NOT raise breach_at -- it only defers the next crossing. The fix is to make the resolver record a permanent-failure reason and exclude by REASON (as sales_tx_hash_unique_collision already is). Until then this arm reads BREACH as an honest open finding. GRACE PERIOD (2026-07-29): rows sold in the last 24h are excluded -- they are still in flight, not failures. Fresh sales resolve at p50 6.6min / p99 34min, so 24h is 40x p99 and cannot mask a stall, while giving the slower wmc/wallet-walk promote path (max observed 73h) a fair chance. Without it a high-volume day (283 arrivals vs 74) counted its own in-flight tail and breached at 106 with the resolver fully healthy'::text AS text
        UNION ALL
         SELECT 'topshot_fmv_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(fmv_snapshots.computed_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM fmv_snapshots
                  WHERE fmv_snapshots.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AS "coalesce",
            6::numeric AS "numeric",
            'ALL TopShot FMV writers stalled (per-collection freshness; global check masks single-collection outage)'::text AS text
        UNION ALL
         SELECT 'allday_fmv_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(fmv_snapshots.computed_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM fmv_snapshots
                  WHERE fmv_snapshots.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) AS "coalesce",
            12::numeric AS "numeric",
            'ALL AllDay FMV writers stalled (fmv-recalc 5b + studio + allday-fmv-populate all down)'::text AS text
        UNION ALL
         SELECT 'golazos_fmv_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(fmv_snapshots.computed_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM fmv_snapshots
                  WHERE fmv_snapshots.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid) AS "coalesce",
            30::numeric AS "numeric",
            'ALL Golazos FMV writers stalled (low-volume; daily sweep should keep <30h)'::text AS text
        UNION ALL
         SELECT 'ufc_flow_revival_sales_30d'::text AS text,
            ( SELECT count(*)::numeric AS count
                   FROM sales
                  WHERE sales.collection = 'ufc_strike'::text AND sales.sold_at > (now() - '30 days'::interval)) AS count,
            1::numeric AS "numeric",
            'REVIVAL DETECTOR. Replaced the ufc FMV staleness arm on 2026-08-08 (Trevor delegated the call; the note on the retired arm asked for exactly this -- retire or re-point, and do NOT simply raise breach_at). MEASURES: UFC-on-Flow sales with sold_at inside the last 30 days. Reads 0 today; BREACHES on the first one. WHY THE SWAP: the retired arm measured hours-since-UFC-FMV-recompute, which after the 2026-08-03 confidence-cap trigger grows WITHOUT BOUND -- no threshold can make it green, so it was RED PERMANENTLY, and a permanently red arm is worse than no arm because it teaches the operator to skim past the whole board. Worse, on an actual revival that arm would merely fall SILENT, and nobody watches for silence. GAP THIS FILLS, checked rather than assumed on 2026-08-08: nothing else fires on UFC revival. The ufc_sales suppression (lapses 2027-01-29) hides the silent_failure arm, which triggers on silence and therefore cannot trigger on resumption. The unmapped-sales-ufc_strike suppression (lapses 2027-01-25) hides the only arm keyed on fresh inflow. The ufc-sales-indexer cadence row is a total-stop signal, not a restart signal. KEYS ON sold_at, NOT ON INGEST TIME -- deliberate: ufc-sales-history-backfill and ufc-studio-sales-history-backfill are both active and add roughly 200 historical rows per 24h, and an ingest-time predicate would read that backfill as a revival. Confirmed empirically the same day: 0 rows in the 30d sold_at window while both backfills were running. DOES NOT FILTER ON PRICE, so a zero-price or unpriced trade cannot slip past. THE UFC COVERAGE CAVEAT DOES NOT WEAKEN THIS ARM: UFC volume is a FLOOR and not a census (see the ufc_sales suppression), but this arm only ever separates zero from nonzero, so an undercount can suppress a true positive and can never manufacture a false one. IF IT BREACHES: UFC-on-Flow has traded again -- re-look at all four UFC suppressions, the frozen-by-design FMV closure, and collections.market_closed_at before assuming any of them still hold. NO FMV COVERAGE IS LOST BY THE SWAP: Step 6 of /api/fmv-recalc is collection-agnostic and is separately covered by the topshot, allday, golazos and candy freshness arms. Baseline at install: 0 sales in 30d, 3 in 90d, last UFC sale of any kind 2026-05-13 (87 days). Plan at install: Index Only Scan on idx_sales_2026_pulse_window, cost 3.65, six partitions pruned. Revert: claude/finding-ufc-arm-repointed-2026-08-08.md carries the retired arm verbatim.'::text AS text
        UNION ALL
         SELECT 'topshot_impossible_parallel_serials'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'topshot_impossible_parallel_serials'::text), 999::numeric) AS "coalesce",
            3::numeric AS "numeric",
            'F1 parallel mis-attribution: sales keyed onto :: parallel editions as impossible serials (serial > parallel circ); invisible to editions-flat / UUID / FMV sentinels — the 0->6 offer_fill drift on 2026-07-02 was caught only by a manual sweep. Guarded at all 4 writers; pages a future regression. PRECOMPUTED (2026-07-25): read from rpc_trust_health_precompute, refreshed 6-hourly by cron job rpc-trust-health-precompute-refresh; a missing or >24h-old precompute row reports 999 and BREACHES rather than reading 0'::text AS text
        UNION ALL
         SELECT 'topshot_fmv_pct_stale_30d'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'topshot_fmv_pct_stale_30d'::text), 999::numeric) AS "coalesce",
            50::numeric AS "numeric",
            'COVERAGE leg, TOPSHOT CANONICAL ONLY as of 2026-08-04: share of canonical TopShot editions (external_id matching ^[0-9]+:[0-9]+(::[0-9]+)?$) whose LATEST fmv_snapshots.computed_at is >30d old. THIS ARM IS INERT BY DESIGN AND ITS ORIGINAL PURPOSE WAS DISPROVED. Three findings, all measured 2026-08-04. (1) MIS-ATTRIBUTION, now fixed: it read 32.2% and 6263 of 6263 stale editions were non-canonical UUID-keyed dupe residue, canonical stale being 0 with worst age 7.0d. So 100% of the headline came from a population ts_uuid_dupes_created_24h already watches, and a dupe-growth event would have paged as a TopShot FMV repricing stall -- a wrong diagnosis, worse than no arm. edition_integrity_flags already excludes the same residue; the canonical predicate makes this leg match it. (2) THE STATED PURPOSE FAILS A BACK-TEST. The old text claimed it catches a partial or selective writer stall that topshot_fmv_stale_hours structurally cannot see. Evaluated as-of during the 2026-07-20..08-03 fmv-recalc sweep stall -- the exact outage, with 74% of the catalogue never recomputed -- the canonical form read 0.00% on every probe date (07-20, 07-25, 07-29, 08-02, 08-03). It could not have fired. Reason: computed_at records WHEN ANY WRITER LAST TOUCHED THE ROW, not when FMV was recomputed from sales, and TopShot has 8+ concurrent writers (1.7.0, cold-tail-1.0, topshot-gql-v1, thin-sales-guard-v3, ultimate-v1 and haircut variants) that between them touched all 13,021 canonical editions inside ~7d while the sweep was 74% dead. Peak-stall profile on 08-02: 33.7% >3d, 11.7% >5d, 0.1% >7d, 0.0% >10d, 0.0% >14d. A 30d test on this column CANNOT FIRE. (3) THE WHOLE FAMILY SHARES THE CEILING: max latest-FMV age is AllDay 7.00d, Golazos 6.96d, Candy 0.38d, TopShot canonical 7.00d, so allday/golazos/candy_fmv_pct_stale_30d are 4x or more above their structural ceiling and are equally unbreachable. Only ufc_fmv_pct_stale_30d carries signal, and only because UFC has no live writer. breach_at DELIBERATELY LEFT AT 50, NOT re-baselined: the value now reads 0.0, but the healthy steady state is one day old (sweep fixed 2026-08-03) and setting a threshold off one day would repeat the exact error of the 2026-07-25 baseline of 32.3%, captured while the sweep was already stuck. RE-BASELINE ON OR AFTER 2026-08-18 (14d of healthy history) and switch the cut from 30d to 3d: the stalled-vs-healthy separation lives there (stalled 49.4/40.1/48.2/41.9% on 07-22/26/30 and 08-02 vs healthy 19.1% on 08-04), while >7d shows no separation at all (0.2-0.7% stalled vs 0.4% healthy). Successor arm: pct of canonical TopShot editions with latest computed_at older than 3d, breach_at ~2x the settled healthy value. Until that re-baseline, fmv_sweep_stall_pct_24h is the live stall detector and this arm is a placeholder holding its slot. PRECOMPUTED (2026-07-25): inline it pushed this view past the 30s service_role budget and a timeout reads as 0 breaches, i.e. the monitor fails BLIND; a missing or >24h-old precompute row reports 999 and BREACHES.'::text AS text
        UNION ALL
         SELECT 'allday_fmv_pct_stale_30d'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'allday_fmv_pct_stale_30d'::text), 999::numeric) AS "coalesce",
            25::numeric AS "numeric",
            'COVERAGE leg (baseline 0.0% on 2026-07-25): share of priced AllDay editions whose LATEST FMV is >30d old; complements allday_fmv_stale_hours, which only reads the freshest row. STRUCTURALLY UNBREACHABLE at 30d, measured 2026-08-04: the max latest-FMV age of ANY edition is 7.00d (AllDay) / 6.96d (Golazos), so a 30d test sits over 4x above the ceiling and cannot fire at any threshold. computed_at records when any writer last touched the row, not when FMV was recomputed. Treat as a placeholder; the successor cut is >3d. PRECOMPUTED (2026-07-25) — see topshot_fmv_pct_stale_30d'::text AS text
        UNION ALL
         SELECT 'golazos_fmv_pct_stale_30d'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'golazos_fmv_pct_stale_30d'::text), 999::numeric) AS "coalesce",
            40::numeric AS "numeric",
            'COVERAGE leg (baseline 0.0% on 2026-07-25): share of priced Golazos editions whose LATEST FMV is >30d old; complements golazos_fmv_stale_hours. STRUCTURALLY UNBREACHABLE at 30d, measured 2026-08-04: the max latest-FMV age of ANY edition is 7.00d (AllDay) / 6.96d (Golazos), so a 30d test sits over 4x above the ceiling and cannot fire at any threshold. computed_at records when any writer last touched the row, not when FMV was recomputed. Treat as a placeholder; the successor cut is >3d. PRECOMPUTED (2026-07-25) — see topshot_fmv_pct_stale_30d'::text AS text
        UNION ALL
         SELECT 'ufc_fmv_pct_stale_30d'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'ufc_fmv_pct_stale_30d'::text), 999::numeric) AS "coalesce",
            99.5 AS "numeric",
            'COVERAGE leg (baseline 72.3% / median FMV age 1277h on 2026-07-25): share of priced UFC editions whose LATEST FMV is >30d old. UFC Flow trading is dead since 2026-05-13 so a HIGH baseline is HONEST (no sales = nothing to reprice); breach_at 99.5 sits above that floor so the metric catches a REVIVAL-THEN-STALL rather than paging on the permanent 2026-05-13 Aptos-migration outage. Threshold history, because this one has been mis-set twice: 90 -> 101 (a percentage cannot exceed 100, so it was UNBREACHABLE) -> 98 on 2026-08-01 (only 1.9pp above the live 96.1, so it would page on ordinary drift) -> 99.5 on 2026-08-02, Trevor-confirmed. Do NOT raise it above 100. If UFC ever revives on Flow, re-base this DOWN to ~3x the new steady-state. STRUCTURALLY UNBREACHABLE at 30d, measured 2026-08-04: the max latest-FMV age of ANY edition is 7.00d (AllDay) / 6.96d (Golazos), so a 30d test sits over 4x above the ceiling and cannot fire at any threshold. computed_at records when any writer last touched the row, not when FMV was recomputed. Treat as a placeholder; the successor cut is >3d. PRECOMPUTED (2026-07-25) — see topshot_fmv_pct_stale_30d'::text AS text
        UNION ALL
         SELECT 'pinnacle_fmv_pct_stale_30d'::text AS text,
            ( SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE pc.fmv_computed_at < (now() - '30 days'::interval))::numeric / NULLIF(count(*), 0)::numeric, 1), 0::numeric) AS "coalesce"
                   FROM pinnacle_catalog pc
                  WHERE pc.fmv_usd IS NOT NULL) AS "coalesce",
            25::numeric AS "numeric",
            'COVERAGE leg (baseline 0.0% on 2026-07-25): share of priced Pinnacle RENDERS whose latest render-FMV is >30d old (render-keyed on pinnacle_catalog.fmv_computed_at, not fmv_snapshots); complements pinnacle_fmv_stale_hours. Stays INLINE: reads pinnacle_catalog (~2.4k rows), never part of the fmv_snapshots cost'::text AS text
        UNION ALL
         SELECT 'candy_fmv_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(fmv_snapshots.computed_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM fmv_snapshots
                  WHERE fmv_snapshots.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AS "coalesce",
            30::numeric AS "numeric",
            'ALL Candy FMV writers stalled (chain two; reprices continuously, so >30h is a real stall)'::text AS text
        UNION ALL
         SELECT 'candy_offers_unverified_pct'::text AS text,
            ( SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE candy_offers.last_seen_at < (now() - '12:00:00'::interval))::numeric / NULLIF(count(*), 0)::numeric, 1), 999::numeric) AS "coalesce"
                   FROM candy_offers
                  WHERE candy_offers.is_active) AS "coalesce",
            25::numeric AS "numeric",
            'COVERAGE leg for the Candy standing-offer book -- the arm whose absence let the 2026-08-05..08 outage run for three days. Share of is_active candy_offers whose last_seen_at is older than 12h (2x the 6h sweep cadence): bids the PUBLIC candy_offer_spread_board is still quoting that the sweep has not re-confirmed. WHY THIS SHAPE AND NOT A FRESHNESS MAX: a max(last_seen_at) arm was specced first and would have been BLIND -- at 2026-08-08 02:31Z it read 1.67h (green) while 39 of 50 active offers were 3+ days unverified, because the maximum was carried entirely by 4 touched rows out of 186, all is_active = false. A max over a set is not coverage over the set; same defect family as the public_board_slow_count count(*) probe. MEASURED: 78.0% during the outage; 0.0% at the healthy baseline 2026-08-08 03:15:33Z (75 active, oldest 2.3h) after the per-mint DB batching plus serial+150ms throttle fix. breach_at 25 sits ~1/3 of the observed outage value and far above a healthy 0, so one missed tick cannot fire it but a partial sweep that quietly stops re-confirming does. READ WITH THE GUARD IN MIND: the deactivation guard deliberately trades wrongly-empty for wrongly-stale, refusing to retire offers on a degraded sweep, so a sustained upstream failure (e.g. Cloudflare 1015 / HTTP 429 rate limiting, the actual 08-05 cause) surfaces HERE as a rising unverified share, never as a shrinking book. Returns 999 when there are zero active offers, so a vanished book BREACHES rather than dividing to a comfortable zero. INLINE: candy_offers is ~200 rows.'::text AS text
        UNION ALL
         SELECT 'candy_offers_oldest_active_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - min(candy_offers.last_seen_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM candy_offers
                  WHERE candy_offers.is_active) AS "coalesce",
            36::numeric AS "numeric",
            'Companion to candy_offers_unverified_pct: hours since the OLDEST still-active Candy offer was last re-confirmed. A percentage can read acceptable while one high-value standing bid rots -- during the 2026-08-05..08 outage the oldest active bid reached 79.7h. Healthy steady state is bounded by the 6h sweep cadence: measured 2.3h at 2026-08-08 03:16Z immediately after a clean sweep. breach_at 36 = 6 consecutive missed cycles, so an ordinary skipped tick or one slow sweep cannot page, but a stalled sweep surfaces inside a day and a half. Deliberately kept as a SECOND arm rather than folded into the percentage, because the two fail differently: the pct arm catches a broad partial sweep, this one catches a narrow tail the percentage dilutes away. Returns 999 when there are zero active offers. INLINE.'::text AS text
        UNION ALL
         SELECT 'candy_sales_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(sales.sold_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM sales
                  WHERE sales.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AS "coalesce",
            30::numeric AS "numeric",
            'candy-sales-indexer stalled — the ONLY Candy price signal. 7d p95 inter-sale gap 0.91h, avg 0.30h'::text AS text
        UNION ALL
         SELECT 'candy_ask_book_drop_pct'::text AS text,
            ( SELECT COALESCE(round(100.0 * (1.0 - count(*) FILTER (WHERE cl.is_active)::numeric / NULLIF(count(*) FILTER (WHERE cl.last_seen_at > (now() - '24:00:00'::interval)), 0)::numeric), 1), 0::numeric) AS "coalesce"
                   FROM candy_listings cl) AS "coalesce",
            60::numeric AS "numeric",
            'Candy ask book collapsed vs the asks seen in the last 24h. Magic Eden served 7 listings against a 426-ask book on 2026-07-27 and the sweep killed 419 (98%); ordinary churn is <10%'::text AS text
        UNION ALL
         SELECT 'panini_sale_price_capture_dry_days'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'panini_sale_price_capture_dry_days'::text), 999::numeric) AS "coalesce",
            3::numeric AS "numeric",
            'PANINI last_sale_usd CAPTURE HAS COLLAPSED -- real defect, MECHANISM NOT YET ESTABLISHED. Counts the consecutive most-recent CAPTURE DAYS on which v_panini_serial_sale_field_supply saw raw_supplied_sale_price = 0; 7+ and counting since 2026-07-29. WHAT IS MEASURED: brought_at_price is PRESENT as a key on 100% of captured rows and its VALUE is JSON null; by day, 07-26 had zero nulls (829 zero-sentinel, 494 real), 07-27 1,697 null, 07-28 4,252 null, 07-29 onward 100% null. Controlling for parallel family -- because a composition shift was the obvious alternative and had to be killed -- every family present in BOTH eras collapsed about 30x (family 486967: 45.8% to 1.7%), so this is not coverage rotation. WHAT IS RULED OUT, each having been asserted in an earlier version of this very text and then disproved: (a) an UPSTREAM outage -- panini_card_serials.raw is OUR OWN stored copy, an instrument we control, so an empty field cannot distinguish they-stopped-sending from we-stopped-asking; (b) the walk abandoning detail pages before getCardMarketStats fires -- against the FULL 32,615-op capture on the runner box that op fires 2,412 times, HTTP 200, on 787 of 795 pages, and the 0-occurrence reading came from parsing only the freshly rotated tail while the 26 MB .1 file held the rest of the same period; (c) price_usd and best_offer_usd being lost -- their absolute counts ROSE (514-1,366 to 613-2,038 per day) and only the DENOMINATOR tripled when the 2026-07-26 DOM harvest ended listing-gating, so that null-rate rise is the coverage fix working, not damage. Note item_counts = 0 in the ops capture is a NULL INSTRUMENT: findItems counts only o.items, so neither op can ever report non-zero -- never read it as an empty response. WHAT IS UNKNOWN: the mechanism. The leading reading is an all_cards bulk variant returning a lighter per-serial shape, which fits every observation, but BOTH capture generations post-date the 07-27 switch, so there is no pre-switch payload on disk to diff. Settling it needs a live A/B across listType values on the residential runner box -- interactive work, not a code read. DO NOT install another mechanism in this text without that A/B: a monitor that asserts a wrong cause is worse than one that asserts none. PRECOMPUTED at zero added cost in the same pass over v_panini_serial_sale_field_supply that panini_sale_field_mapping_shortfall already pays for; a missing or >24h-old precompute row reports 999 and BREACHES.'::text AS text
        UNION ALL
         SELECT 'panini_sale_field_mapping_shortfall'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'panini_sale_field_mapping_shortfall'::text), 999::numeric) AS "coalesce",
            1::numeric AS "numeric",
            'OUR ingest dropped a Panini serial sale price that upstream DID send (raw.brought_at_price present, last_sale_usd null). This is NOT the upstream outage that began 2026-07-29 -- that one is pct_upstream_supplied in v_panini_serial_sale_field_supply and has a different owner entirely. Reads 0 on every capture day since 2026-07-23, i.e. the mapping is faithful and column_last_sale_usd equals raw_supplied_sale_price exactly; any non-zero value is a regression WE own and can fix. PRECOMPUTED (2026-08-01) because it costs ~605ms inline (seq scan + jsonb over ~49k serials); refreshed 6-hourly by cron rpc-trust-health-precompute-refresh, and a precompute older than 24h reads 999 so a dead refresher breaches rather than going quiet'::text AS text
        UNION ALL
         SELECT 'sales_serial_supply_worst_pct'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'sales_serial_supply_worst_pct'::text), 999::numeric) AS "coalesce",
            5::numeric AS "numeric",
            'a sales writer silently dropping serial_number: the row lands with price, buyer, seller and edition intact but no serial, so serial-level FMV (serial_fmv_estimate), the special-serials board and jersey-match go blind while the indexer keeps reporting ok=true. Worst collection over sales ingested 3-10 days ago (>=200 rows, sold within 30d) -- deliberately NOT the fresh 24h cohort: a NULL serial on a just-ingested row is in-flight work that sales-serial-backfill drains (TopShot 26.7% at 6-24h -> 0.26% at 3-10d), so keying on fresh rows made this arm flap on a healthy system (see audit_20260803_serial_supply_arm_aged_cohort). A genuinely broken writer still sails past 5% in this cohort, ~3d later. Validated on 9 weeks of history: TopShot 0 breach-days in 64, AllDay would have breached 2026-07-16 -- 15 days before the 07-13 regression was found by hand. PRECOMPUTED (~12.4s inline) by cron rpc-trust-health-precompute-refresh; a precompute older than 24h reads 999 so a dead refresher breaches rather than going quiet'::text AS text
        UNION ALL
         SELECT 'panini_fmv_stale_hours'::text AS text,
            ( SELECT COALESCE(round(EXTRACT(epoch FROM now() - max(pfs.computed_at)) / 3600::numeric, 1), 999::numeric) AS "coalesce"
                   FROM panini_fmv_snapshots pfs) AS "coalesce",
            36::numeric AS "numeric",
            'ALL Panini FMV writers stalled -- the most fragile ingest lane on the platform (a residential Windows box on Task Scheduler that SLEEPS) feeding the PUBLIC /insights/panini-squeeze board, which had NO freshness arm at all until now. Measured over the full 1,927-batch history since 2026-07-16: the normal 4h-cadence gap is 3.7-4.0h (p99 3.70h, p50 0.02h within a walk), and the worst sleep EVER observed is 28.30h -- 2 gaps over 24h, ZERO over 30h. breach_at 36 sits ~8h above that all-time worst so an overnight or long-weekend sleep can never page, and is deliberately clear of the separate 09:00 PT panini-freshness-check scheduled task, which fires an hour before the box''s ~10:00 PT wake-up and self-heals. 36h = 9 consecutive 4h ticks missed: a dead runner, not a nap. INLINE (13.6ms) -- a precomputed freshness metric would carry up to 6h of its own staleness'::text AS text
        UNION ALL
         SELECT 'panini_coverage_pct_drop'::text AS text,
            ( SELECT GREATEST(0::numeric, 39.3 - COALESCE(pcs.pct_trustworthy, 0::numeric)) AS "greatest"
                   FROM panini_coverage_summary pcs) AS "greatest",
            15::numeric AS "numeric",
            'the listing-gated COVERAGE figure collapsed. This number is rendered in the mandatory "treat this board as a floor, not a census" disclosure banner on the PUBLIC panini-squeeze surface and in meta.coverage of its public JSON, so a collapse puts a WRONG number in front of users -- a disclosure that understates its own gap is worse than no disclosure. Value = percentage points BELOW the 2026-08-01 calibration of 39.3% trustworthy (1,607 of 4,094 editions in broad-coverage families); reads 0 while coverage holds or improves. breach_at 15 comes from measured CHUNKINESS, not taste: coverage_flag is assigned per (set_name, parallel_family), so a whole family crosses the 10%-listed boundary at once -- Base Prizms Red (472 editions) and Base Prizms Blue (449) are 11.5pp and 11.0pp blocks currently sitting at 6.1% and 8.3% listed, so ONE ordinary listing tick can legitimately move the headline ~11pp. Anything under ~13 would page on market noise; 15 still catches both base families flipping (22.5pp) or a discovery-lane blowout. Re-base the 39.3 constant if coverage structurally improves -- an improvement can only make this read 0, never false-alarm. INLINE (17.4ms)'::text AS text
        UNION ALL
         SELECT 'candy_fmv_pct_stale_30d'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'candy_fmv_pct_stale_30d'::text), 999::numeric) AS "coalesce",
            25::numeric AS "numeric",
            'COVERAGE leg (baseline 0.0% on 2026-08-01): share of priced Candy editions whose LATEST FMV is >30d old -- the parity leg every other collection already had, complementing candy_fmv_stale_hours which reads only the freshest row and so stays green at 0.1h while a repricing backlog builds. Measured latest-FMV age across all 125 editions: p50 0.0h, p95 21.0h, max 42.1h, i.e. the entire catalogue reprices inside 2 days, so 25% (31 editions untouched for a month) can only mean a partial or selective writer stall. Threshold matches the AllDay and Pinnacle coverage legs. PRECOMPUTED (2026-08-01) at ZERO added cost: candy is a sixth lookup against the whole-table DISTINCT ON that legs 2-5 already compute -- STRUCTURALLY UNBREACHABLE at 30d, measured 2026-08-04: the max latest-FMV age across all 125 Candy editions is 0.38d, so a 30d test sits ~79x above the ceiling and cannot fire at any threshold. Treat as a placeholder; the successor cut is >3d. See topshot_fmv_pct_stale_30d for the back-test, and for the timeout-blindness rationale; a missing or >24h-old precompute row reports 999 and BREACHES'::text AS text
        UNION ALL
         SELECT 'pack_ev_publish_shortfall_pct'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'pack_ev_publish_shortfall_pct'::text), 999::numeric) AS "coalesce",
            10::numeric AS "numeric",
            'pack-EV COVERAGE silently regressing -- HOW MANY pack pages carry an EV at all, which pack_ev_board_max_stale_days (freshness) and pack_ev_board_pct_depleted (quality) both structurally miss: both read a board that is already published, so a filter that hides 60% of the catalogue leaves them perfectly green. Value = share of the pack universe (distinct pack_listing_id in pack_ev_history) that pack_ev_latest declines to publish. SELF-MEASURING against its own denominator, so unlike a pinned row count it cannot go stale as the catalogue grows. Baseline 0.76% on 2026-08-01 (35 of 4,631 excluded: 6 "Holding %" rows plus 45 with a known retail price but an unusable pack_price, overlapping); on the SAME DAY before the fix it read 60.8% (1,814 published) because a pack_price > 0 filter was discarding packs whose price was merely UNKNOWN. breach_at 10 is ~13x baseline -- far above any plausible move in the dynamic arms (the TopShot 3x-lowest-ask guard suppresses 0 today and has historically suppressed ~23) yet still 6x more sensitive than the failure that motivated it. An emptied pack_ev_history divides to NULL and reports 999, so a vanished table breaches instead of reading a comfortable 0. PRECOMPUTED: needs a DISTINCT over ~203k history rows'::text AS text
        UNION ALL
         SELECT 'public_board_empty_count'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'public_board_empty_count'::text), 999::numeric) AS "coalesce",
            1::numeric AS "numeric",
            'a PUBLIC /insights board rendering a blank empty-state while its data is fine. This is the class that hid candy_holder_board -- 373 collectors in the view, "Holders 0" on the live board, for DAYS, with zero Sentry and zero alerts -- because the view was slow and the page''s fail-soft caught the timeout and returned []. EVERY /insights board has that shape, so an outage is indistinguishable from an honest empty result and NOTHING watched for it. Counts active rows in public_board_liveness_watchlist whose count(*) fell below min_rows OR threw; an error counts as EMPTY because to the page both render the identical blank board. 45 boards watched, all 45 clean on 2026-08-01; min_rows is 25% of each board''s measured population (a collapse, not churn) and exactly 1 for single-row summary views. breach_at 1 because any single dark public board is a real defect, not a tolerance band. Two genuinely-can-be-empty market boards (candy_deals_board, topshot_underpriced_serials_board) are carried is_active=false WITH a stated reason rather than paging on honest market conditions. Adding a board is an INSERT, not a migration. PRECOMPUTED -- 43.8s warm across 47 views, ~40x this whole view''s budget, so it can never run on a sentinel read'::text AS text
        UNION ALL
         SELECT 'public_board_slow_count'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = 'public_board_slow_count'::text), 999::numeric) AS "coalesce",
            1::numeric AS "numeric",
            'a PUBLIC /insights board drifting toward the read-path wall, BEFORE it starts rendering empty. The candy_holder_board failure was SLOWNESS (82s against the request budget), not emptiness -- count(*) returned 373 the entire time -- so an emptiness-only check would have stayed green straight through it. Counts watchlisted boards whose warm probe exceeded their per-view max_ms, set at 3x measured-warm and CAPPED at 25000: the read path has ~30s, so a 3x budget above that could only fire AFTER the page had already failed, an arm that cannot warn in time. All 45 clean on 2026-08-01. TRUE FINDING carried by this arm from day one: topshot_perfect_mint_premiums_board runs 14.8s warm and topshot_pack_reality_dist 8.4s -- both public, both one contention spike from the same failure, both now capped at 25s so they warn before they break rather than after. PRECOMPUTED alongside public_board_empty_count'::text AS text
        UNION ALL
         SELECT 'fmv_sweep_stall_pct_24h'::text AS metric,
            ( SELECT
                        CASE
                            WHEN count(*) = 0 THEN 999::numeric
                            ELSE round(100.0 * count(*) FILTER (WHERE pr.cursor_before = '0'::text)::numeric / count(*)::numeric, 1)
                        END AS round
                   FROM pipeline_runs pr
                  WHERE pr.pipeline = 'fmv-recalc'::text AND pr.started_at > (now() - '24:00:00'::interval)) AS value,
            50::numeric AS breach_at,
            'the fmv-recalc catalogue sweep silently restarting at page 0 instead of advancing. The route pages editions with a cursor persisted in pipeline_runs.cursor_after and computes hasMore as pageEditionIds.length === limit; PostgREST caps RPC results at db-max-rows=1000, so a 2500-row request returns 1000, hasMore is false, cursor_after is written NULL, and the next run resets to offset 0. Discovered 2026-08-03: every run for 20h logged cursor_before=0 / cursor_after=NULL / rows_written=997, leaving 74pct of the 11602 editions in the 30d sales window never recomputed by the current algo -- including the dust-floor removal, which reached only the most-recently-traded head. Measures the share of fmv-recalc runs in 24h that started at cursor_before=0: a healthy 13-page sweep is about 8pct, a stuck sweep is 100pct. 999 when there are no runs at all, because absence must not read as health. This is the arm that topshot_fmv_stale_hours structurally cannot be (it reads only the freshest row, and a head-pinned sweep writes fresh rows constantly) and that topshot_fmv_pct_stale_30d failed to be (its 2026-07-25 baseline of 32.3pct was captured while the sweep was already stuck, so breach_at was set 18 points above the broken steady state and a permanent plateau produces no trend)'::text AS catches
        )
 SELECT metric,
    value,
    breach_at,
        CASE
            WHEN value >= breach_at THEN 'BREACH'::text
            ELSE 'ok'::text
        END AS status,
    catches
   FROM raw
  ORDER BY (
        CASE
            WHEN value >= breach_at THEN 0
            ELSE 1
        END), metric;

-- Re-assert security_invoker: CREATE OR REPLACE VIEW above wipes reloptions.
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
