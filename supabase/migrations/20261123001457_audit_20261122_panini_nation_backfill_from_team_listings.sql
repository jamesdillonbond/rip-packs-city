-- 2026-11-22 PT (NWSL thread). Restore the printed TEAM (panini_editions.nation) that the edition
-- upsert erased: until 6cd2399 (2:31 PM PT) every card walked outside a grid pass upserted
-- nation = NULL over the stored team. Source: panini_team_listings.team_raw — the same marketplace
-- grid `team` field, read by the laptop team walk. Agreement where both exist: 4,514 of 4,514 exact.
-- Only NULL rows are filled; the newest listing per psku wins. Audit table = the exact rows written.
-- Revert: UPDATE public.panini_editions e SET nation = NULL
--           FROM public.audit_20261122_panini_nation_backfill a WHERE e.external_id = a.external_id;
CREATE TABLE IF NOT EXISTS public.audit_20261122_panini_nation_backfill (
  external_id text PRIMARY KEY,
  nation      text NOT NULL,
  written_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261122_panini_nation_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261122_panini_nation_backfill FROM PUBLIC, anon, authenticated;

WITH l AS MATERIALIZED (
  SELECT DISTINCT ON (psku) psku, btrim(team_raw) AS team
    FROM public.panini_team_listings
   WHERE nullif(btrim(team_raw), '') IS NOT NULL
   ORDER BY psku, last_seen_at DESC NULLS LAST
), upd AS (
  UPDATE public.panini_editions e
     SET nation = l.team
    FROM l
   WHERE e.external_id = l.psku
     AND e.nation IS NULL
  RETURNING e.external_id, e.nation
)
INSERT INTO public.audit_20261122_panini_nation_backfill (external_id, nation)
SELECT external_id, nation FROM upd
ON CONFLICT (external_id) DO NOTHING;
