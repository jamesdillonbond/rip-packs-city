-- 2026-09-23 · pack_table_rows reads the measured availability (part 2 of 2; part 1 =
-- audit_20260923_pack_availability_measured_snapshot_state_and_golazos_primary).
--
-- Rewrites the LIVE view definition by targeted replacement inside a DO block
-- instead of a hand-transcribed body: CREATE OR REPLACE is a full-body write, and
-- a re-typed 150-line view is exactly how a stale draft silently reverts another
-- session's change. Each replacement ASSERTS it matched exactly once, so if the
-- live body has moved this migration fails loudly instead of half-applying.
-- The pre-change definition is kept verbatim in
-- public.audit_20260923_pack_table_rows_prev (revert = EXECUTE it).
--
-- Changes (see part 1 for the why):
--   secondary_available : listed -> true; not listed AND the collection's last
--                         complete walk < 60 min old -> false; else the EV
--                         writer's value (NULL when none).
--   secondary_ask       : NULL when a fresh walk says "not listed" (a stale ask
--                         is not a price anyone can pay).
--   primary_available   : writer's value; else All Day endTime passed -> false;
--                         else Golazos primary_* facts; else NULL.
--   pas lateral         : also matches laliga-golazos listings.
--
-- definer-view: intentional — pack_table_rows was a definer view before this change
-- (reloptions NULL) and is on security_definer_view_allowlist since 2026-06-28; this
-- migration keeps that mode unchanged.
--
-- REVERT:
--   DO $$ BEGIN EXECUTE 'CREATE OR REPLACE VIEW public.pack_table_rows AS ' ||
--     (SELECT def FROM public.audit_20260923_pack_table_rows_prev); END $$;

CREATE TABLE IF NOT EXISTS public.audit_20260923_pack_table_rows_prev AS
SELECT pg_get_viewdef('public.pack_table_rows'::regclass) AS def, now() AS saved_at;
ALTER TABLE public.audit_20260923_pack_table_rows_prev ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260923_pack_table_rows_prev FROM anon, authenticated;

DO $mig$
DECLARE
  d text := pg_get_viewdef('public.pack_table_rows'::regclass);
  n int;
  old_sec text := $q$    pev.primary_available,
        CASE
            WHEN (pas.live_ask IS NOT NULL) THEN true
            ELSE pev.secondary_available
        END AS secondary_available,$q$;
  new_sec text := $q$        CASE
            WHEN (pev.primary_available IS NOT NULL) THEN pev.primary_available
            WHEN ((pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) AND ((pd.metadata ->> 'endTime'::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}'::text) AND ((("substring"((pd.metadata ->> 'endTime'::text), 1, 19))::timestamp without time zone AT TIME ZONE 'UTC'::text) < now())) THEN false
            WHEN ((pd.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid) AND (pd.metadata ? 'primary_state'::text)) THEN (((pd.metadata ->> 'primary_state'::text) <> 'Complete'::text) AND (((pd.metadata ->> 'primary_available_supply'::text))::integer > 0) AND (((pd.metadata ->> 'primary_start_time'::text))::timestamp with time zone <= now()) AND (((pd.metadata ->> 'primary_end_time'::text))::timestamp with time zone > now()))
            ELSE NULL::boolean
        END AS primary_available,
        CASE
            WHEN (pas.live_ask IS NOT NULL) THEN true
            WHEN (snap.fresh IS TRUE) THEN false
            ELSE pev.secondary_available
        END AS secondary_available,$q$;
  old_ask text := $q$    COALESCE(pas.live_ask, pev.secondary_ask) AS secondary_ask,$q$;
  new_ask text := $q$        CASE
            WHEN (pas.live_ask IS NOT NULL) THEN pas.live_ask
            WHEN (snap.fresh IS TRUE) THEN NULL::numeric
            ELSE pev.secondary_ask
        END AS secondary_ask,$q$;
  old_pas text := $q$(pas0.collection_slug = 'nfl-all-day'::text))$q$;
  new_pas text := $q$(pas0.collection_slug = 'nfl-all-day'::text)) OR ((pd.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid) AND (pas0.collection_slug = 'laliga-golazos'::text))$q$;
  snap_join text := $q$
     LEFT JOIN LATERAL ( SELECT (ss.last_ok_at > (now() - '01:00:00'::interval)) AS fresh
           FROM pack_ask_snapshot_state ss
          WHERE (ss.collection_slug = CASE pd.collection_id
                    WHEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN 'nba-top-shot'::text
                    WHEN 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN 'nfl-all-day'::text
                    WHEN '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid THEN 'laliga-golazos'::text
                    ELSE NULL::text
                END)) snap ON (true)$q$;
BEGIN
  IF (SELECT id FROM public.collections WHERE slug = 'laliga_golazos') <> '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid THEN
    RAISE EXCEPTION 'golazos collection id is not the literal this migration inlines';
  END IF;
  n := (length(d) - length(replace(d, old_sec, ''))) / length(old_sec);
  IF n <> 1 THEN RAISE EXCEPTION 'secondary block matched % times', n; END IF;
  d := replace(d, old_sec, new_sec);
  n := (length(d) - length(replace(d, old_ask, ''))) / length(old_ask);
  IF n <> 1 THEN RAISE EXCEPTION 'secondary_ask matched % times', n; END IF;
  d := replace(d, old_ask, new_ask);
  n := (length(d) - length(replace(d, old_pas, ''))) / length(old_pas);
  IF n <> 1 THEN RAISE EXCEPTION 'pas lateral matched % times', n; END IF;
  d := replace(d, old_pas, new_pas);
  d := rtrim(d);
  IF right(d, 1) = ';' THEN d := left(d, length(d) - 1); END IF;
  d := d || snap_join;
  EXECUTE 'CREATE OR REPLACE VIEW public.pack_table_rows AS ' || d;
END
$mig$;
