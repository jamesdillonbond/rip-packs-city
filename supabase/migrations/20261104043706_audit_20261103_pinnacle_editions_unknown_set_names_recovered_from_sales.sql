-- audit_20261103_pinnacle_editions_unknown_set_names_recovered_from_sales
--
-- 2026-11-03 ~8:55–9:10 PM PT (Claude Code cloud; Trevor: "Keep going, proceed with all that make sense").
-- The open item left by 20261103190350 (studio "Unknown" NULLed): 148 `pinnacle_editions` rows created
-- 2026-04-16 carry an INVENTED `set_name = 'Unknown'`. They are live keys — 1,346 pinnacle_sales rows point
-- at them (163 in the last 90 days) — and readers print the key's set: get_edition_detail's legacy-key arm
-- ("<character> - Unknown (<variant>)"), get_moment_detail's pinnacle_edition arm, and the key-level set
-- fallback in /api/top-sales and /api/wallet-sales-history.
--
-- RECOVERED FROM READ DATA, NOT GUESSED. Each key's own sales carry a render_id, and every one of those
-- renders is a pinnacle_catalog pin with a set_name. For 111 of the 148 keys, ALL of their sales' pins name
-- exactly ONE set (0 keys name two). The other 37 have no sales and no catalog link (legacy_edition_key) —
-- left as they are: `set_name` is NOT NULL, and no source names them.
-- CONTROL (same derivation on keys whose set IS known, sales in the last 120 days): 448 of 449 reproduce
-- the stored value exactly (the 1 miss is a spacing variant, "Luca Vol. 1" vs "Luca Vol.1") — so the
-- derived value is this column's own convention.
-- Recovered sets (keys): Chip 'n Dale: Rescue Rangers Vol.1 (36), Friends of Nemo Vol.1 (24), Star Wars
-- Saga Vol.3 (22), Zootopia Vol.1 (12), Mickey & Friends: Luck of the Irish Vol.1 (6), Pixar Mosaics Vol.1
-- (5), Beauty and the Beast Vol.2 (5), Star Wars Droids Vol.1 (1). Characters match their sets.
--
-- No unique constraint involves set_name (unique: id, external_id); BEFORE trigger
-- trg_normalize_pinnacle_edition only trims; the AFTER trigger fires on character_name only.
--
-- REVERT:
--   UPDATE public.pinnacle_editions pe SET set_name = b.set_name
--   FROM public.audit_20261103_pinnacle_set_unknown_backup b WHERE b.id = pe.id;

CREATE TABLE IF NOT EXISTS public.audit_20261103_pinnacle_set_unknown_backup AS
  SELECT id, set_name, now() AS backed_up_at FROM public.pinnacle_editions WHERE set_name = 'Unknown';
ALTER TABLE public.audit_20261103_pinnacle_set_unknown_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261103_pinnacle_set_unknown_backup FROM anon, authenticated;

WITH rec AS (
  SELECT u.id, min(btrim(pc.set_name)) AS nm
  FROM public.pinnacle_editions u
  JOIN public.pinnacle_sales s ON s.edition_id = u.id
  JOIN public.pinnacle_catalog pc ON pc.render_id = s.render_id
  WHERE u.set_name = 'Unknown'
    AND nullif(btrim(pc.set_name), '') IS NOT NULL
  GROUP BY u.id
  HAVING count(DISTINCT btrim(pc.set_name)) = 1
)
UPDATE public.pinnacle_editions pe
SET set_name = rec.nm
FROM rec
WHERE pe.id = rec.id
  AND pe.set_name = 'Unknown';

DO $post$
DECLARE
  v_left int;
  v_backup int;
BEGIN
  SELECT count(*) INTO v_left FROM public.pinnacle_editions WHERE set_name = 'Unknown';
  SELECT count(*) INTO v_backup FROM public.audit_20261103_pinnacle_set_unknown_backup;
  IF v_backup <> 148 OR v_left <> 37 THEN
    RAISE EXCEPTION 'post-flight: backup % (want 148), Unknown left % (want 37)', v_backup, v_left;
  END IF;
END
$post$;
