-- PROTOTYPE ONLY — nothing calls this. Separate function so the live
-- rpc_search_catalog (public header search + concierge) is untouched.
--
-- Targets the MEASURED defect: `LIKE ALL (v_pats)` ANDs every token, so one
-- word the prose never uses returns ZERO rows for an otherwise perfect query.
--     lillard buzzer        -> 121:4255 rank 6   ✅ (works today)
--     lillard buzzer beater -> 0 rows            ❌ ("beater" absent)
--
-- Change: allow ONE unmatched token, but ONLY for queries of 3+ tokens.
-- ⚠ Allowing a miss on a 2-token query collapses it to OR semantics — "game
-- winner" would match every edition containing "game" — so 1- and 2-token
-- queries keep the strict AND. This is why the threshold is not a flat ratio.
--
-- Ranking adds a coverage term so a FULL match always outranks a partial one.
CREATE OR REPLACE FUNCTION public.rpc_search_catalog_v3(p_q text, p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(kind text, label text, sublabel text, slug text, collection_id uuid, collection_slug text, thumbnail_url text, edition_count integer, score real)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_q text := lower(btrim(coalesce(p_q,'')));
  v_tokens text[]; v_anchor text; v_pats text[];
  v_n int; v_need int;
  v_limit int := least(greatest(coalesce(p_limit,20),1),50);
  v_ts CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  IF length(v_q) < 2 THEN RETURN; END IF;
  v_tokens := array_remove(regexp_split_to_array(v_q,'\s+'),'');
  v_n := coalesce(array_length(v_tokens,1),0);
  IF v_n = 0 THEN RETURN; END IF;
  SELECT t INTO v_anchor FROM unnest(v_tokens) AS t ORDER BY length(t) DESC, t LIMIT 1;
  SELECT array_agg('%'||t||'%') INTO v_pats FROM unnest(v_tokens) AS t;
  -- The whole change, in one line: 3+ tokens may miss one; 1-2 must match all.
  v_need := CASE WHEN v_n >= 3 THEN v_n - 1 ELSE v_n END;

  RETURN QUERY
  WITH edition_cand AS (
    SELECT e.external_id, e.collection_id AS cid, e.player_name, e.set_name,
           e.play_type, e.tier::text AS tier, e.thumbnail_url, e.id,
           e.circulation_count,
           (SELECT count(*) FROM unnest(v_pats) pat
              WHERE lower(coalesce(e.player_name,'')||' '||coalesce(e.set_name,'')||' '||
                          coalesce(e.team_name,'')||' '||coalesce(e.play_type,'')||' '||
                          coalesce(e.play_category,'')||' '||coalesce(e.description,'')) LIKE pat
           )::int AS tok_hit,
           (e.description IS NOT NULL AND lower(e.description) LIKE '%'||v_anchor||'%') AS anchor_in_prose
    FROM public.editions e
    WHERE (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND (e.collection_id <> v_ts OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND (e.player_name ILIKE '%'||v_anchor||'%'
        OR e.set_name    ILIKE '%'||v_anchor||'%'
        OR e.team_name   ILIKE '%'||v_anchor||'%'
        OR e.description ILIKE '%'||v_anchor||'%')
    ORDER BY e.circulation_count ASC NULLS LAST
    LIMIT 400
  )
  SELECT 'edition'::text, coalesce(c.player_name,'Unknown')::text,
         nullif(concat_ws(' · ', c.set_name, c.play_type, c.tier),'')::text,
         coalesce(c.external_id, c.id::text)::text, c.cid, col.slug::text,
         c.thumbnail_url::text, 1,
         (extensions.similarity(lower(coalesce(c.player_name,'')||' '||coalesce(c.set_name,'')), v_q)
           + (c.tok_hit::real / greatest(v_n,1)) * 0.60
           + CASE WHEN c.anchor_in_prose THEN 0.10 ELSE 0 END
         )::real
  FROM edition_cand c
  JOIN public.collections col ON col.id = c.cid AND col.is_active
  WHERE c.tok_hit >= v_need
  ORDER BY 9 DESC, 2 ASC
  LIMIT v_limit;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_search_catalog_v3(text, uuid, integer) FROM PUBLIC, anon, authenticated;