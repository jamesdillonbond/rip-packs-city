-- 2026-09-25 (PT) — 443 Top Shot editions had an empty `name` while carrying a
-- player_name and a set_name; twelve RPCs read e.name (get_edition_detail,
-- get_edition_page_data, get_set_editions, get_series_editions, the sniper and
-- team lists…), so those rows rendered an empty title wherever the name is the
-- label. The house form is "<player> — <set>" (the wallet-search writer's), so
-- the fill is the same value every other row carries. UFC's 299 unnamed rows
-- stay: their set_name is garbage ("2 0") and the market is closed.
-- Touched ids in audit_20260925_edition_name_fill_backup (RLS on).
-- Revert: UPDATE editions e SET name = NULL FROM audit_20260925_edition_name_fill_backup b WHERE b.edition_id = e.id;
CREATE TABLE IF NOT EXISTS public.audit_20260925_edition_name_fill_backup (
  edition_id uuid PRIMARY KEY,
  old_name   text,
  filled_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260925_edition_name_fill_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_edition_name_fill_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE n int;
BEGIN
  WITH upd AS (
    UPDATE public.editions e
       SET name = e.player_name || ' — ' || e.set_name
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND (e.name IS NULL OR btrim(e.name) = '')
       AND e.player_name IS NOT NULL AND btrim(e.player_name) <> ''
       AND e.set_name IS NOT NULL AND btrim(e.set_name) <> ''
    RETURNING e.id
  )
  INSERT INTO public.audit_20260925_edition_name_fill_backup (edition_id, old_name)
  SELECT id, NULL FROM upd ON CONFLICT (edition_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'filled % edition names', n;
  IF (SELECT count(*) FROM public.editions WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND (name IS NULL OR btrim(name) = '') AND player_name IS NOT NULL AND set_name IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'unnamed Top Shot editions with a player and a set remain';
  END IF;
END $$;
