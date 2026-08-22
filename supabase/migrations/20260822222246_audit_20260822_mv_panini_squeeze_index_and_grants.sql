-- Unique index REQUIRED for REFRESH ... CONCURRENTLY. Verified before creating: 4,680 rows
-- / 4,680 distinct (player_name, set_name, tier), zero NULLs in any of the three.
-- ⚠ Deliberately NOT adding an index for the fetcher's ORDER BY fmv_usd DESC: at 4,680 rows
-- the sort is sub-millisecond and an extra index is paid on every refresh for ever.
CREATE UNIQUE INDEX mv_panini_squeeze_key
  ON public.mv_panini_squeeze (player_name, set_name, tier);

REVOKE ALL ON public.mv_panini_squeeze FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_squeeze TO postgres, service_role;
