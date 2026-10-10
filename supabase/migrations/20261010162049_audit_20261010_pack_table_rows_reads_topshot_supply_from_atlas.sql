-- audit_20261010_pack_table_rows_reads_topshot_supply_from_atlas
-- definer-view: intentional — pack_table_rows was already a definer view (reloptions NULL) and is listed in
--   security_definer_view_allowlist; CREATE OR REPLACE keeps that unchanged (read back 10-10).
--
-- 2026-10-10 (known-issues #74). Top Shot's pack supply (opened / sealed / depletion) on the pack table
-- came from `pack_distributions` + `topshot_pack_supply`, frozen since ~08-28 when
-- public-api.nbatopshot.com went dark (530; its cron job was deactivated 10-09). The Atlas pack-supply
-- lane refreshes `topshot_atlas_dists` every minute: `total_pack_count` = the print run (equal to the
-- stored mint on every row that has one) and `unopened_count` = sealed. Measured 10-10: 1,416 Top Shot
-- dists with a fresh Atlas summary, 491 of them stale by more than 5 % of the run (dist 8609 read 0
-- opened against Atlas 955 and 949 observed opens; 8643 read 0 against 5,818).
--
-- WHAT. For a Top Shot dist whose Atlas summary is ≤ 48 h old, with a positive total, unopened within
-- [0, total] and a stored mint that is unknown (0) or equal to Atlas's total: opened = total −
-- unopened, sealed = unopened, depletion = round(100·opened/total), and supply_as_of /
-- depletion_as_of = the Atlas fetch time; a missing mint count is filled from Atlas. When our own
-- observed opens (pack_supply_counter_checks) EXCEED Atlas's opened figure (53 dists), opened and
-- sealed are NULL (unknown) — never either side's number. Every other collection and every Top Shot
-- dist without a fresh Atlas row is unchanged. Dry-run against a temp view: 900 Top Shot rows refreshed,
-- 0 rows of any other collection changed.
-- Applied as an anchored rewrite of the LIVE definition (each anchor must match exactly once);
-- CREATE OR REPLACE VIEW keeps the column list, types and grants (it fails if any changed).
--
-- REVERT: re-apply the previous definition (20260926050031_pack_supply_counters_refuted_by_observed_opens.sql).

DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_n int;
  a1_old constant text := $x$    pd.total_minted,
        CASE
            WHEN ref.pd_bad THEN NULL::integer
            ELSE pd.total_opened
        END AS total_opened,
        CASE
            WHEN ref.pd_bad THEN NULL::integer
            ELSE pd.total_sealed
        END AS total_sealed,
    COALESCE(
        CASE
            WHEN ref.pd_bad THEN NULL::smallint
            ELSE NULLIF(pd.depletion_pct, 0::smallint)
        END,$x$;
  a1_new constant text := $x$        CASE
            WHEN atl.ok AND COALESCE(pd.total_minted, 0) = 0 THEN atl.total::integer
            ELSE pd.total_minted
        END AS total_minted,
        CASE
            WHEN atl.ok THEN
            CASE
                WHEN atl.contradicted THEN NULL::integer
                ELSE atl.opened::integer
            END
            WHEN ref.pd_bad THEN NULL::integer
            ELSE pd.total_opened
        END AS total_opened,
        CASE
            WHEN atl.ok THEN
            CASE
                WHEN atl.contradicted THEN NULL::integer
                ELSE atl.unopened::integer
            END
            WHEN ref.pd_bad THEN NULL::integer
            ELSE pd.total_sealed
        END AS total_sealed,
    COALESCE(
        CASE
            WHEN atl.ok AND NOT atl.contradicted THEN round(100.0 * atl.opened::numeric / atl.total::numeric)::smallint
            WHEN atl.ok THEN NULL::smallint
            WHEN ref.pd_bad THEN NULL::smallint
            ELSE NULLIF(pd.depletion_pct, 0::smallint)
        END,$x$;
  a2_old constant text := $x$            WHEN pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN tss.last_success_at
            WHEN pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN ads.opened_updated_at
            ELSE NULL::timestamp with time zone
        END AS supply_as_of,$x$;
  a2_new constant text := $x$            WHEN atl.ok THEN atl.fetched_at
            WHEN pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN tss.last_success_at
            WHEN pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN ads.opened_updated_at
            ELSE NULL::timestamp with time zone
        END AS supply_as_of,$x$;
  a3_old constant text := $x$            WHEN NULLIF(pd.depletion_pct, 0::smallint) IS NOT NULL AND NOT ref.pd_bad THEN$x$;
  a3_new constant text := $x$            WHEN atl.ok AND NOT atl.contradicted THEN atl.fetched_at
            WHEN NULLIF(pd.depletion_pct, 0::smallint) IS NOT NULL AND NOT ref.pd_bad THEN$x$;
  a4_old constant text := $x$     LEFT JOIN pack_supply_counter_checks chk ON chk.collection_id = pd.collection_id AND chk.dist_id = pd.dist_id
$x$;
  a4_new constant text := $x$     LEFT JOIN pack_supply_counter_checks chk ON chk.collection_id = pd.collection_id AND chk.dist_id = pd.dist_id
     LEFT JOIN LATERAL ( SELECT ta.summary_fetched_at AS fetched_at,
            ta.total_pack_count AS total,
            ta.unopened_count AS unopened,
            ta.total_pack_count - ta.unopened_count AS opened,
            COALESCE(chk.observed_opened, 0) > (ta.total_pack_count - ta.unopened_count) AS contradicted
           FROM topshot_atlas_dists ta
          WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND ta.dist_id = pd.dist_id AND ta.summary_fetched_at > (now() - '48:00:00'::interval) AND ta.total_pack_count > 0 AND ta.unopened_count >= 0 AND ta.unopened_count <= ta.total_pack_count AND (COALESCE(pd.total_minted, 0) = 0 OR pd.total_minted = ta.total_pack_count)) atl0 ON true
     LEFT JOIN LATERAL ( SELECT atl0.fetched_at IS NOT NULL AS ok,
            COALESCE(atl0.contradicted, false) AS contradicted,
            atl0.fetched_at,
            atl0.total,
            atl0.unopened,
            atl0.opened) atl ON true
$x$;
BEGIN
  v_def := pg_get_viewdef('public.pack_table_rows'::regclass, true);
  v_new := v_def;
  IF (length(v_new) - length(replace(v_new, a1_old, ''))) / length(a1_old) <> 1 THEN RAISE EXCEPTION 'anchor a1 not unique'; END IF;
  v_new := replace(v_new, a1_old, a1_new);
  IF (length(v_new) - length(replace(v_new, a2_old, ''))) / length(a2_old) <> 1 THEN RAISE EXCEPTION 'anchor a2 not unique'; END IF;
  v_new := replace(v_new, a2_old, a2_new);
  IF (length(v_new) - length(replace(v_new, a3_old, ''))) / length(a3_old) <> 1 THEN RAISE EXCEPTION 'anchor a3 not unique'; END IF;
  v_new := replace(v_new, a3_old, a3_new);
  IF (length(v_new) - length(replace(v_new, a4_old, ''))) / length(a4_old) <> 1 THEN RAISE EXCEPTION 'anchor a4 not unique'; END IF;
  v_new := replace(v_new, a4_old, a4_new);
  EXECUTE 'CREATE OR REPLACE VIEW public.pack_table_rows AS ' || v_new;
END
$mig$;
