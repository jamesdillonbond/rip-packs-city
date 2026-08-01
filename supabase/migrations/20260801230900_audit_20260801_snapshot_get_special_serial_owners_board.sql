-- Snapshot migration: public.get_special_serial_owners_board(text,text,text,text,text,integer,integer,text).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). Commits the CURRENT LIVE definition verbatim
-- (pg_get_functiondef base64-decoded 2026-08-01; byte-identical, md5
-- db9d79ce89d53eaa6e30e788849162d1). Applying it is a no-op against prod.
--
-- What it does: backs the PUBLIC /insights special-serial-owners board + the
-- concierge get_special_serial_owners tool. Reads the per-collection
-- special_serial_owners MV (topshot vs allday, chosen by p_collection), applies
-- the tag / tier / player(ILIKE) / holder filters, sorts by fmv or recency, and
-- paginates with a clamped limit (1..200) + non-negative offset.

CREATE OR REPLACE FUNCTION public.get_special_serial_owners_board(p_tag text DEFAULT NULL::text, p_tier text DEFAULT NULL::text, p_player text DEFAULT NULL::text, p_holder text DEFAULT NULL::text, p_sort text DEFAULT 'fmv'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_collection text DEFAULT 'nba-top-shot'::text)
 RETURNS TABLE(edition_id uuid, edition_key text, player_name text, set_name text, tier text, series smallint, team_name text, circulation_count integer, serial integer, tag text, holder_address text, nft_id text, holder_seen_at timestamp with time zone, edition_fmv numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH args AS (
    SELECT
      NULLIF(btrim(p_tag), '')                       AS f_tag,
      upper(NULLIF(btrim(p_tier), ''))               AS f_tier,
      NULLIF(btrim(p_player), '')                    AS f_player,
      lower(NULLIF(btrim(p_holder), ''))             AS f_holder,
      CASE WHEN lower(btrim(p_sort)) = 'recent' THEN 'recent' ELSE 'fmv' END AS f_sort,
      LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200) AS f_limit,
      GREATEST(COALESCE(p_offset, 0), 0)             AS f_offset,
      CASE WHEN lower(btrim(p_collection)) IN ('nfl-all-day','nfl_all_day','allday')
           THEN 'allday' ELSE 'topshot' END          AS f_coll
  ),
  src AS (
    SELECT * FROM public.topshot_special_serial_owners_mv
      WHERE (SELECT f_coll FROM args) = 'topshot'
    UNION ALL
    SELECT * FROM public.allday_special_serial_owners_mv
      WHERE (SELECT f_coll FROM args) = 'allday'
  )
  SELECT
    o.edition_id,
    o.edition_key::text,
    o.player_name,
    o.set_name,
    o.tier::text,
    o.series,
    o.team_name,
    o.circulation_count,
    o.serial,
    o.tag,
    o.holder_address,
    o.nft_id,
    o.holder_seen_at,
    o.edition_fmv
  FROM src o, args a
  WHERE (a.f_tag    IS NULL OR o.tag = a.f_tag)
    AND (a.f_tier   IS NULL OR upper(o.tier::text) = a.f_tier)
    AND (a.f_player IS NULL OR o.player_name ILIKE '%' || a.f_player || '%')
    AND (a.f_holder IS NULL OR lower(o.holder_address) = a.f_holder)
  ORDER BY
    CASE WHEN a.f_sort = 'recent' THEN o.holder_seen_at END DESC NULLS LAST,
    CASE WHEN a.f_sort = 'fmv'    THEN o.edition_fmv     END DESC NULLS LAST,
    o.edition_fmv DESC NULLS LAST,
    o.edition_id,
    o.serial
  LIMIT (SELECT f_limit FROM args)
  OFFSET (SELECT f_offset FROM args);
$function$;
