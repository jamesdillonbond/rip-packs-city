-- audit_20260904_atlas_drain_also_fills_the_prose_and_media_the_dead_catalog_walker_used_to_write
--
-- anon-exec: public.atlas_editions_drain() keeps its existing ACL (postgres,
-- service_role only). This migration SPLICES the existing body; it creates no
-- new function and no new overload, and CREATE OR REPLACE does not reset an
-- ACL, so nothing about who may EXECUTE it changes.
--
-- WHY. `topshot-catalog-backfill` (Vercel cron 12 2 * * *) has failed EVERY
-- tick since 2026-08-29 -- 7 of 7, `page 0: HTTP 530: error code: 1033`, the
-- decommissioned public-api.nbatopshot.com. Its last success was 2026-08-28.
-- Three jobs died with it. Two are already covered: circulation went on-chain
-- (topshot-circulation-onchain, 2026-09-03) and badges/tier come from this very
-- drain (badge_editions + topshot_atlas_edition_map -- 13,312 of 13,436
-- canonical rows carry a tier, 0 editions rows have a NULL tier). The third had
-- no owner and froze on 08-28: `editions.description`, the narrative-search
-- prose, stuck at 9,199 of 13,436 (68.5%) with 4,237 rows NULL.
--
-- MEASURED BEFORE WRITING, not assumed. Atlas carries the same prose at
-- editions[].editionTemplate.metadata.Description and the CDN media at
-- editions[].assets[] (name 'hero' image/jpeg, 'video-square' video/mp4). On a
-- live 100-row page of set 90: 84 rows matched our catalog, Atlas had a
-- Description for all 100, **64 would be FILLED and 0 would be CHANGED** -- so
-- the field is byte-identical where we already hold it and this write is
-- near-zero in steady state, not a churn engine. The 16 unmatched rows are
-- parallels we do not carry (90:4046::1 "Explosion" etc.); creating editions
-- rows is deliberately NOT done here -- new-edition creation ripples into
-- circulation, sitemap and every surface, and is its own decision.
--
-- THE THREE RULES THIS WRITE OBEYS.
--  1. Prose REFRESHES (IS DISTINCT FROM), media only FILLS (NULL only). 11,074
--     thumbnails already point at the Atlas CDN and 2,323 at IPFS via the
--     on-chain resolver; overwriting a resolved IPFS CID with a CDN URL would
--     undo the permanence work, so a non-NULL media value is never touched.
--  2. It rides INSIDE the page loop it already pays for -- no new HTTP call, no
--     new cron, no new lambda. The walk is already continuous.
--  3. It can never take down the lane it rides on. Its own BEGIN/EXCEPTION
--     records a failure into atlas_set_refresh_state.last_error (placed AFTER
--     the success path clears that column, so the record survives) and lets the
--     badge upsert stand.
--
-- Triggers checked: zzz_topshot_normalize_base_club_circulation is
-- UPDATE OF circulation_count, so this write does not fire it;
-- editions_block_topshot_uuid_dupe short-circuits on int-keyed external_ids,
-- which is the only shape this join can match.
--
-- REVERT: re-splice the block out, or restore the prior body from
-- public.audit_20260904_atlas_drain_prior_src.
DO $mig$
DECLARE
  v_src text;
  v_new text;
  v_n   int;
  v_a1  constant text := '  v_errs integer := 0;';
  v_a2  constant text := '      UPDATE public.atlas_edition_requests SET drained_at = now(), status_code = q.status_code, rows_upserted = v_n WHERE request_id = q.request_id;';
  v_a3  constant text := '''errors'', v_errs, ''via'', ''pg_cron'',';
  v_blk text;
BEGIN
  SELECT pg_get_functiondef('public.atlas_editions_drain()'::regprocedure) INTO v_src;

  CREATE TABLE IF NOT EXISTS public.audit_20260904_atlas_drain_prior_src (
    captured_at timestamptz PRIMARY KEY DEFAULT now(), src text NOT NULL);
  INSERT INTO public.audit_20260904_atlas_drain_prior_src (src) VALUES (v_src);

  SELECT count(*) INTO v_n FROM regexp_matches(v_src, regexp_replace(v_a1, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 1 (declare) matched % times, expected 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, regexp_replace(v_a2, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 2 (body) matched % times, expected 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, regexp_replace(v_a3, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 3 (log meta) matched % times, expected 1', v_n; END IF;

  v_blk := $blk$      -- Atlas also carries the moment prose and the CDN media that the
      -- decommissioned topshot-catalog-backfill walker used to write (dead host
      -- public-api.nbatopshot.com, 7 of 7 ticks failing since 2026-08-29).
      -- Prose REFRESHES on change; media only FILLS a NULL, so an IPFS CID
      -- resolved on-chain is never overwritten with a CDN URL.
      BEGIN
        WITH atlas_ed AS (
          SELECT x.ed AS j,
                 (x.ed->>'setId')::int AS set_id,
                 (x.ed->>'editionTemplateId')::int AS play_id,
                 COALESCE(NULLIF(x.ed->>'parallel',''), 'Standard') AS parallel
            FROM jsonb_array_elements(v_body->'editions') AS x(ed)
        ),
        keyed_ed AS (
          SELECT a.*, CASE WHEN a.parallel = 'Standard' THEN 0 ELSE sm.id END AS par_id
            FROM atlas_ed a LEFT JOIN _atlas_submap sm ON sm.name = a.parallel
        ),
        src_ed AS (
          SELECT DISTINCT
                 k.set_id || ':' || k.play_id || CASE WHEN k.par_id > 0 THEN '::' || k.par_id::text ELSE '' END AS external_id,
                 NULLIF(k.j->'editionTemplate'->'metadata'->>'Description', '') AS description,
                 (SELECT a2->>'file' FROM jsonb_array_elements(COALESCE(k.j->'assets','[]'::jsonb)) a2
                   WHERE a2->>'name' = 'hero' LIMIT 1) AS thumb,
                 (SELECT a2->>'file' FROM jsonb_array_elements(COALESCE(k.j->'assets','[]'::jsonb)) a2
                   WHERE a2->>'name' = 'video-square' LIMIT 1) AS video
            FROM keyed_ed k
           WHERE k.set_id IS NOT NULL AND k.play_id IS NOT NULL AND k.par_id IS NOT NULL
        ),
        upd_ed AS (
          UPDATE public.editions e
             SET description   = COALESCE(s.description, e.description),
                 thumbnail_url = COALESCE(e.thumbnail_url, s.thumb),
                 video_url     = COALESCE(e.video_url, s.video)
            FROM src_ed s
           WHERE e.collection_id = v_ts
             AND e.external_id = s.external_id
             AND ( (s.description IS NOT NULL AND e.description IS DISTINCT FROM s.description)
                OR (e.thumbnail_url IS NULL AND s.thumb IS NOT NULL)
                OR (e.video_url   IS NULL AND s.video IS NOT NULL) )
          RETURNING 1
        )
        SELECT count(*)::int INTO v_ed_page FROM upd_ed;
        v_ed := v_ed + COALESCE(v_ed_page, 0);
      EXCEPTION WHEN OTHERS THEN
        -- Never take down the badge lane this rides on. Recorded AFTER the
        -- success path clears last_error, so the record survives the tick.
        UPDATE public.atlas_set_refresh_state
           SET last_error = left('editions-enrich: ' || SQLERRM, 300)
         WHERE set_id_onchain = q.set_id_onchain;
      END;

$blk$;

  v_new := replace(v_src, v_a1, v_a1 || E'\n  v_ed integer := 0;\n  v_ed_page integer;');
  v_new := replace(v_new, v_a2, v_blk || v_a2);
  v_new := replace(v_new, v_a3, '''errors'', v_errs, ''editions_enriched'', v_ed, ''via'', ''pg_cron'',');

  IF v_new = v_src THEN RAISE EXCEPTION 'splice produced no change'; END IF;
  EXECUTE v_new;
END
$mig$;
