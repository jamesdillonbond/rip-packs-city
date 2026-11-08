-- audit_20261107_search_catalog_alias_match_ignores_punctuation
--
-- 2026-11-07 ~5:50 PM PT (Cowork cloud). Trevor, 5:33 PM: search and the
-- concierge must "help users either way" after today's renames.
--
-- WHAT WAS WRONG. The alias arm of rpc_search_catalog compares
-- replace(alias_slug, '-', ' ') with the RAW query, so any punctuation in what
-- the collector typed broke the match: "maya caldwell-ellwanger" returned NO
-- player (alias slug maya-caldwell-ellwanger → "maya caldwell ellwanger" vs the
-- query's hyphen), "skylar diggins-smith" missed Top Shot's Skylar Diggins, and
-- "kenyon martin jr." could not equal the alias "kenyon-martin-jr-". Names that
-- change usually change by a hyphen or a suffix, so old spellings were the ones
-- that failed.
--
-- CHANGE (three expressions — find, exact, prefix — each asserted once):
--   find   the token patterns have every run of punctuation turned into a space
--          before matching the dash-to-space alias;
--   exact  the alias slug (outer dashes trimmed) equals the query slugged the
--          same way the alias was;
--   prefix the alias slug starts with the anchor slugged the same way.
-- Name matching is untouched; only the alias arm changes.
--
-- HOW: in-place splice of the LIVE body (see 20261107182853, 20261108000914).
--
-- anon-exec: unchanged (rpc_search_catalog) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon EXECUTE false).
--
-- REVERT: the same DO block with old/new swapped.

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.rpc_search_catalog(text,uuid,integer)'::regprocedure);
  o1 text := $o$AND replace(a.alias_slug, '-', ' ') LIKE ALL (v_pats_a))$o$;
  n1 text := $n$AND replace(a.alias_slug, '-', ' ') LIKE ALL (ARRAY(SELECT regexp_replace(x, '[^a-z0-9%]+', ' ', 'g') FROM unnest(v_pats_a) x)))$n$;
  o2 text := $o$AND replace(a.alias_slug, '-', ' ') = v_qa)) AS exact,$o$;
  n2 text := $n$AND btrim(a.alias_slug, '-') = btrim(regexp_replace(v_qa, '[^a-z0-9]+', '-', 'g'), '-'))) AS exact,$n$;
  o3 text := $o$AND replace(a.alias_slug, '-', ' ') LIKE v_anchor_a || '%')) AS prefix$o$;
  n3 text := $n$AND btrim(a.alias_slug, '-') LIKE btrim(regexp_replace(v_anchor_a, '[^a-z0-9]+', '-', 'g'), '-') || '%')) AS prefix$n$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, o1, ''))) / length(o1);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'find expression found % times, want 1', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, o2, ''))) / length(o2);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'exact expression found % times, want 1', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, o3, ''))) / length(o3);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'prefix expression found % times, want 1', v_hits; END IF;
  EXECUTE replace(replace(replace(v_def, o1, n1), o2, n2), o3, n3);
END
$mig$;
