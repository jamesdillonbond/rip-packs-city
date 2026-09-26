-- 2026-09-26 (PT) — get_pack_lifecycle: a Trade Ticket pack's retail is not
-- dollars.
--
-- 37 Top Shot distributions are Trade Ticket packs, bought with Trade Tickets;
-- their retail_price_usd ("10", "100" for Premium) is the ticket price, and the
-- public pack page showed it as "$10.00 retail". Now read through
-- pack_retail_usd(raw, title) (20260926200100): NULL for a Trade Ticket title.
-- Guarded splice (the anchor must match exactly once); header and ACL unchanged.
-- anon-exec: unchanged (get_pack_lifecycle) — body splice of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-26).
--
-- Revert: the same splice with the two strings swapped.

DO $do$
DECLARE v text; n int;
  a constant text := $h$'retail_price_usd', public.pack_retail_usd(pd.metadata->>'retail_price_usd'),$h$;
  b constant text := $h$'retail_price_usd', public.pack_retail_usd(pd.metadata->>'retail_price_usd', pd.title),$h$;
BEGIN
  SELECT pg_get_functiondef('public.get_pack_lifecycle'::regproc) INTO v;
  n := (length(v) - length(replace(v, a, ''))) / length(a);
  IF n <> 1 THEN RAISE EXCEPTION 'get_pack_lifecycle: anchor matched % times', n; END IF;
  EXECUTE replace(v, a, b);
END
$do$;
