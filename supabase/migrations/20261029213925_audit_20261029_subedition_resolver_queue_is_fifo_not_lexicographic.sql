-- 2026-10-29: the on-chain subedition resolver takes its daily batch first-in-first-out, not in TEXT order.
-- get_topshot_subedition_targets() picked `ORDER BY nft_id` — and nft_id is TEXT, so the order is lexicographic, not
-- numeric. The 20260904133105 design ("lowest first", a 10,000 cap on the parallel seeder to leave the recent-series
-- seeder headroom) reasoned about NUMERIC order. Measured 10-29 2:36 PM PT, after the day's 20,000-row run: every one
-- of the 10,000 still-pending rows had an id beginning 4–8 (4,682 × "4…", 5,281 × "5…"), because each day's inflow of
-- "1…"–"3…" ids fills the batch first. The starved tail is the NEWEST Moments (ids 40–53 M: the current series, new
-- parallels) — e.g. the 155 Animated / Illustrated moments queued 10-28 9:55 PM were skipped by today's run.
-- FIX: a queued_at stamp (DEFAULT now(); a STABLE default is a catalog-only change, so existing rows share the migration
-- instant and need no rewrite) and the batch ordered by (queued_at, nft_id). Inflow is ~25k/day against 20k resolved, so
-- the worst wait becomes ~1–2 days for every id, instead of unbounded for the lexicographic tail.
-- The old (nft_id) partial index stays (nothing is dropped); the new partial index serves the new order.
-- anon-exec: unchanged (get_topshot_subedition_targets) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres + service_role, read 10-29).
-- revert: restore `ORDER BY nft_id` in get_topshot_subedition_targets; the column and index are inert without it.

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.topshot_moment_subeditions ADD COLUMN IF NOT EXISTS queued_at timestamptz NOT NULL DEFAULT now();
COMMENT ON COLUMN public.topshot_moment_subeditions.queued_at IS
  'When the nft was queued for the on-chain subedition read. get_topshot_subedition_targets() resolves oldest first.';

CREATE INDEX IF NOT EXISTS idx_ts_moment_subeditions_pending_fifo
  ON public.topshot_moment_subeditions (queued_at, nft_id) WHERE subedition_id IS NULL;

CREATE OR REPLACE FUNCTION public.get_topshot_subedition_targets(p_limit integer DEFAULT 5000)
 RETURNS text[]
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- 2026-10-29: first-in-first-out. nft_id is TEXT; ordering by it starved every id that sorts late (the newest Moments).
  SELECT coalesce(array_agg(nft_id ORDER BY queued_at, nft_id), '{}')
  FROM (
    SELECT nft_id, queued_at FROM public.topshot_moment_subeditions
    WHERE subedition_id IS NULL
    ORDER BY queued_at, nft_id
    LIMIT greatest(1, least(p_limit, 50000))
  ) t;
$function$;
