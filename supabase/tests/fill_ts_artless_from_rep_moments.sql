-- DB invariant: public.fill_ts_artless_from_rep_moments — pg_cron
-- `rpc-ts-artless-selfheal` @ `37 5 * * *`.
--
-- WHAT IT DOES. Some Top Shot editions carry no `thumbnail_url`, so they render
-- artless across the site. This self-heal FABRICATES a CDN url for them by
-- borrowing a REPRESENTATIVE moment of the same edition and pointing at that
-- moment's asset path.
--
-- ⚠ WHY THAT IS DELICATE. It is a synthesised URL, not an observed one, so the
-- only thing between "the edition finally shows its art" and "the edition shows
-- SOMEONE ELSE'S art" is which moment gets picked as the representative. The
-- three-tier COALESCE is that choice, in order:
--   (a) a moment of this exact edition_key held in wallet_moments_cache,
--   (b) the most RECENT sale of this edition_id,
--   (c) for a `::sub` parallel only, a sibling moment carrying the same
--       subedition_id under the BASE edition key.
-- ⚠ Tier (c) is the one to read twice: it is gated on `t.sub IS NOT NULL`, so it
-- can only fire for a parallel printing, and it matches on subedition_id — the
-- parallel identity — not on the base edition alone. Without that, a parallel
-- would inherit a sibling parallel's or the base printing's art, which is
-- exactly the conflation class this repo keeps paying for.
--
-- THE OTHER PROPERTIES:
--   1. ⚠ `WHERE r.rep IS NOT NULL` — no representative, no row. Without it the
--      concatenation yields a NULL thumbnail and, worse, an audit row claiming a
--      fill that never happened.
--   2. ⚠ FILL-ONLY, TWICE: `thumbnail_url IS NULL` in the candidate CTE AND
--      again in the UPDATE. The catalog walker writes REAL thumbnails
--      concurrently, and the second check is what stops this job overwriting a
--      real url with a synthesised one in the window between the two.
--      ⚠ The UPDATE-side check is therefore a CONCURRENCY backstop and cannot be
--      separated single-threaded: mutating it alone passes, and only dropping
--      BOTH reds. Asserted on the composite, same treatment as the
--      NOT EXISTS / ON CONFLICT pair in attribute_topshot_rips_empirical.
--   3. `video_url = COALESCE(e.video_url, i.new_video_url)` — an existing video
--      always wins. ⚠ REDUNDANT and deliberately NOT asserted: `new_video_url`
--      is itself a `CASE WHEN r.old_video IS NULL`, so it is non-NULL only when
--      there was no video to protect, and REVERSING the COALESCE arguments
--      changes nothing (mutation-confirmed). It becomes load-bearing the moment
--      that CASE is simplified away.
--   4. `external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'` — canonical integer-keyed
--      editions only. The UUID-keyed duplicates CLAUDE.md documents are skipped,
--      which is what keeps this from filling a conflated row.
--   5. Every fill is AUDITED with its old and new values, so it is reversible.
--   6. ⚠ `ON CONFLICT (edition_id) DO NOTHING` makes the audit table a ONCE-ONLY
--      ledger: an edition that already has an audit row is NEVER re-filled.
--      Asserted, because it is a real operational consequence — if a fill is
--      later undone by hand, this job will not redo it.
--   7. The return counts UPDATEs, not audit inserts.
--   8. ⚠ NOT ASSERTED, and worth knowing: `t.sub IS NOT NULL` gating tier (c) is
--      redundant BY CONSTRUCTION for a base edition. Tier (c) requires a sale on
--      `b.external_id = t.base_ext`, which for a base edition IS the edition
--      itself — and any such sale would already have been found by tier (b),
--      which sits above it in the COALESCE. So tier (c) is unreachable for a
--      base edition whether or not the gate is there. The gate documents intent
--      and would matter if the tiers were ever reordered.
--   9. ⚠ Both tier (a) and tier (c) use `LIMIT 1` with NO `ORDER BY`, so the
--      representative is arbitrary among equals. That is fine precisely BECAUSE
--      of the filters: every moment of one edition_key, or of one subedition
--      under one base, shares the same art. It is also why the tier-(c)
--      mutation below flips the subedition to the WRONG one rather than
--      removing the match — an unordered LIMIT 1 can pick the right row by luck,
--      and a mutation that passes by luck proves nothing.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816070000_audit_20260816_snapshot_last_four_scheduled_secdef_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 fc6d9223050d72fcaba35b43a865b064).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  id            uuid,
  external_id   text,
  collection_id uuid,
  thumbnail_url text,
  video_url     text,
  updated_at    timestamptz
);

