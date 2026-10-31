-- audit_20261030_allday_scarcity_board_exposes_edition_id
--
-- 2026-10-30 (PT, Claude Code cloud, session_014vX7Q7qM7twrBUY9w4M9yP) — #215. The All Day scarcity
-- board marks every ASK_ONLY price "from asks", including the _salescap / _histcap prices that are held
-- to the edition's SALES. Its FMV comes from edition_fmv_current, which has no algo_version, so the
-- board's reader (lib/insights/allday-scarcity-board.ts) resolves the capped flag per ASK_ONLY row via
-- get_editions_latest_fmv_wide — which is keyed on the edition UUID this view did not expose.
--
-- Change: append `e.id AS edition_id` as the LAST column (CREATE OR REPLACE VIEW can only append).
-- Body otherwise verbatim from pg_get_viewdef at 2026-10-30. security_invoker=on restated (a replace
-- resets reloptions).
--
-- REVERT: re-run this statement without the final `e.id AS edition_id` line — not possible with
-- CREATE OR REPLACE (a column cannot be dropped that way); DROP VIEW + CREATE from
-- 20260624020523/the 09-02 body, then re-GRANT. The extra column is harmless to every reader (they
-- select named columns), so leaving it is the practical revert.

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.allday_scarcity_board'::regclass)) <> '95fa1898df022ba7e82edad252dd3ebe' THEN
    RAISE EXCEPTION 'allday_scarcity_board changed since it was read (2026-10-30); re-read before replacing';
  END IF;
END
$guard$;

CREATE OR REPLACE VIEW public.allday_scarcity_board WITH (security_invoker = on) AS
 WITH family_avg AS (
         SELECT editions.set_name,
            editions.tier,
            avg(editions.circulation_count) AS family_avg_mint,
            count(*) AS family_size
           FROM editions
          WHERE ((editions.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) AND (editions.circulation_count IS NOT NULL) AND (editions.circulation_count > 0) AND (editions.set_name IS NOT NULL))
          GROUP BY editions.set_name, editions.tier
        ), latest_fmv AS (
         SELECT efc.edition_id,
            (efc.fmv_usd)::numeric(12,4) AS fmv_usd,
            efc.confidence
           FROM edition_fmv_current efc
          WHERE (efc.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid)
        )
 SELECT e.external_id,
    e.player_name,
    e.set_name,
    (e.tier)::text AS tier,
    e.team_name,
    e.series,
    e.circulation_count AS mint_count,
    round(fa.family_avg_mint, 0) AS family_avg_mint,
    fa.family_size,
    round((100.0 * ((1)::numeric - ((e.circulation_count)::numeric / NULLIF(fa.family_avg_mint, (0)::numeric)))), 1) AS scarcity_vs_family_pct,
    latest.fmv_usd,
    (latest.confidence)::text AS fmv_confidence,
    e.thumbnail_url,
    e.video_url,
    e.id AS edition_id
   FROM ((editions e
     JOIN family_avg fa ON (((fa.set_name = e.set_name) AND (NOT (fa.tier IS DISTINCT FROM e.tier)))))
     LEFT JOIN latest_fmv latest ON ((latest.edition_id = e.id)))
  WHERE ((e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) AND (e.circulation_count IS NOT NULL) AND (e.circulation_count > 0) AND (e.set_name IS NOT NULL));
