-- audit_20261020_market_edition_arms_floor_ask_verified_at
--
-- 2026-10-20 (Claude Code cloud; Trevor: "work on roadmap items and known issues").
-- All Day roadmap, Next: "Market tab: restore an ask age on All Day / Golazos
-- edition rows". Since 20261021003446 those rows carry NO age stamp: their only
-- timestamp was `last_listed_at`, the edition's NEWEST listing, which never
-- described the floor shown, and both arms' stamp kind is "checked".
--
-- get_allday_market_editions_v4 / get_golazos_market_editions_v2 = the live
-- get_allday_market_editions_v3 / get_golazos_market_editions, read via
-- pg_get_functiondef and spliced at guarded anchors, plus ONE trailing column:
--   floor_ask_verified_at timestamptz
--     = (array_agg(cl.verified_at ORDER BY cl.price_usd, cl.verified_at DESC NULLS LAST))[1]
-- inside the existing per-edition aggregate, i.e. the freshest on-chain
-- verification among the open rows AT the floor price (the storefront_v2 /
-- direct_v2 twins of one listing share a price, so the twin rule of
-- allday_edition_floor_ask.floor_ask_verified_at holds). Same filtered row set
-- as min(price_usd), so the stamp always describes the floor in `floor_ask`.
-- NULL when no floor row has ever been verified; the client then renders no
-- stamp (askAgeHours null = no marker, never "fresh").
-- New NAMES rather than a re-signature: a new OUT column needs DROP, which the
-- MCP holds in a headless session. The old functions keep their other caller
-- (lib/concierge/catalog-deals-index.ts reads v3) and are unchanged.
--
-- Measured before apply (2026-10-20 ~7:55 PM PT): floor rows with a verified_at:
-- All Day 4,393 / 4,413 editions (median age 1.5 h; 1,014 older than 12 h, the
-- weekly-verified V1 rows of #198), Golazos 496 / 496 (median 2.0 h).
--
-- anon-exec: revoked (get_allday_market_editions_v4) — new fn; postgres/service_role only, matching v3 (service_role only, verified proacl).
-- anon-exec: revoked (get_golazos_market_editions_v2) — new fn; service_role only, matching get_golazos_market_editions (verified proacl).
-- anon-exec: unchanged (get_allday_market_editions_v3) — only READ here (anchor text); not created, replaced or re-granted.
-- anon-exec: unchanged (get_golazos_market_editions) — only READ here (anchor text); not created, replaced or re-granted.
--
-- REVERT: point lib/market/edition-market-arms.ts back at the old names;
--   DROP FUNCTION public.get_allday_market_editions_v4(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text);
--   DROP FUNCTION public.get_golazos_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text);

DO $mig$
DECLARE
  def text;
  anc text;
  n   int;
  ret_old constant text := 'last_listed_at timestamp with time zone)';
  ret_new constant text := 'last_listed_at timestamp with time zone, floor_ask_verified_at timestamp with time zone)';
  fv constant text := '(array_agg(cl.verified_at ORDER BY cl.price_usd, cl.verified_at DESC NULLS LAST))[1] AS fv_at';
BEGIN
  -- ── All Day (plpgsql; two paths, each with its own agg) ──
  SELECT pg_get_functiondef('public.get_allday_market_editions_v3(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text)'::regprocedure)
    INTO def;

  anc := 'CREATE OR REPLACE FUNCTION public.get_allday_market_editions_v3(';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'allday name anchor found % times, want 1', n; END IF;
  def := replace(def, anc, 'CREATE FUNCTION public.get_allday_market_editions_v4(');

  n := (length(def) - length(replace(def, ret_old, ''))) / length(ret_old);
  IF n <> 1 THEN RAISE EXCEPTION 'allday return anchor found % times, want 1', n; END IF;
  def := replace(def, ret_old, ret_new);

  anc := E'max(cl.listed_at)    AS last_listed_at\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 2 THEN RAISE EXCEPTION 'allday agg anchor found % times, want 2', n; END IF;
  def := replace(def, anc, E'max(cl.listed_at)    AS last_listed_at,\n             ' || fv || E'\n');

  anc := E'g.floor_ask AS f_ask, g.listed_count AS l_count, g.last_listed_at AS ll_at\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'allday top anchor found % times, want 1', n; END IF;
  def := replace(def, anc, E'g.floor_ask AS f_ask, g.listed_count AS l_count, g.last_listed_at AS ll_at, g.fv_at AS fv_at\n');

  anc := E't.thumbnail_url::text, t.badges, t.ll_at\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'allday fast select anchor found % times, want 1', n; END IF;
  def := replace(def, anc, E't.thumbnail_url::text, t.badges, t.ll_at, t.fv_at\n');

  anc := E'e.thumbnail_url::text, e.badges, g.last_listed_at\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'allday fmv select anchor found % times, want 1', n; END IF;
  def := replace(def, anc, E'e.thumbnail_url::text, e.badges, g.last_listed_at, g.fv_at\n');

  EXECUTE def;

  -- ── Golazos (sql) ──
  SELECT pg_get_functiondef('public.get_golazos_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text)'::regprocedure)
    INTO def;

  anc := 'CREATE OR REPLACE FUNCTION public.get_golazos_market_editions(';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'golazos name anchor found % times, want 1', n; END IF;
  def := replace(def, anc, 'CREATE FUNCTION public.get_golazos_market_editions_v2(');

  n := (length(def) - length(replace(def, ret_old, ''))) / length(ret_old);
  IF n <> 1 THEN RAISE EXCEPTION 'golazos return anchor found % times, want 1', n; END IF;
  def := replace(def, ret_old, ret_new);

  anc := E'max(cl.listed_at)  AS last_listed_at\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'golazos agg anchor found % times, want 1', n; END IF;
  def := replace(def, anc, E'max(cl.listed_at)  AS last_listed_at,\n           ' || fv || E'\n');

  anc := E'e.badges AS bdg, g.last_listed_at AS ll_at\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'golazos rows anchor found % times, want 1', n; END IF;
  def := replace(def, anc, E'e.badges AS bdg, g.last_listed_at AS ll_at, g.fv_at AS fv_at\n');

  anc := E'r.fmv, r.disc, r.conf, r.thumb, r.bdg, r.ll_at\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'golazos select anchor found % times, want 1', n; END IF;
  def := replace(def, anc, E'r.fmv, r.disc, r.conf, r.thumb, r.bdg, r.ll_at, r.fv_at\n');

  EXECUTE def;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.get_allday_market_editions_v4(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_market_editions_v4(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) TO postgres, service_role;
REVOKE EXECUTE ON FUNCTION public.get_golazos_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_golazos_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) TO postgres, service_role;
