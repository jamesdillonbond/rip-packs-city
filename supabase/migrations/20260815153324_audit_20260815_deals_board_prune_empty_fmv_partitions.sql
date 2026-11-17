-- Prune the EMPTY fmv_snapshots partitions from the deals board's two correlated
-- per-row FMV lookups.
--
-- MEASURED 2026-08-15. `topshot_deals_vs_fmv` runs its LATERAL 6,246 times and
-- `fmv_snapshots_2027` -- which holds ZERO rows and zero bytes -- is probed on every
-- one of them at 2 buffers per probe: 12,492 buffers, 30% of the query's entire
-- buffer traffic, for nothing. The AllDay arm of cross_collection_deals_board does
-- the same 2,229 times (4,458 buffers, 18.6%).
--
-- `computed_at <= now()` hands the planner the partition key so it prunes at RUNTIME
-- (EXPLAIN shows `Subplans Removed: 1`). Semantically a NO-OP: a snapshot cannot be
-- computed in the future, and verified live at apply time -- 0 future-dated rows,
-- fmv_snapshots_2025 and _2027 both empty. When 2027 begins it simply stops pruning,
-- so it DEGRADES, it never breaks. Same change already shipped for
-- get_pack_detail_bundle (9,131 -> 6,308 buffers).
--
-- RESULT, verified after apply: output byte-identical (md5 5c1d65ba581f8544a8647a85477b6766,
-- 18 rows, unchanged), buffers 41,044 -> 28,566 (-30.4%), `Subplans Removed: 1` present.
-- ⚠ It is an IMPROVEMENT, NOT A FIX: the query still measures ~30.5 s against
-- service_role's 30 s statement_timeout under load, because the remaining cost is
-- 6,246 correlated index probes into fmv_snapshots_2026 at ~4.8 ms each, IO-bound on
-- a 2 GB instance. The `deals` warm will still fail some ticks.
--
-- ⚠ THE SET-BASED REWRITE WAS TESTED AND IS WORSE: replacing the LATERAL with a
-- `DISTINCT ON (edition_id)` CTE over the Top Shot partition TIMED OUT at 60 s. The
-- correlated probe is the right shape here; do not "fix" it that way.
--
-- WHY IT MATTERS: topshot_deals_vs_fmv measured 42,333 ms before this, past the 30 s
-- statement_timeout -- which is why the `deals` board fails 59.5% of warm-cron ticks
-- and has gone up to 2h50m unrefreshed while users are served a stale snapshot.
--
-- Both views are replaced in ONE migration on purpose: every apply_migration costs a
-- ~10-20 s burst of user-facing PGRST002 500s, so two windows would cost two bursts.
--
-- REVERT: re-run this file with the two `AND fs.computed_at <= now()` lines removed.
-- No data is touched; these are view definitions only.

CREATE OR REPLACE VIEW public.topshot_deals_vs_fmv AS
 SELECT e.external_id,
    e.name,
    e.player_name,
    e.set_name,
    e.tier,
    e.circulation_count,
    lf.fmv_usd,
    lf.confidence,
    eo.low_ask,
    round((lf.fmv_usd - eo.low_ask) / lf.fmv_usd * 100::numeric, 1) AS discount_pct,
    round(lf.fmv_usd - eo.low_ask, 2) AS discount_usd,
    eo.updated_at AS ask_updated_at,
    eo.low_ask_serial,
    eo.low_ask_nft_id,
    tf.edition_id IS NOT NULL AS low_confidence_fmv
   FROM edition_offers eo
     JOIN editions e ON e.external_id::text = eo.external_id AND e.collection_id = eo.collection_id
     JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence
           FROM fmv_snapshots fs
          WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND fs.edition_id = e.id AND fs.computed_at <= now()
          ORDER BY fs.computed_at DESC
         LIMIT 1) lf ON true
     LEFT JOIN topshot_thin_fmv_editions tf ON tf.edition_id = e.id
  WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND eo.low_ask >= 5::numeric AND (lf.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])) AND lf.fmv_usd > 0::numeric AND eo.low_ask < lf.fmv_usd AND NOT (EXISTS ( SELECT 1
           FROM topshot_conflated_editions c
          WHERE c.edition_id = e.id))
  ORDER BY (round((lf.fmv_usd - eo.low_ask) / lf.fmv_usd * 100::numeric, 1)) DESC;

