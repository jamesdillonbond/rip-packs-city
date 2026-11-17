-- audit_20261020_candy_edition_ask_reads_the_confirmed_floor
--
-- 2026-10-20 11:21 PM PT (Claude Code cloud; Trevor: "work on roadmap items and known issues").
-- Found by a read-only sweep: /candy-mlb/edition/jos-ramrez read "Floor ask —" while /insights/candy-mlb
-- listed the same edition at a $1.06 floor. get_edition_high_offer had arms for the All Day and Golazos
-- on-chain floors (20261021003446, 20261021004010) and none for Candy, so EVERY Candy edition page read
-- an em-dash ask: candy_listing_floor held 120 confirmed floors of 124 editions at the time
-- (José Ramírez: 7 listings / 7 sellers, last seen 8:35 PM PT 10-20).
--
-- WHAT.
--  1. public.candy_edition_confirmed_floor(p_edition_id) — plpgsql, returns nothing unless the edition is
--     Candy MLB, else candy_listing_floor's confirmed (troll-filtered) floor and last_seen_at (when the
--     indexer last saw the floor listing; a check, matching askStampKind("candy_mlb") = "checked"). It is
--     the same floor fmv-recalc uses as Candy's FMV ceiling (lib/fmv-candy-ceiling.ts).
--  2. get_edition_high_offer: low_ask = COALESCE(afa, gfa, cfa, base_x.low_ask), stamped from cfa when cfa
--     supplies it. Everything else byte-identical: md5-guarded text splice of the live body.
--
-- WHY A PLPGSQL HELPER, MEASURED (rolled-back probes, 200 calls on Top Shot 124:4360):
--   baseline 3.3 ms/call. Reading the view directly in a LATERAL gated on the edition's collection:
--   7.6 ms (gate on the `ed` CTE) and 11.5 ms (gate as an EXISTS InitPlan). EXPLAIN shows the EXISTS gate
--   DOES stop execution ("never executed"), but planning candy_listing_floor costs ~7 ms / 1,690 buffers
--   and this SQL function re-plans on every call — so any direct reference taxes every collection's
--   edition page. A plpgsql function plans its RETURN QUERY only when it reaches it: 2.5 ms/call on Top
--   Shot (unchanged result), 5.2 ms/call on Candy (low_ask 1.06, stamped 8:35 PM PT).
--
-- anon-exec: revoked (candy_edition_confirmed_floor) — new fn; postgres/service_role only, matching its one caller's ACL (get_edition_high_offer is SECURITY DEFINER, owner postgres).
-- anon-exec: intentional — same signature, ACL unchanged (postgres, service_role) (get_edition_high_offer)
--
-- REVERT: re-run the three splices in reverse (new fragment -> old fragment; pre-change body md5 pinned
-- below), then DROP FUNCTION public.candy_edition_confirmed_floor(uuid).

CREATE OR REPLACE FUNCTION public.candy_edition_confirmed_floor(p_edition_id uuid)
RETURNS TABLE (floor_ask numeric, floor_ask_verified_at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
BEGIN
  -- Non-Candy editions return before the view is planned (the point of this helper; see header).
  IF NOT EXISTS (
    SELECT 1 FROM editions e
     WHERE e.id = p_edition_id AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT c.confirmed_floor_usd, c.last_seen_at
      FROM candy_listing_floor c
     WHERE c.edition_id = p_edition_id
       AND c.confirmed_floor_usd IS NOT NULL;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.candy_edition_confirmed_floor(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_edition_confirmed_floor(uuid) TO postgres, service_role;

DO $mig$
DECLARE
  d text;
  n int;
  c_md5 constant text := '4d4827086f6c6b6bc20eafca5daea5a4';
  a_old constant text := 'ELSE COALESCE(afa.floor_ask, gfa.floor_ask, base_x.low_ask) END AS low_ask,';
  a_new constant text := 'ELSE COALESCE(afa.floor_ask, gfa.floor_ask, cfa.floor_ask, base_x.low_ask) END AS low_ask,';
  b_old constant text := E'           WHEN gfa.floor_ask IS NOT NULL THEN gfa.floor_ask_verified_at\n';
  b_new constant text := E'           WHEN gfa.floor_ask IS NOT NULL THEN gfa.floor_ask_verified_at\n           WHEN cfa.floor_ask IS NOT NULL THEN cfa.floor_ask_verified_at\n';
  c_old constant text := E'    WHERE g.edition_id = p_edition_id\n  ) gfa ON true;';
  c_new constant text := E'    WHERE g.edition_id = p_edition_id\n  ) gfa ON true\n'
    || E'  -- 2026-10-20: Candy MLB\'s confirmed floor, through a plpgsql helper that returns at once for any\n'
    || E'  -- other collection (a direct reference to the view costs ~7 ms of planning on every call).\n'
    || E'  LEFT JOIN LATERAL public.candy_edition_confirmed_floor(p_edition_id) cfa ON true;';
BEGIN
  SELECT md5(prosrc) INTO d FROM pg_proc WHERE oid = 'public.get_edition_high_offer(uuid)'::regprocedure;
  IF d <> c_md5 THEN RAISE EXCEPTION 'get_edition_high_offer body moved (md5 %), re-read before splicing', d; END IF;
  d := pg_get_functiondef('public.get_edition_high_offer(uuid)'::regprocedure);
  n := (length(d) - length(replace(d, a_old, ''))) / length(a_old);
  IF n <> 1 THEN RAISE EXCEPTION 'low_ask anchor found % times, want 1', n; END IF;
  d := replace(d, a_old, a_new);
  n := (length(d) - length(replace(d, b_old, ''))) / length(b_old);
  IF n <> 1 THEN RAISE EXCEPTION 'stamp anchor found % times, want 1', n; END IF;
  d := replace(d, b_old, b_new);
  n := (length(d) - length(replace(d, c_old, ''))) / length(c_old);
  IF n <> 1 THEN RAISE EXCEPTION 'tail anchor found % times, want 1', n; END IF;
  d := replace(d, c_old, c_new);
  EXECUTE d;
END
$mig$;
