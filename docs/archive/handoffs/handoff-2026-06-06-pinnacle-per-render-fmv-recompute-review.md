# Review-gated: Pinnacle per-render FMV recompute (item 2)

## ✅ VERDICT ACCEPTED + PHASE A SHIPPED 2026-06-06 (CC, `a4c6bb5`)

The Cowork review (pasted below in spirit) **approved the pricing logic and amended the ship to additive + waved** — the atomic-cutover premise in the original draft failed on the real reader inventory (~40 readers, not 4). Phase A (the additive engine that breaks zero readers) is now LIVE:

- Migration `audit_20260606_pinnacle_render_fmv_engine_additive`: render-keyed FMV columns on `pinnacle_catalog` (`fmv_usd`/`fmv_wap_usd`/`fmv_confidence`/`fmv_sales_count_7d`/`_30d`/`fmv_days_since_sale`/`fmv_liquidity_rating`/`fmv_computed_at`/`fmv_algo_version`), beside `floor_ask` (reviewer's preferred home — NOT a delete-rebuild of the legacy table).
- `pinnacle_fmv_recalc_render(render_id)` + `pinnacle_fmv_recalc_render_all()` — approved formula, render_id grouping, UPDATE-in-place. **Legacy `pinnacle_fmv_snapshots` + `pinnacle_fmv_recalc_all` UNTOUCHED and still live (427 rows) → zero of the ~40 legacy readers break.**
- Amendment 2 (grants): both new fns service_role-only; also closed the stray PUBLIC/anon/authenticated EXECUTE on the existing `pinnacle_fmv_recalc`. Amendment 3: success-path `log_pipeline_run('pinnacle-fmv-recalc')` only.
- `pinnacle-sync` route runs the new recompute alongside the legacy so both stay fresh through the transition.
- **Verified live:** 1,789 renders priced / 14 NO_DATA; the formerly-blended `STAR-OEV1-SWHM:Digital Display:1` now prices Kylo Ren Helmet **$277.67** vs set-mates **$23–33**; pipeline log persists ok=true.
- **Revert (trivial, additive):** point any migrated reader back to `pinnacle_fmv_snapshots`; the legacy writer/table never moved. To remove the engine entirely: `DROP FUNCTION pinnacle_fmv_recalc_render_all(), pinnacle_fmv_recalc_render(text); ALTER TABLE pinnacle_catalog DROP COLUMN fmv_usd, fmv_wap_usd, fmv_confidence, fmv_sales_count_7d, fmv_sales_count_30d, fmv_days_since_sale, fmv_liquidity_rating, fmv_computed_at, fmv_algo_version;` + drop the render recalc call from `pinnacle-sync`.

### Remaining: reader cutover in waves (queued PIN-FMV-REKEY-WAVES — Trevor sequences/verifies live)

Migrate readers from `pinnacle_fmv_snapshots` (set-level `edition_id`) to `pinnacle_catalog.fmv_*` (`render_id`). **Caveat:** readers keyed by the legacy set-level `edition_id` can't 1:1 map to render_id (one edition_id = many renders) — those surfaces become per-render/per-pin, a product decision per surface (show a range? per-pin page?). Render_id-available surfaces (wmc-based, moment-by-nft, scarcity board) migrate cleanly.

- **Wave 1 (user-facing value, render_id clean):** `populate_pinnacle_wmc_fmv` (join `wmc.render_id` → `pinnacle_catalog.fmv_usd` — cleanest, fixes portfolio per-pin pricing), `app/pinnacle/moment/[id]/page.tsx`, `pinnacle_scarcity_board` view, `get_pinnacle_edition_fmv`.
- **Wave 2 (entity/team/cross-collection):** `get_pinnacle_moment_detail`, `get_edition_detail`, `get_moment_detail`, `moment_detail`, team hub (`get_team_detail`/`_checklist`/`_checklist_progress`/`_players`/`_top_editions`), `get_set/player/series_detail` + `_editions`, `get_cross_collection_deals`/`_portfolio`, `get_pinnacle_overview`, `get_pinnacle_top_movers`, `get_wallet_moments_with_fmv`, `holdings_summary`, `get_edition_fmv_history`, `pinnacle_fmv_from_listings`/`_from_sales`, `bridge_pinnacle_fmv_to_main`.
- **Wave 3 (stats/health/analytics + routes):** `health_check`/`pinnacle_health_check`/`analytics_*` (3), views `data_coverage_dashboard`/`data_quality`/`pipeline_health`; routes `app/api/collection-stats` (does the exact `DISTINCT ON (edition_id) FROM pinnacle_fmv_snapshots` pattern), `app/api/overview-stats`, `app/api/sniper-feed`, `app/api/pinnacle-listings-indexer`.
- **Retire** the legacy `pinnacle-1.0.0` writer + `pinnacle_fmv_snapshots` (and follow `bridge_pinnacle_fmv_to_main`) only when the reader grep hits zero.
- After 48h cadence, add `pinnacle-fmv-recalc` to `pipeline_cadence_watchlist`.

---

**ORIGINAL DRAFT BELOW (historical — the atomic-cutover plan it describes was superseded by the additive/waved verdict above; the formula + evidence are unchanged and correct).**

**STATUS: PREPARED, NOT SHIPPED. This is central pricing logic — review + soak gates apply; explicitly NOT for autonomous/night-pass shipping (per the handoff guardrail). Trevor reviews and applies the recompute swap + reader cutover.**

This documents the one remaining piece of the Pinnacle per-render re-key. Items 1 (sales render_id drain — DONE, 13,152/13,152) and 3 (per-render floor ask — DONE, 1,946 floors) shipped this session. Item 2 changes the prices users see, so it stops here for review.

## What's already in place (safe, shipped)

- `pinnacle_sales.render_id` — 100% populated (drain + ongoing cron).
- `pinnacle_catalog` — render_id-keyed catalog (2,079 editions) + per-render `floor_ask` (1,946 live floors).
- `pinnacle_fmv_snapshots.render_id` — **inert column added** (`audit_20260606_pinnacle_fmv_snapshots_render_id_column`) + index. Nothing writes/reads it yet; the live writer still keys by `edition_id`. This makes the ship a function swap, not a schema migration. Revert: `ALTER TABLE public.pinnacle_fmv_snapshots DROP COLUMN render_id;`.

## Why (validated read-only this session, not theoretical)

Today `pinnacle_fmv_recalc_all` groups sales by the **set-level** legacy `edition_id`, so one FMV is blended across all shapes sharing it. Measured spread inside a SINGLE legacy key `STAR-OEV1-SWHM:Digital Display:1` (Star Wars helmets, last 90d, per render_id):

| render_id | character | sales | avg |
|---|---|---|---|
| OEV1-SWHM-KYLO-S5 | Kylo Ren Helmet | 23 | **$278.30** |
| OEV1-SWHM-BOUS-S5 | Boushh (Leia) | 33 | $32.39 |
| OEV1-SWHM-DART-S5 | Darth Vader | 51 | $27.31 |
| … | … | … | … |
| OEV1-SWHM-ROYA-S5 | Royal Guard | 35 | $17.06 |

A ~16x spread collapsed into one number. The blended FMV is wrong for every shape in the key. Per-render WAP fixes it. (86% of all Pinnacle sales sit on multi-render legacy keys.)

## Proposed recompute (review before applying)

Two functions. The new per-render fn is `pinnacle_fmv_recalc` with the filter changed from `edition_id` to `render_id`; `pinnacle_fmv_recalc_all` loops DISTINCT render_id, writes `render_id` (and keeps a representative `edition_id` for reference), populates `floor_usd` from the new `pinnacle_catalog.floor_ask`, and **logs pipeline_runs** (closing the freshness blind spot that hid PIN-FMV2).

```sql
-- 1) per-render WAP (mirror of pinnacle_fmv_recalc, keyed on render_id)
CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc_render(p_render_id text)
RETURNS json LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $fn$
DECLARE v_wap numeric; v_wap_no numeric; v_s7 int; v_s30 int; v_days int; v_conf text; v_liq int; v_floor numeric;
BEGIN
  SELECT ROUND(SUM(sale_price_usd*weight)/NULLIF(SUM(weight),0),4),
         COUNT(*) FILTER (WHERE sold_at > NOW()-interval '7 days'),
         COUNT(*) FILTER (WHERE sold_at > NOW()-interval '30 days'),
         EXTRACT(DAY FROM NOW()-MAX(sold_at))::int
    INTO v_wap, v_s7, v_s30, v_days
  FROM (SELECT sale_price_usd, sold_at, EXP(-0.03*EXTRACT(DAY FROM NOW()-sold_at)) weight
        FROM pinnacle_sales WHERE render_id = p_render_id AND sold_at > NOW()-interval '90 days' AND sale_price_usd > 0) w;
  IF v_wap IS NOT NULL AND v_wap > 0 THEN
    SELECT ROUND(SUM(sale_price_usd*weight)/NULLIF(SUM(weight),0),4) INTO v_wap_no
    FROM (SELECT sale_price_usd, EXP(-0.03*EXTRACT(DAY FROM NOW()-sold_at)) weight
          FROM pinnacle_sales WHERE render_id=p_render_id AND sold_at>NOW()-interval '90 days'
            AND sale_price_usd>0 AND sale_price_usd BETWEEN v_wap*0.33 AND v_wap*3.0) f;
  END IF;
  v_conf := CASE WHEN v_s30>=5 AND v_days<=14 THEN 'HIGH' WHEN v_s30>=2 AND v_days<=30 THEN 'MEDIUM'
                 WHEN v_s30>=1 THEN 'LOW' ELSE 'NO_DATA' END;
  v_liq := CASE WHEN v_s30>=20 THEN 5 WHEN v_s30>=10 THEN 4 WHEN v_s30>=5 THEN 3
                WHEN v_s30>=2 THEN 2 WHEN v_s30>=1 THEN 1 ELSE 0 END;
  SELECT floor_ask INTO v_floor FROM pinnacle_catalog WHERE render_id = p_render_id;
  RETURN json_build_object('render_id',p_render_id,'fmv_usd',COALESCE(v_wap_no,v_wap),'wap_usd',v_wap,
    'wap_without_outliers',v_wap_no,'confidence',v_conf,'liquidity_rating',v_liq,
    'sales_count_7d',COALESCE(v_s7,0),'sales_count_30d',COALESCE(v_s30,0),'days_since_sale',v_days,
    'floor_usd',v_floor,'computed_at',NOW());
END; $fn$;

-- 2) rebuild keyed by render_id (CUT readers over in the SAME ship — see ordering).
--    Writes render_id + a representative edition_id (the legacy set key, for reference),
--    + floor_usd, + LOGS pipeline_runs. algo bumped to 'pinnacle-2.0.0-render'.
CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc_all()
RETURNS json LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $fn$
DECLARE v_count int:=0; v_skipped int:=0; r record; v json; v_started timestamptz:=clock_timestamp();
BEGIN
  DELETE FROM pinnacle_fmv_snapshots WHERE true;
  FOR r IN
    SELECT DISTINCT s.render_id, (array_agg(s.edition_id) FILTER (WHERE s.edition_id IS NOT NULL))[1] AS edition_id
    FROM pinnacle_sales s WHERE s.render_id IS NOT NULL GROUP BY s.render_id
  LOOP
    v := pinnacle_fmv_recalc_render(r.render_id);
    IF v IS NULL OR (v->>'fmv_usd') IS NULL THEN v_skipped:=v_skipped+1; CONTINUE; END IF;
    INSERT INTO pinnacle_fmv_snapshots
      (render_id, edition_id, fmv_usd, wap_usd, wap_without_outliers, floor_usd, confidence,
       liquidity_rating, sales_count_7d, sales_count_30d, days_since_sale, algo_version, computed_at)
    VALUES (r.render_id, r.edition_id, (v->>'fmv_usd')::numeric, (v->>'wap_usd')::numeric,
       (v->>'wap_without_outliers')::numeric, (v->>'floor_usd')::numeric, (v->>'confidence')::fmv_confidence,
       (v->>'liquidity_rating')::int, (v->>'sales_count_7d')::int, (v->>'sales_count_30d')::int,
       (v->>'days_since_sale')::int, 'pinnacle-2.0.0-render', NOW());
    v_count:=v_count+1;
  END LOOP;
  PERFORM log_pipeline_run('pinnacle-fmv-recalc', v_started, v_count+v_skipped, v_count, v_skipped,
    true, NULL, 'disney_pinnacle', NULL, NULL,
    json_build_object('editions_processed',v_count,'editions_skipped_no_data',v_skipped)::jsonb);
  RETURN json_build_object('editions_processed',v_count,'editions_skipped_no_data',v_skipped,'computed_at',NOW());
EXCEPTION WHEN OTHERS THEN
  PERFORM log_pipeline_run('pinnacle-fmv-recalc', v_started, 0, 0, 0, false, SQLERRM,
    'disney_pinnacle', NULL, NULL, NULL);
  RAISE;
END; $fn$;
```

(Verify `log_pipeline_run`'s exact arg signature against a working caller before applying — adapt the PERFORM if it differs.)

## CRITICAL transition risk

After the swap, `pinnacle_fmv_snapshots` has ONE ROW PER RENDER, all carrying the legacy `edition_id`. Any reader that still does `DISTINCT ON (edition_id) ... ORDER BY computed_at DESC` will pick an ARBITRARY render's price for the whole set — silently wrong. So the writer swap and the reader cutover must ship TOGETHER (atomic), not gradually. Readers to cut to render_id join in the same deploy:

- `populate_pinnacle_wmc_fmv` — join wmc.render_id → snapshot.render_id (wmc already has render_id; this is the cleanest join now).
- `get_pinnacle_edition_fmv` — re-key to render_id.
- Scarcity board + the deferred per-pin page (render_id is the page key).
- Concierge `get_fmv` Pinnacle path (CLAUDE.md concierge rule #1): the triple-match `(character_name, set_name, variant_type)` join becomes a single render_id join — simpler AND safer. Update the rule text after.

## Expected after ship (honest)

- ~360+ render-keyed snapshots that actually trade (vs 428 legacy keys today); confidence on thin renders will DROP (12-way splits = smaller samples). That's correct — the blend was overstating confidence. Do NOT loosen the gates to compensate.
- Kylo Ren Golden ~$3.8, its set-mates ~$1.3–2.3; the Digital Display Kylo ~$278 separates from its $17–32 set-mates.
- `floor_usd` populated per render → unlocks the FMV-vs-floor UI surfacing (item 3's deferred half): where FMV >> floor (>1.3x) on thin editions, show the floor alongside FMV.

## Ship checklist

1. Apply both functions in one migration. 2. Run `SELECT pinnacle_fmv_recalc_all();` — confirm editions_processed ~360+, pipeline_runs row written. 3. Deploy the reader cutover in the same window. 4. Spot-check: Kylo renders, Spinning Wheel, a held wmc pin's fmv_usd re-populates per pin. 5. After 48h cadence, add `pinnacle-fmv-recalc` to `pipeline_cadence_watchlist`. **Revert:** re-CREATE the two prior function bodies (captured below) + redeploy prior readers.

Prior bodies for revert are in this session's transcript (pg_get_functiondef of `pinnacle_fmv_recalc` and `pinnacle_fmv_recalc_all`, both algo `pinnacle-1.0.0`, edition_id-keyed).
