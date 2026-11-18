-- 2026-11-17 (Claude Code, Trevor's laptop, ~6:02 PM PT; Trevor: "Keep going", after forwarding the 5:04 PM PT
-- sentinel CRITICAL on both pack-sales arms).
--
-- sentinel_pack_sales_feeds() now also returns the walker's last `error` (first 200 chars). The sentinel's
-- pack-sales arms judge the CHAIN feed only while the walker runs CLEAN against Dapper's frozen index (#218);
-- since ~4:23 PM PT 11-17 Dapper's Studio GraphQL answers HTTP 530 to every request, the walker fails, and the
-- arms fell back to the 466/537 h-old Studio feed and paged CRITICAL although the chain feed was current. With
-- the error in hand the route can tell "the upstream is down" (a gateway/origin 5xx) from "our walker broke".
-- Additive: one more key in each lane's `walker` object; the deployed route ignores it until the code ships.
--
-- anon-exec: unchanged (sentinel_pack_sales_feeds) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
--
-- Revert: re-apply the body without the 'error' key (base md5(prosrc) e528c9ef85a4d345aff8c61c89f9e441).

CREATE OR REPLACE FUNCTION public.sentinel_pack_sales_feeds()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH lanes(key, slug, walker) AS (
    VALUES ('topshot', 'nba_top_shot', 'topshot-pack-sales-ingest'),
           ('allday',  'nfl_all_day',  'allday-pack-sales-ingest')
  )
  SELECT jsonb_object_agg(l.key, jsonb_build_object(
    'chain_newest_sale_at',
      (SELECT max(p.sealed_at) FROM public.pack_purchases p
        WHERE p.event_kind = 'secondary_sale'
          AND p.collection_id = (SELECT c.id FROM public.collections c WHERE c.slug = l.slug)),
    'walker',
      (SELECT jsonb_build_object('started_at', r.started_at, 'ok', r.ok,
                                 'partial', r.extra -> 'partial', 'head_new', r.extra -> 'head_new',
                                 'newest_block_time', r.extra ->> 'newest_block_time',
                                 'error', left(r.error, 200))
         FROM public.pipeline_runs r
        WHERE r.pipeline = l.walker
        ORDER BY r.started_at DESC LIMIT 1)))
  FROM lanes l
$function$;
