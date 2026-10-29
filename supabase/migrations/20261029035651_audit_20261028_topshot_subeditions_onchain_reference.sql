-- 2026-10-28: Top Shot parallels the catalog has never seen can now be catalogued.
-- atlas_editions_drain() keyed Atlas's parallel NAME to a subedition id through a map built ONLY from editions we
-- already hold, so a brand-new parallel ("Animated", 56 Atlas editions across Run It Back: For The Win, Origins,
-- Legacies, Immortals) could never enter the map and every one of its editions was skipped — badge_editions set 273
-- held 140 of Atlas's 160, and challenge ingest carried 4 unresolved slots. The map now also reads
-- topshot_subeditions, seeded from the chain: TopShot.getAllSubeditions() at 0x0b2a3299cc857e29 (script run
-- 2026-10-28, sealed block), which names 24 ids — 12 Diamond, 23 Animated and 24 Illustrated are not in editions yet.
-- anon-exec: unchanged (atlas_editions_drain) — body re-executed from its own live definition, same signature; ACL preserved. The new table is service-role only.
-- revert: restore the prior body (replace the UNION line back out) and DROP TABLE public.topshot_subeditions.

CREATE TABLE IF NOT EXISTS public.topshot_subeditions (
  subedition_id integer PRIMARY KEY,
  name text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'chain:TopShot.getAllSubeditions',
  verified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topshot_subeditions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_subeditions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.topshot_subeditions TO service_role;

INSERT INTO public.topshot_subeditions (subedition_id, name) VALUES
  (1,'Explosion'),(2,'Torn'),(3,'Vortex'),(4,'Rippled'),(5,'Coded'),(6,'Halftone'),(7,'Bubbled'),(8,'Diced'),
  (9,'Bit'),(10,'Vibe'),(11,'Astra'),(12,'Diamond'),(13,'Voltage'),(14,'Livewire'),(15,'Championship'),
  (16,'Club Collection'),(17,'Blockchain'),(18,'Hardcourt'),(19,'Hexwave'),(20,'Jukebox'),(21,'Galactic'),
  (22,'Omega'),(23,'Animated'),(24,'Illustrated')
ON CONFLICT (subedition_id) DO NOTHING;

-- The chain and our catalog must agree wherever both name an id; a disagreement aborts the migration.
DO $chk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.editions e JOIN public.topshot_subeditions s ON s.subedition_id = e.subedition_id
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND e.subedition_name IS DISTINCT FROM s.name
  ) THEN RAISE EXCEPTION 'editions disagrees with the chain on a subedition name'; END IF;
END $chk$;

DO $fn$
DECLARE
  d text := pg_get_functiondef('public.atlas_editions_drain()'::regprocedure);
  old text := '     WHERE e.collection_id = v_ts AND e.subedition_id IS NOT NULL AND e.subedition_name IS NOT NULL;';
  new text := '     WHERE e.collection_id = v_ts AND e.subedition_id IS NOT NULL AND e.subedition_name IS NOT NULL
    UNION
    SELECT s.name, s.subedition_id FROM public.topshot_subeditions s;';
BEGIN
  IF (length(d) - length(replace(d, old, ''))) / length(old) <> 1 THEN
    RAISE EXCEPTION 'atlas_editions_drain submap anchor not found exactly once';
  END IF;
  EXECUTE replace(d, old, new);
END $fn$;
