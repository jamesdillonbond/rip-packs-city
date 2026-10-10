-- audit_20261010_topshot_edition_aliases_the_api_key_resolves_to_the_chain_key  (known-issues #175)
--
-- DECIDED 2026-10-10 ~8:40 AM PT (Cowork cloud, under Trevor's "make decisions on these yourself").
-- Top Shot names the 2023-24 Honors (Diced) printing TWO ways: the chain mints it as set 152, subedition 0
-- (`152:<play>`, plays 5366-5390 — checkpoint sporks 25/26/28 + a live `getMomentsSubedition` read, #175),
-- and Top Shot's own API/offer contract names the same moments set 149, parallel 8 (`149:<play>::8`).
-- The 25 `149:<play>::8` editions rows (Stage B, 2026-06-21) are therefore ALIASES, not printings:
-- re-measured 2026-10-10 8:35 AM PT they hold 0 moments, 0 sales, 0 wallet_moments_cache rows, and only the
-- API-fed market — 44 `offers` (14 open, 0 ever filled), 12 `edition_offers` rows (10 asks), 208 ask-only
-- `fmv_snapshots`. The 25 `152:<play>` rows hold every chain-verified moment and sale and 0 offers.
--
-- DIRECTION: the CHAIN key is canonical. Every user-held thing (binder rows, ownership, sales, the
-- checkpoint) resolves there already; only the API-facing lanes mint the alias. So this migration
--   1. creates `public.topshot_edition_aliases(alias_external_id -> canonical_external_id)` — the ONE alias
--      point the API-facing lanes read (`app/api/topshot-offers-indexer`, `app/api/cron/offers-sweep`
--      subedition map, the edition page's 308) and `canonical_topshot_external_id(text)` for SQL readers;
--   2. seeds the 25 Diced pairs — DERIVED by joining on the play id, never hard-coded, and only where the
--      pair is 1:1 and both rows exist;
--   3. re-points the 44 `offers` rows and re-keys the 12 `edition_offers` rows to the canonical edition
--      (no canonical `edition_offers` row exists, so a plain UPDATE; the sweep's next tick upserts there
--      once the code lands), archiving every old value in flowty_archive.audit_20261010_175_alias_rekeys.
-- The alias `fmv_snapshots` / `edition_fmv_current` rows are left to `fmv-recalc`: with no sale and no ask
-- behind them they decay to NO_DATA on their next pass (9 of 25 already had), which is the writer retiring
-- its own claim rather than this migration deleting it; the page 308s to the canonical meanwhile.
--
-- WHAT THIS DOES NOT DO: it does not merge or delete the 25 alias `editions` rows (a FK target of the
-- archived offers and the FMV history), and it does not touch `topshot_moment_subeditions` (#175 §2 moved the
-- two rows that were chain-refuted; the rest agree with the chain).
--
-- Falsifier: a NEW `offers` or `edition_offers` row keyed to a `149:<play>::8` edition after the code deploy
-- (the lane did not consult the alias table), or `select count(*) from topshot_edition_aliases` <> 25.
--
-- REVERT:
--   UPDATE public.offers o SET edition_id = a.old_value::uuid
--     FROM flowty_archive.audit_20261010_175_alias_rekeys a WHERE a.tbl = 'offers' AND a.row_key = o.id::text;
--   UPDATE public.edition_offers eo SET external_id = a.old_value
--     FROM flowty_archive.audit_20261010_175_alias_rekeys a
--     WHERE a.tbl = 'edition_offers' AND a.row_key = eo.collection_id::text || '|' || eo.external_id
--       AND eo.external_id = a.new_value;
--   DROP FUNCTION public.canonical_topshot_external_id(text);
--   DROP TABLE public.topshot_edition_aliases;
--   (keep the archive table until the restore is verified)

CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261010_175_alias_rekeys (
  applied_at timestamptz NOT NULL DEFAULT now(),
  tbl        text        NOT NULL,
  row_key    text        NOT NULL,
  old_value  text        NOT NULL,
  new_value  text        NOT NULL
);

CREATE TABLE IF NOT EXISTS public.topshot_edition_aliases (
  alias_external_id     text        PRIMARY KEY,
  canonical_external_id text        NOT NULL,
  reason                text        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topshot_edition_aliases_not_self CHECK (alias_external_id <> canonical_external_id)
);
COMMENT ON TABLE public.topshot_edition_aliases IS
  'Top Shot edition keys that NAME an edition catalogued under another key (#175: the API''s 149:<play>::8 is the chain''s 152:<play>). API-facing writers resolve through this before keying a row; the edition page 308s an alias to its canonical.';

-- Deny-all RLS (the estate's shape for internal tables); the service role reads it.
ALTER TABLE public.topshot_edition_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_edition_aliases FROM PUBLIC, anon, authenticated;

-- Reverse lookups (which aliases point at this canonical?) and the no-chain check below read this.
CREATE INDEX IF NOT EXISTS topshot_edition_aliases_canonical_idx
  ON public.topshot_edition_aliases (canonical_external_id);

CREATE OR REPLACE FUNCTION public.canonical_topshot_external_id(p_external_id text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT a.canonical_external_id FROM public.topshot_edition_aliases a WHERE a.alias_external_id = p_external_id),
    p_external_id
  );
$$;
-- anon-exec: revoked (canonical_topshot_external_id) — an internal resolver for writers; nothing anon reaches it.
REVOKE EXECUTE ON FUNCTION public.canonical_topshot_external_id(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.canonical_topshot_external_id(text) TO service_role;

-- 2. Seed the 25 Diced pairs, derived from the catalogue.
WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
a AS (
  SELECT e.external_id, split_part(split_part(e.external_id, '::', 1), ':', 2) AS play
  FROM public.editions e, ts
  WHERE e.collection_id = ts.id AND e.external_id ~ '^149:[0-9]+::8$'
    AND e.set_name = '2023-24 Honors'
),
c AS (
  SELECT e.external_id, split_part(e.external_id, ':', 2) AS play
  FROM public.editions e, ts
  WHERE e.collection_id = ts.id AND e.external_id ~ '^152:[0-9]+$'
    AND e.set_name = '2023-24 Honors (Diced)'
),
pairs AS (
  SELECT a.external_id AS alias_external_id, c.external_id AS canonical_external_id
  FROM a JOIN c ON c.play = a.play
  -- 1:1 only: a play with two candidates on either side is NOT an alias we can assert.
  WHERE (SELECT count(*) FROM a a2 WHERE a2.play = a.play) = 1
    AND (SELECT count(*) FROM c c2 WHERE c2.play = a.play) = 1
)
INSERT INTO public.topshot_edition_aliases (alias_external_id, canonical_external_id, reason)
SELECT alias_external_id, canonical_external_id,
       '#175 2026-10-10: Top Shot API names the Diced printing (149, play, parallel 8); the chain mints it as set 152 subedition 0 (checkpoint sporks 25/26/28 + live getMomentsSubedition).'
FROM pairs
ON CONFLICT (alias_external_id) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.topshot_edition_aliases WHERE alias_external_id ~ '^149:[0-9]+::8$';
  IF n <> 25 THEN
    RAISE EXCEPTION 'topshot_edition_aliases: expected 25 Diced pairs, seeded % — catalogue changed, re-derive before applying', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.topshot_edition_aliases x JOIN public.topshot_edition_aliases y ON y.alias_external_id = x.canonical_external_id) THEN
    RAISE EXCEPTION 'topshot_edition_aliases: a canonical is itself an alias (chain) — refuse';
  END IF;
END $$;

-- 3. Re-point the API-fed market rows to the canonical edition, archiving first.
WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
map AS (
  SELECT al.id AS alias_id, ca.id AS canonical_id
  FROM public.topshot_edition_aliases x
  JOIN public.editions al ON al.external_id = x.alias_external_id     AND al.collection_id = (SELECT id FROM ts)
  JOIN public.editions ca ON ca.external_id = x.canonical_external_id AND ca.collection_id = (SELECT id FROM ts)
),
arch AS (
  INSERT INTO flowty_archive.audit_20261010_175_alias_rekeys (tbl, row_key, old_value, new_value)
  SELECT 'offers', o.id::text, o.edition_id::text, m.canonical_id::text
  FROM public.offers o JOIN map m ON m.alias_id = o.edition_id
  RETURNING row_key, new_value
)
UPDATE public.offers o
SET edition_id = arch.new_value::uuid
FROM arch
WHERE o.id = arch.row_key::uuid;

WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
arch AS (
  INSERT INTO flowty_archive.audit_20261010_175_alias_rekeys (tbl, row_key, old_value, new_value)
  SELECT 'edition_offers', eo.collection_id::text || '|' || eo.external_id, eo.external_id, x.canonical_external_id
  FROM public.edition_offers eo
  JOIN public.topshot_edition_aliases x ON x.alias_external_id = eo.external_id
  WHERE eo.collection_id = (SELECT id FROM ts)
    -- a plain re-key only where no canonical row exists yet; otherwise leave it for the sweep's upsert
    AND NOT EXISTS (SELECT 1 FROM public.edition_offers c WHERE c.collection_id = eo.collection_id AND c.external_id = x.canonical_external_id)
  RETURNING row_key, old_value, new_value
)
UPDATE public.edition_offers eo
SET external_id = arch.new_value, updated_at = now()
FROM arch
WHERE eo.collection_id = (SELECT id FROM ts) AND eo.external_id = arch.old_value;

-- Verify (read after apply):
--   select tbl, count(*) from flowty_archive.audit_20261010_175_alias_rekeys group by 1;   -- offers 44, edition_offers 12
--   select count(*) from offers o join editions e on e.id=o.edition_id where e.external_id ~ '^149:[0-9]+::8$';  -- 0
--   select count(*) from edition_offers where external_id ~ '^149:[0-9]+::8$';                                  -- 0
--   select canonical_topshot_external_id('149:5370::8'), canonical_topshot_external_id('152:5370');             -- 152:5370, 152:5370