CREATE TABLE public.wallet_moments_cache (
  collection_id uuid,
  edition_key   text,
  moment_id     text
);

-- ⚠ Column types match LIVE prod, checked against information_schema:
-- sales.nft_id is varchar, topshot_moment_subeditions.nft_id is TEXT (not a
-- numeric id, despite looking like one) and subedition_id is smallint. A first
-- draft made the subedition nft_id a bigint and the join `s.nft_id = ms.nft_id`
-- failed outright — which is the harmless version; a fixture that merely
-- WIDENS a type passes while testing a shape prod cannot produce.
CREATE TABLE public.sales (
  edition_id uuid,
  nft_id     varchar,
  sold_at    timestamptz
);

CREATE TABLE public.topshot_moment_subeditions (
  nft_id        text,
  subedition_id smallint
);

CREATE TABLE public.audit_20260716_ts_artless_cdn_fill (
  edition_id        uuid PRIMARY KEY,
  old_thumbnail_url text,
  new_thumbnail_url text,
  old_video_url     text,
  new_video_url     text
);

-- >>> BEGIN verbatim fill_ts_artless_from_rep_moments (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.fill_ts_artless_from_rep_moments()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE v_total integer := 0;
BEGIN
  WITH t AS (
    SELECT e.id, e.external_id, e.collection_id, e.video_url,
           split_part(e.external_id,'::',1) AS base_ext,
           NULLIF(split_part(e.external_id,'::',2),'')::int AS sub
    FROM public.editions e
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.thumbnail_url IS NULL
      AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ),
  reps AS (
    SELECT t.id AS edition_id, t.video_url AS old_video, COALESCE(
      (SELECT w.moment_id FROM public.wallet_moments_cache w
        WHERE w.collection_id = t.collection_id AND w.edition_key = t.external_id
          AND w.moment_id IS NOT NULL LIMIT 1),
      (SELECT s.nft_id FROM public.sales s
        WHERE s.edition_id = t.id AND s.nft_id IS NOT NULL
        ORDER BY s.sold_at DESC LIMIT 1),
      (SELECT ms.nft_id::text FROM public.topshot_moment_subeditions ms
        JOIN public.sales s ON s.nft_id = ms.nft_id
        JOIN public.editions b ON b.id = s.edition_id
        WHERE t.sub IS NOT NULL AND ms.subedition_id = t.sub
          AND b.collection_id = t.collection_id AND b.external_id = t.base_ext
        LIMIT 1)
    ) AS rep
    FROM t
  ),
  ins AS (
    INSERT INTO public.audit_20260716_ts_artless_cdn_fill
      (edition_id, old_thumbnail_url, new_thumbnail_url, old_video_url, new_video_url)
    SELECT r.edition_id, NULL,
           'https://assets.nbatopshot.com/media/' || r.rep || '/image?width=400',
           r.old_video,
           CASE WHEN r.old_video IS NULL
                THEN 'https://assets.nbatopshot.com/media/' || r.rep || '/video' END
    FROM reps r WHERE r.rep IS NOT NULL
    ON CONFLICT (edition_id) DO NOTHING
    RETURNING edition_id, new_thumbnail_url, new_video_url
  ),
  upd AS (
    UPDATE public.editions e
       SET thumbnail_url = i.new_thumbnail_url,
           video_url = COALESCE(e.video_url, i.new_video_url),
           updated_at = now()
      FROM ins i
     WHERE e.id = i.edition_id AND e.thumbnail_url IS NULL
    RETURNING 1
  )
  SELECT count(*)::int INTO v_total FROM upd;
  RETURN v_total;
END;
$function$;
-- <<< END verbatim fill_ts_artless_from_rep_moments <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set CDN 'https://assets.nbatopshot.com/media/'

\set e1 '''f0000000-0000-0000-0000-000000000001'''
\set e2 '''f0000000-0000-0000-0000-000000000002'''
\set e3 '''f0000000-0000-0000-0000-000000000003'''
\set e4 '''f0000000-0000-0000-0000-000000000004'''
\set e5 '''f0000000-0000-0000-0000-000000000005'''
\set e6 '''f0000000-0000-0000-0000-000000000006'''
\set e7 '''f0000000-0000-0000-0000-000000000007'''
\set e8 '''f0000000-0000-0000-0000-000000000008'''
\set eBase '''f0000000-0000-0000-0000-0000000000ba'''
\set e10 '''f0000000-0000-0000-0000-000000000010'''

INSERT INTO public.editions (id, external_id, collection_id, thumbnail_url, video_url) VALUES
  (:e1::uuid, '10:1',         :TS::uuid, NULL, NULL),             -- tier (a)
  (:e2::uuid, '10:2',         :TS::uuid, NULL, NULL),             -- tier (b)
  (:e3::uuid, '10:3::7',      :TS::uuid, NULL, NULL),             -- tier (c), a parallel
  (:e4::uuid, '10:4',         :TS::uuid, NULL, NULL),             -- no representative
  (:e5::uuid, '10:5',         :TS::uuid, 'https://real/art', NULL),   -- already has art
  (:e6::uuid, '10:6',         :TS::uuid, NULL, 'https://real/video'), -- already has video
  (:e7::uuid, 'abc-uuid-key', :TS::uuid, NULL, NULL),             -- non-canonical key
  (:e8::uuid, '10:8',         :AD::uuid, NULL, NULL),             -- another collection
  (:eBase::uuid, '10:3',      :TS::uuid, 'https://base/art', NULL),   -- the BASE of e3
  -- ⚠ e10 is a parallel of a DIFFERENT play, carrying the SAME subedition_id 7.
  -- Its own base ('20:1') has no sales, so tier (c) must find nothing. Without
  -- `b.external_id = t.base_ext` it would inherit the 10:3 parallel's art — a
  -- completely different play's image on this edition. Deterministic because
  -- eBase's 4242 is then the only sub-7 candidate in the table.
  (:e10::uuid, '20:1::7',     :TS::uuid, NULL, NULL);

-- Tier (a) source. ⚠ The second row is a wmc moment under a DIFFERENT
-- edition_key: it must not be picked up by anything, which is what pins the
-- edition_key join rather than a bare collection match.
-- ⚠ The last two rows are what make the KEY-SHAPE and COLLECTION filters
-- observable. Without them both mutations pass, because a UUID-keyed or All Day
-- edition simply finds no representative and is skipped for the wrong reason.
-- Both are realistic: CLAUDE.md records that `editions` stores the same Top Shot
-- moment under BOTH an integer and a UUID key convention, and wmc rows exist for
-- every collection.
INSERT INTO public.wallet_moments_cache (collection_id, edition_key, moment_id) VALUES
  (:TS::uuid, '10:1',  'MOMENT-A'),
  (:TS::uuid, '99:99', 'WRONG-EDITION'),
  (:TS::uuid, 'abc-uuid-key', 'UUID-DUPE-MOMENT'),
  -- ⚠ e5 already HAS art, and it needs a representative for the candidate-side
  -- `thumbnail_url IS NULL` to be observable at all: without one it is skipped
  -- for lack of a rep rather than for already being filled, and the mutation
  -- passes for the wrong reason.
  (:TS::uuid, '10:5',  'MOMENT-E5'),
  (:AD::uuid, '10:8',  'ALLDAY-MOMENT');

-- Tier (b): two sales on e2, and the MOST RECENT must win — the oldest would
-- produce a URL that looks every bit as valid.
-- The last two are tier (c)'s source: sales on the BASE edition whose nft_ids
-- carry subeditions 7 and 8. Only 7 is e3's parallel.
INSERT INTO public.sales (edition_id, nft_id, sold_at) VALUES
  (:e2::uuid,    'SALE-OLD', '2026-01-01T00:00:00Z'),
  (:e2::uuid,    'SALE-NEW', '2026-06-01T00:00:00Z'),
  (:eBase::uuid, '4242',     '2026-05-01T00:00:00Z'),
  (:eBase::uuid, '9999',     '2026-05-02T00:00:00Z');

-- ⚠ 9999 is inserted FIRST deliberately: an unfiltered `LIMIT 1` has no ORDER
-- BY, so a seq scan tends to return it first. Without that, dropping the
-- `ms.subedition_id = t.sub` match could still happen to pick the right row and
-- the mutation would pass for a reason that has nothing to do with correctness.
INSERT INTO public.topshot_moment_subeditions (nft_id, subedition_id) VALUES
  ('9999', 8),
  ('4242', 7);

SELECT _assert_eq(
  public.fill_ts_artless_from_rep_moments()::text, '3',
  'exactly the three editions with a resolvable representative are filled'
);

-- ── The three tiers, in order ───────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT thumbnail_url FROM public.editions WHERE id = :e1::uuid),
  :'CDN' || 'MOMENT-A/image?width=400',
  'tier (a): a cached wallet moment of the SAME edition_key is the first choice'
);

