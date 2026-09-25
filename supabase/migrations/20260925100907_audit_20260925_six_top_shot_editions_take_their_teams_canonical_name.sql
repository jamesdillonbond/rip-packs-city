-- 2026-09-25 (PT) — six Top Shot editions carried a FRAGMENT of their team's
-- name ("Liberty", "Mercury", "Tempo", "Valkyries" ×2) or a trailing space
-- ("Indiana Fever "), so each fragment became its own one-edition team page
-- (/nba-top-shot/team/liberty: "Players 1 · Editions 1 · 30d Sales 0") beside
-- the real one (New York Liberty, 181 editions), and the 30 WNBA sitemap team
-- pages counted phantoms. Found on the sweep as the one team page with no
-- sales copy. Every fragment matches exactly ONE canonical name in the same
-- collection with ≥5× the editions (measured; no other collection has the
-- shape — Candy's short names have no long form to fold into, #137 f).
-- Fill-only on the six rows; the canonical names are the ones already on the
-- other 659 editions. Revert: pre-image in audit_20260925_ts_team_name_backup
-- (drop after 10-01).

CREATE TABLE IF NOT EXISTS public.audit_20260925_ts_team_name_backup AS
SELECT e.id, e.external_id, e.team_name
FROM public.editions e
WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND e.team_name IN ('Liberty', 'Mercury', 'Tempo', 'Valkyries', 'Indiana Fever ');
ALTER TABLE public.audit_20260925_ts_team_name_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_ts_team_name_backup FROM PUBLIC, anon, authenticated;

WITH fix(frag, canonical) AS (VALUES
  ('Liberty', 'New York Liberty'),
  ('Mercury', 'Phoenix Mercury'),
  ('Tempo', 'Toronto Tempo'),
  ('Valkyries', 'Golden State Valkyries'),
  ('Indiana Fever ', 'Indiana Fever')
)
UPDATE public.editions e
   SET team_name = f.canonical
  FROM fix f
 WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND e.team_name = f.frag;

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.editions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND team_name IN ('Liberty', 'Mercury', 'Tempo', 'Valkyries', 'Indiana Fever ');
  IF v <> 0 THEN RAISE EXCEPTION '% fragment team names remain', v; END IF;
  SELECT count(*) INTO v FROM public.audit_20260925_ts_team_name_backup;
  IF v <> 6 THEN RAISE EXCEPTION 'expected 6 backed-up rows, got %', v; END IF;
END $$;
