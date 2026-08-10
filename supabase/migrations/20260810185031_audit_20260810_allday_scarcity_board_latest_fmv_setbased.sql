-- allday_scarcity_board: replace the per-edition LATERAL latest-FMV lookup with a
-- single set-based DISTINCT ON pass.
--
-- Applied live 2026-08-10 via Supabase MCP as migration 20260810185031; this file is
-- the repo-parity copy.
--
-- WHY: the LATERAL ran `ORDER BY computed_at DESC LIMIT 1` once PER EDITION, i.e.
-- 6,190 random probes into partitioned fmv_snapshots (~5.2 ms each, ~2,950 heap
-- fetches). Measured live 2026-08-10 by EXPLAIN ANALYZE: 32,809 ms cold /
-- 38,574 ms warm against the board's 8,300 ms liveness budget -- the arm
-- public_board_slow_count was reporting a TRUE positive, not a stale artifact.
--
-- The rewrite rides the existing covering index
-- fmv_snapshots_<year>_collection_id_edition_id_computed_at_idx, so the partitions
-- come back already ordered (Merge Append -> Unique, no sort).
-- Measured after: 15,172 ms selecting the FMV columns (~2.4x faster).
--
-- ⚠ STILL OVER BUDGET (15.2s vs 8.3s). This is a partial fix; the remaining cost is
-- scanning 337,452 AllDay snapshot rows to pick 6,190 latest. The durable fix is the
-- standing materialize-latest-FMV-per-edition item, not further view surgery.
--
-- ⚠ SIDE EFFECT ON THE LIVENESS PROBE -- READ BEFORE TRUSTING THIS BOARD'S ARM.
-- public_board_liveness_probe times `SELECT count(*) FROM <view>`. Under the old
-- LATERAL that could not be pruned, so count(*) genuinely measured the FMV work.
-- DISTINCT ON proves edition_id unique, so PG now REMOVES the LEFT JOIN entirely for
-- count(*): the probe measures 2,377 ms while the real page pays 15,172 ms. The arm
-- will therefore read GREEN for a board that is still ~183% of budget. This is the
-- already-documented "the probe times count(*), which the planner prunes" caveat,
-- newly load-bearing here. Queued: make the probe measure representatively.
--
-- OUTPUT-IDENTICAL, verified BEFORE applying: EXCEPT diff in BOTH directions over all
-- 6,190 AllDay editions returned 0 rows, and 0 editions have a tie at
-- max(computed_at), so neither form is order-dependent. Post-apply: 6,190 rows,
-- 5,210 with fmv_usd.
--
-- ASSUMPTION (held by the diff above): an edition's fmv_snapshots rows carry that
-- edition's own collection_id. The old LATERAL keyed on edition_id alone; this keys
-- on (collection_id, edition_id). If a writer ever mis-keys collection_id, this view
-- would drop that edition's FMV to NULL rather than show a wrong number.
--
-- No math change, no column/type/order change, no grant change. security_invoker
-- re-asserted explicitly.
--
-- REVERT: re-apply the LEFT JOIN LATERAL form from
-- supabase/migrations/20260623175341_allday_scarcity_board_view.sql.
CREATE OR REPLACE VIEW public.allday_scarcity_board
WITH (security_invoker = on) AS
WITH family_avg AS (
  SELECT set_name, tier,
         avg(circulation_count) AS family_avg_mint,
         count(*) AS family_size
  FROM public.editions
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    AND circulation_count IS NOT NULL AND circulation_count > 0
    AND set_name IS NOT NULL
  GROUP BY set_name, tier
),
latest_fmv AS (
  SELECT DISTINCT ON (fs.edition_id)
         fs.edition_id, fs.fmv_usd, fs.confidence
  FROM public.fmv_snapshots fs
  WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  ORDER BY fs.edition_id, fs.computed_at DESC
)
SELECT
  e.external_id,
  e.player_name,
  e.set_name,
  e.tier::text AS tier,
  e.team_name,
  e.series,
  e.circulation_count AS mint_count,
  round(fa.family_avg_mint, 0) AS family_avg_mint,
  fa.family_size,
  round(100.0 * (1::numeric - e.circulation_count::numeric / NULLIF(fa.family_avg_mint, 0::numeric)), 1) AS scarcity_vs_family_pct,
  latest.fmv_usd,
  latest.confidence::text AS fmv_confidence,
  e.thumbnail_url,
  e.video_url
FROM public.editions e
JOIN family_avg fa ON fa.set_name = e.set_name AND NOT fa.tier IS DISTINCT FROM e.tier
LEFT JOIN latest_fmv latest ON latest.edition_id = e.id
WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND e.circulation_count IS NOT NULL AND e.circulation_count > 0
  AND e.set_name IS NOT NULL;
