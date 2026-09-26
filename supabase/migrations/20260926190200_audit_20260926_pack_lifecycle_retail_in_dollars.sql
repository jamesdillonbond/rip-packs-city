-- 2026-09-26 (PT) — get_pack_lifecycle reports a drop's retail in DOLLARS.
--
-- It divided EVERY retail_price_usd by 1e8, but only 109 of 810 priced Top Shot
-- drops are stored in UFix64 units; a normal $9.99 drop rendered "$0.00 retail"
-- on the public pack page (/[collection]/pack/[id]) and its OG card. Now
-- pack_retail_usd() (20260926190000): >= 1,000,000 -> /1e8, else dollars.
-- Guarded splice (the anchor must match exactly once); header and ACL unchanged.
-- anon-exec: unchanged (get_pack_lifecycle) — body splice of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-26).
--
-- Revert: the same splice with the two strings swapped.

DO $do$
DECLARE v text; n int;
  a constant text := $h$'retail_price_usd', (pd.metadata->>'retail_price_usd')::numeric / 100000000.0,$h$;
  b constant text := $h$'retail_price_usd', public.pack_retail_usd(pd.metadata->>'retail_price_usd'),$h$;
BEGIN
  SELECT pg_get_functiondef('public.get_pack_lifecycle'::regproc) INTO v;
  n := (length(v) - length(replace(v, a, ''))) / length(a);
  IF n <> 1 THEN RAISE EXCEPTION 'get_pack_lifecycle: anchor matched % times', n; END IF;
  EXECUTE replace(v, a, b);
END
$do$;
