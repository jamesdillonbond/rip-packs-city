-- audit_20260923_candy_treasury_check_compares_the_label_not_the_heuristic
--
-- Follows 20260923233939, which made the Candy treasury label the SEALED-PACK custodian. This
-- check compared the old moment-count argmax with the pack argmax. Under the new definition that
-- pair can differ while the label is correct — today it does: moment argmax 1BWutmTv…DNix
-- (1,789) vs pack custodian BhA2Bfd8…APe2 (2,332 of 2,501 packs) — so the check would read
-- `diverged: true` forever. A permanently red instrument is indistinguishable from a broken one.
--
-- NEW SEMANTICS:
--   * `diverged`    — the PUBLISHED label (candy_treasury_wallet, what the boards exclude) is not
--                     the current pack custodian. This is the failure that mislabels a collector.
--   * `packs_stale` — candy_packs was not walked in the last 48 h, so the custodian itself can no
--                     longer be trusted (all 2,501 rows carried today's last_seen_at on 09-23,
--                     i.e. the table is a refreshed census, not add-only history — that freshness
--                     is what makes it a sound primary signal; `is_burnt` is never set).
--   * `moment_argmax_differs` — informational: the old heuristic disagrees. Expected while a
--                     second large holder exists; it no longer implies a mislabel.
-- Same signature and return type (jsonb); CREATE OR REPLACE keeps SECURITY DEFINER / ACL.
--
-- REVERT: re-apply the body from 20260812032227 (audit_20260811_edge_fn_http_error_arm_and_candy_treasury_crosscheck).
--
-- anon-exec: unchanged (check_candy_treasury_divergence) — CREATE OR REPLACE of an existing fn keeps its ACL; verified proacl postgres + service_role only on 2026-09-23.

CREATE OR REPLACE FUNCTION public.check_candy_treasury_divergence()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $fn$
  WITH label AS (
    SELECT wallet_address FROM public.candy_treasury_wallet
  ),
  packs_argmax AS (
    SELECT owner, count(*) AS packs
    FROM public.candy_packs
    WHERE owner IS NOT NULL
    GROUP BY owner
    ORDER BY count(*) DESC, owner
    LIMIT 1
  ),
  wmc_argmax AS (
    SELECT wallet_address, count(*) AS serials
    FROM public.wallet_moments_cache
    WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    GROUP BY wallet_address
    ORDER BY count(*) DESC
    LIMIT 1
  ),
  packs_meta AS (
    SELECT count(*) AS total_packs, max(last_seen_at) AS last_seen FROM public.candy_packs
  )
  SELECT jsonb_build_object(
    'diverged',              (SELECT wallet_address FROM label) IS DISTINCT FROM (SELECT owner FROM packs_argmax),
    'label',                 (SELECT wallet_address FROM label),
    'packs_argmax',          (SELECT owner FROM packs_argmax),
    'packs_held',            (SELECT packs FROM packs_argmax),
    'packs_total',           (SELECT total_packs FROM packs_meta),
    'packs_last_seen',       (SELECT last_seen FROM packs_meta),
    'packs_stale',           COALESCE((SELECT last_seen FROM packs_meta) < now() - interval '48 hours', true),
    'moment_argmax_differs', (SELECT wallet_address FROM wmc_argmax) IS DISTINCT FROM (SELECT owner FROM packs_argmax),
    'wmc_argmax',            (SELECT wallet_address FROM wmc_argmax),
    'wmc_serials',           (SELECT serials FROM wmc_argmax),
    'note', 'Since 20260923233939 the Candy treasury label (candy_treasury_wallet, excluded by candy_holder_board and treated as sealed supply by candy_scarcity_board) is the wallet holding the most SEALED PACKS in candy_packs. diverged = the published label is not the current pack custodian (a refresh has not run, or the fallback moment-argmax was used). packs_stale = candy_packs has not been walked in 48 h, so the custodian itself is unproven. moment_argmax_differs is informational only.'
  );
$fn$;
