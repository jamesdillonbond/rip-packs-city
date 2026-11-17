-- 2026-11-08 (PT) — Disney Pinnacle Open Edition drops for the pack calendar.
--
-- WHY. Trevor ("Yes do it all", 11-08): the drops calendar / Sunday post should name Pinnacle's
-- Open Edition drops. They are not packs — no PackNFT, no Atlas book row — the pins are minted
-- straight into the buyer's wallet by an admin mint tx while the drop is on sale (e.g. Gargoyles
-- Vol.1: 7,197 pins 10-26 5:54 PM PT → 11-06 9:00 AM PT, ending on the minute the drop closed).
-- So an Open Edition drop can be seen only once it is minting, from pinnacle_mint_events, with no
-- price and no announced end.
--
-- WHAT.
--   idx_pinnacle_mint_events_minted_at  the read is a time slice of 554k rows (133 MB) that had no
--                                       time index.
--   get_pinnacle_open_edition_drops(p_days)  jsonb:
--     lane_as_of — the newest ok run of ingest-pinnacle-mints-forward in the last 2 h that was
--                  within 2,000 blocks of the sealed head; NULL = the mint lane is behind or
--                  dark, so "nothing minting" cannot be claimed (the caller treats it as unread).
--     sets       — per Open Edition set (render id prefix 'OE…'): name and edition type from
--                  pinnacle_catalog, pins minted, first and last mint in the window.
--
-- anon-exec: get_pinnacle_open_edition_drops(integer) — new; REVOKE FROM PUBLIC, anon, authenticated below (read by the public API through the service role).
--
-- Revert:
--   DROP FUNCTION public.get_pinnacle_open_edition_drops(integer);
--   DROP INDEX public.idx_pinnacle_mint_events_minted_at;

CREATE INDEX IF NOT EXISTS idx_pinnacle_mint_events_minted_at ON public.pinnacle_mint_events (minted_at);

CREATE OR REPLACE FUNCTION public.get_pinnacle_open_edition_drops(p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'lane_as_of', (
      SELECT max(r.started_at)
        FROM public.pipeline_runs r
       WHERE r.pipeline = 'ingest-pinnacle-mints-forward'
         AND r.ok
         AND r.started_at > now() - interval '2 hours'
         AND (r.extra->>'sealed_height') ~ '^[0-9]+$' AND (r.extra->>'window_end') ~ '^[0-9]+$'
         AND (r.extra->>'sealed_height')::bigint - (r.extra->>'window_end')::bigint < 2000),
    'sets', coalesce((
      SELECT jsonb_agg(s ORDER BY s.first_mint_at)
        FROM (
          SELECT split_part(r.render_id, '-', 1) || '-' || split_part(r.render_id, '-', 2) AS set_key,
                 max(c.set_name) AS set_name,
                 max(c.edition_type) AS edition_type,
                 sum(r.pins) AS pins,
                 min(r.first_mint_at) AS first_mint_at,
                 max(r.last_mint_at) AS last_mint_at
            FROM (
              -- per render first, so the catalog is probed once per render, not once per pin
              SELECT m.render_id, count(*) AS pins, min(m.minted_at) AS first_mint_at, max(m.minted_at) AS last_mint_at
                FROM public.pinnacle_mint_events m
               WHERE m.minted_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 31)))
                 AND m.render_id LIKE 'OE%'
               GROUP BY m.render_id
            ) r
            LEFT JOIN public.pinnacle_catalog c ON c.render_id = r.render_id
           GROUP BY 1
        ) s), '[]'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_open_edition_drops(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_open_edition_drops(integer) TO service_role, postgres;
