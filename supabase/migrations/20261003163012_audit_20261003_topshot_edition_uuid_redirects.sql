-- audit_20261003_topshot_edition_uuid_redirects
--
-- Search Console read 2026-10-03: 285 of the property's 326 "Not found (404)"
-- URLs are the UUID-form Top Shot edition keys
-- (/nba-top-shot/edition/<setUUID>:<playUUID>) that the 2026-09-08 cleanup
-- purged from `editions` (backup: audit_20260908_ts_noncanonical_editions,
-- 6,597 keys) and that the edition page has 404'd since via
-- isTopShotFossilSlug(). Google still crawls them (last crawled 09-21), and
-- 17 more sit in "Duplicate, Google chose different canonical than user".
--
-- This table lets the page answer those URLs with a 308 to the canonical
-- `setID:playID` page instead of a 404, so whatever equity and index memory
-- they carry moves to the live page. Mapping rule (measured before this
-- write): the fossil's set UUID resolves through `sets.external_id` to
-- `set_id_onchain`; a canonical edition in that set with the same player_name,
-- the same name ("<Player> — <Set>"), the same subedition_id and a numeric
-- `setID:playID` key is the target. ONLY fossils with EXACTLY ONE such
-- candidate are mapped: 4,447 of 6,597. The 482 with two or more candidates
-- (a player with several plays in one set) and the 1,668 with none stay 404
-- — a wrong 308 is worse than an honest 404. Spot-checked 10 pairs by player,
-- set and circulation before the write.
--
-- Read path: the server page uses the service-role client, so RLS is ENABLED
-- with NO policies (the estate's deny-all shape for anon/authenticated).
--
-- Revert: DROP TABLE public.topshot_edition_uuid_redirects; the page's
-- lookup then finds no row and falls back to notFound() exactly as before.

CREATE TABLE IF NOT EXISTS public.topshot_edition_uuid_redirects (
  fossil_slug    text PRIMARY KEY,
  canonical_slug text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topshot_edition_uuid_redirects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_edition_uuid_redirects FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.topshot_edition_uuid_redirects IS
  '2026-10-03: UUID-form Top Shot edition keys (purged 09-08) -> canonical setID:playID, unambiguous name/set/subedition matches only. Read by the edition page (service role) to 308 instead of 404. Revert: DROP TABLE.';

INSERT INTO public.topshot_edition_uuid_redirects (fossil_slug, canonical_slug)
WITH a AS (
  SELECT DISTINCT external_id AS fossil, split_part(external_id, ':', 1) AS set_uuid,
         name, player_name, subedition_id
  FROM public.audit_20260908_ts_noncanonical_editions
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
), cand AS (
  SELECT a.fossil, e.external_id AS canonical
  FROM a
  JOIN public.sets s ON s.external_id = a.set_uuid AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  JOIN public.editions e ON e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND e.set_id_onchain = s.set_id_onchain
       AND e.player_name IS NOT DISTINCT FROM a.player_name
       AND e.name = a.name
       AND e.subedition_id IS NOT DISTINCT FROM a.subedition_id
       AND e.external_id ~ '^[0-9]+:[0-9]+$'
)
SELECT fossil, min(canonical)
FROM cand
GROUP BY fossil
HAVING count(*) = 1
ON CONFLICT (fossil_slug) DO NOTHING;

DO $verify$
DECLARE v_n int; v_bad int; v_rls boolean;
BEGIN
  SELECT count(*) INTO v_n FROM public.topshot_edition_uuid_redirects;
  IF v_n < 4000 OR v_n > 5000 THEN RAISE EXCEPTION 'expected ~4,447 redirect rows, got %', v_n; END IF;
  SELECT count(*) INTO v_bad FROM public.topshot_edition_uuid_redirects r
   WHERE NOT EXISTS (SELECT 1 FROM public.editions e WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.external_id = r.canonical_slug);
  IF v_bad <> 0 THEN RAISE EXCEPTION '% redirect targets do not exist in editions', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM public.topshot_edition_uuid_redirects WHERE canonical_slug !~ '^[0-9]+:[0-9]+$' OR fossil_slug !~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$';
  IF v_bad <> 0 THEN RAISE EXCEPTION '% rows have a malformed key', v_bad; END IF;
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE relname = 'topshot_edition_uuid_redirects';
  IF NOT v_rls THEN RAISE EXCEPTION 'RLS not enabled'; END IF;
  IF has_table_privilege('anon', 'public.topshot_edition_uuid_redirects', 'SELECT') THEN RAISE EXCEPTION 'anon can read the table'; END IF;
END
$verify$;