SELECT _assert_eq(
  (SELECT thumbnail_url FROM public.editions WHERE id = :e2::uuid),
  :'CDN' || 'SALE-NEW/image?width=400',
  'tier (b): the MOST RECENT sale wins — the oldest would look just as valid'
);

-- ⚠ Tier (c) is the parallel-conflation guard. Matching subedition_id 7 (not the
-- sibling 8) is what stops a parallel inheriting another parallel's art, and the
-- `t.sub IS NOT NULL` gate is what stops a BASE edition using this path at all.
SELECT _assert_eq(
  (SELECT thumbnail_url FROM public.editions WHERE id = :e3::uuid),
  :'CDN' || '4242/image?width=400',
  'tier (c): a parallel borrows the sibling with the SAME subedition_id, never any base moment'
);

-- ── No representative means no URL, and no audit row ────────────────────────
SELECT _assert_eq(
  (SELECT coalesce(thumbnail_url,'NULL') FROM public.editions WHERE id = :e4::uuid),
  'NULL',
  'an edition with NO representative is left alone — a URL is never built around a NULL'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.audit_20260716_ts_artless_cdn_fill WHERE edition_id = :e4::uuid),
  '0',
  '...and no audit row claims a fill that never happened'
);

-- ── Fill-only, in both directions ───────────────────────────────────────────
SELECT _assert_eq(
  (SELECT thumbnail_url FROM public.editions WHERE id = :e5::uuid),
  'https://real/art',
  'a REAL thumbnail is never replaced by a synthesised one'
);