CREATE OR REPLACE VIEW public.cross_collection_deals_board AS
 SELECT t.external_id,
    t.name,
    t.player_name,
    t.set_name,
    t.tier::text AS tier,
    t.circulation_count,
    t.fmv_usd,
    t.confidence::text AS confidence,
    t.low_ask,
    t.discount_pct,
    t.discount_usd,
    t.ask_updated_at,
    'nba_top_shot'::text AS collection_slug,
    'NBA Top Shot'::text AS collection_name,
    NULL::text AS render_id,
    '/nba-top-shot/edition/'::text || replace(t.external_id::text, ':'::text, '%3A'::text) AS detail_url,
    NULL::text AS thumbnail_url,
    t.low_ask_serial,
    t.low_ask_nft_id,
    t.low_confidence_fmv
   FROM topshot_deals_vs_fmv t
UNION ALL
 SELECT pc.render_id AS external_id,
    (pc.character_name || ' — '::text) || pc.set_name AS name,
    pc.character_name AS player_name,
    pc.set_name,
    pc.variant AS tier,
    pc.total_minted AS circulation_count,
    pc.fmv_usd,
    pc.fmv_confidence::text AS confidence,
    pc.floor_ask AS low_ask,
    round((pc.fmv_usd - pc.floor_ask) / pc.fmv_usd * 100::numeric, 1) AS discount_pct,
    round(pc.fmv_usd - pc.floor_ask, 2) AS discount_usd,
    pc.floor_ask_updated_at AS ask_updated_at,
    'disney_pinnacle'::text AS collection_slug,
    'Disney Pinnacle'::text AS collection_name,
    pc.render_id,
    '/pinnacle/moment/'::text || pc.render_id AS detail_url,
    '/api/public/pinnacle-image/'::text || pc.render_id AS thumbnail_url,
    NULL::integer AS low_ask_serial,
    NULL::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM pinnacle_catalog pc
  WHERE pc.fmv_usd > 0::numeric AND pc.floor_ask >= 1::numeric AND (pc.fmv_confidence::text = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text])) AND pc.fmv_sales_count_30d >= 8 AND pc.floor_ask_updated_at > (now() - '3 days'::interval) AND pc.floor_ask < pc.fmv_usd
UNION ALL
 SELECT e.external_id,
    e.name,
    e.player_name,
    e.set_name,
    e.tier::text AS tier,
    e.circulation_count,
    f.fmv_usd,
    f.confidence::text AS confidence,
    af.floor_ask AS low_ask,
    round((f.fmv_usd - af.floor_ask) / f.fmv_usd * 100::numeric, 1) AS discount_pct,
    round(f.fmv_usd - af.floor_ask, 2) AS discount_usd,
    af.floor_ask_listed_at AS ask_updated_at,
    'nfl_all_day'::text AS collection_slug,
    'NFL All Day'::text AS collection_name,
    NULL::text AS render_id,
    '/nfl-all-day/edition/'::text || replace(e.external_id::text, ':'::text, '%3A'::text) AS detail_url,
    e.thumbnail_url,
    s.serial_number AS low_ask_serial,
    af.floor_flow_id::text AS low_ask_nft_id,
    false AS low_confidence_fmv
   FROM allday_edition_floor_ask af
     JOIN editions e ON e.id = af.edition_id AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
     JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence
           FROM fmv_snapshots fs
          WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND fs.edition_id = e.id AND fs.computed_at <= now()
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON true
     LEFT JOIN allday_moment_serials s ON s.nft_id = af.floor_flow_id::text
  WHERE f.fmv_usd > 0::numeric AND (f.confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])) AND af.floor_ask >= 1::numeric AND af.floor_ask < f.fmv_usd;