-- ⚠ And it is not merely that the VALUE survives: an edition that already has
-- art must not get an AUDIT ROW either. Without the candidate-side
-- `thumbnail_url IS NULL` it would be audited as filled while the UPDATE
-- re-check silently declined — a ledger entry for work that never happened, and
-- (because the audit table is a once-only ledger, below) a permanent block on
-- ever filling that edition later.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.audit_20260716_ts_artless_cdn_fill WHERE edition_id = :e5::uuid),
  '0',
  'an edition that already has art is never even AUDITED as filled'
);

SELECT _assert_eq(
  (SELECT coalesce(video_url,'NULL') FROM public.editions WHERE id = :e6::uuid),
  'https://real/video',
  'an existing video always wins — COALESCE, not an overwrite'
);

SELECT _assert_eq(
  (SELECT video_url FROM public.editions WHERE id = :e1::uuid),
  :'CDN' || 'MOMENT-A/video',
  '...but a MISSING video is synthesised from the same representative'
);

-- ── Scoping ─────────────────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.editions
    WHERE id IN (:e7::uuid, :e8::uuid) AND thumbnail_url IS NOT NULL),
  '0',
  'a non-canonical (UUID-shaped) key and another collection are both skipped, even though both HAVE a wmc moment'
);

-- ⚠ The base-key match in tier (c). e10 is a parallel of a different play with
-- the same subedition_id; its own base has no sales, so it must stay artless
-- rather than borrow the 10:3 parallel's image.
SELECT _assert_eq(
  (SELECT coalesce(thumbnail_url,'NULL') FROM public.editions WHERE id = :e10::uuid),
  'NULL',
  'a parallel whose OWN base has no moments does not borrow a same-subedition moment of a DIFFERENT play'
);

-- ── The audit table is a ONCE-ONLY ledger ───────────────────────────────────
-- ⚠ A real operational consequence, not trivia: `ON CONFLICT (edition_id) DO
-- NOTHING` makes the audit row itself the "already handled" marker, so if a fill
-- is ever undone by hand this job will NOT redo it.
UPDATE public.editions SET thumbnail_url = NULL WHERE id = :e1::uuid;

SELECT _assert_eq(
  public.fill_ts_artless_from_rep_moments()::text, '0',
  'an edition whose fill was manually undone is NOT re-filled — the audit row is the ledger'
);

SELECT _assert_eq(
  (SELECT coalesce(thumbnail_url,'NULL') FROM public.editions WHERE id = :e1::uuid),
  'NULL',
  '...so it stays artless until the audit row is cleared too'
);

ROLLBACK;
