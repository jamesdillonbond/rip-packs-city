-- DB invariant: public.attribute_topshot_rips_empirical — pg_cron jobid 64
-- `rpc-attribute-pack-rips-empirical` @ `10 3 * * *`, called with 20000.
--
-- WHAT IT DOES. It INFERS which pack distribution an unattributed Top Shot rip
-- came from, by matching the rip's editions against the edition pools observed
-- in rips whose distribution is already KNOWN.
--
-- ⚠ WHY THE STAKES ARE HIGH. Rip attribution feeds pack EV, and pack EV drives a
-- PUBLIC +EV buy signal. A rip attached to the wrong distribution pollutes that
-- distribution's pull history and moves a number collectors act on. Live split
-- (2026-08-16): `rip_dist`/high 36,464 · `empirical_subset`/medium 1,001 — so
-- this function contributes ~2.7% of attributions, and every one of them is an
-- INFERENCE sitting beside 36k observations.
--
-- ── THE FIVE PROPERTIES THAT KEEP AN INFERENCE HONEST ──────────────────────
--
--   1. ⚠ NO FEEDBACK LOOP — the single most important line, and the easiest to
--      "simplify" away. `dist_support` and `emp_pool` read `method = 'rip_dist'`
--      ONLY, so the reference pools are built exclusively from GROUND TRUTH and
--      never from this function's own output. Widen either to all methods and
--      each inference becomes evidence for the next: one bad attribution
--      compounds outward through the pools with nothing to stop it, and the more
--      the job runs the more confident it gets about its own mistakes.
--   2. `HAVING count(*) >= 20` — a distribution whose observed pool is thin is
--      not used as a reference. Its pool is mostly unknown, so a candidate rip
--      could not meaningfully FAIL to match it, and it would swallow rips.
--   3. `rc ... HAVING count(*) >= 2` — a rip with ONE known edition is not
--      identifying and is skipped.
--   4. `p.matched = rc.n` — EVERY edition in the rip must appear in that
--      distribution's pool. A partial match is not a match.
--   5. ⚠ `uniq ... HAVING count(*) = 1` — a rip that fully matches MORE THAN ONE
--      distribution is left UNATTRIBUTED rather than assigned to one of them.
--      ⚠ `min(dist_id)` is only reachable once that HAVING has proved there is
--      exactly one candidate: it is a syntactic requirement of the GROUP BY, NOT
--      a tie-break. Reading it as a tie-break is the mistake to avoid — the same
--      note the bridge_pinnacle_sales_editions pin carries.
--
-- AND THE SUPPORTING ONES:
--   • an existing attribution is never overwritten, so a high-confidence
--     `rip_dist` row always survives a re-run. ⚠ TWO mechanisms enforce that and
--     they MASK EACH OTHER: `cand`'s `NOT EXISTS` keeps an attributed rip out of
--     the candidate set, and `ON CONFLICT (rip_id) DO NOTHING` catches it if it
--     gets there anyway. Mutating either ALONE changes nothing observable, and
--     both survived until the composite was tried; dropping BOTH reds. Unlike the
--     two method filters below, this pair CANNOT be separated in a
--     single-threaded rolled-back test — the ON CONFLICT only becomes
--     load-bearing under concurrency (two overlapping runs, or a `rip_dist` row
--     landing between the `cand` scan and the INSERT), which this harness cannot
--     produce. So the assertion is deliberately on the composite: at least one
--     guard is doing the work, and the redundancy is recorded rather than
--     asserted away.
--   • the rows are labelled `empirical_subset` / `medium`, NOT `rip_dist` /
--     `high` — a consumer can tell an inference from an observation, and it is
--     also what keeps property 1 enforceable at all.
--   • `v_safe` clamps the caller's limit at BOTH ends (NULL -> 8000, then
--     1..20000). The live cron passes exactly 20000, i.e. it sits ON the ceiling.
--   • collection-scoped to Top Shot on the candidate scan and on both `moments`
--     joins.
--
-- ⚠ NOT ASSERTED, and recorded so nobody mistakes the omission for a gap:
-- `ORDER BY random()` in the candidate CTE. It is a sampling choice, not a
-- correctness property — every fixture here sits under the limit, so the order
-- is unobservable. What it means operationally is that a backlog is worked in
-- random order rather than oldest-first, so no rip is starved indefinitely.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816040000_audit_20260816_snapshot_attribute_topshot_rips_empirical.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 1fea4ad6bec5386fdae1688106e0b268).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.topshot_pack_rip_attribution (
  rip_id        uuid PRIMARY KEY,
  dist_id       text NOT NULL,
  method        text NOT NULL,
  confidence    text NOT NULL,
  n_editions    integer,
  attributed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pack_rips (
  id            uuid,
  collection_id uuid,
  dist_id       text
);

CREATE TABLE public.moment_acquisitions (
  nft_id             text,
  source_pack_rip_id uuid
);

CREATE TABLE public.moments (
  nft_id        text,
  collection_id uuid,
  edition_id    uuid
);

-- >>> BEGIN verbatim attribute_topshot_rips_empirical (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.attribute_topshot_rips_empirical(p_limit integer DEFAULT 8000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cid uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_inserted int := 0;
  v_safe int := LEAST(GREATEST(COALESCE(p_limit,8000),1),20000);
BEGIN
  WITH
  dist_support AS (
    SELECT dist_id FROM public.topshot_pack_rip_attribution
    WHERE method='rip_dist' GROUP BY 1 HAVING count(*) >= 20
  ),
  emp_pool AS (
    SELECT a.dist_id, m.edition_id
    FROM public.topshot_pack_rip_attribution a
    JOIN dist_support ds ON ds.dist_id = a.dist_id
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = a.rip_id
    JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = v_cid
    WHERE a.method='rip_dist' AND m.edition_id IS NOT NULL
    GROUP BY 1,2
  ),
  cand AS (
    SELECT r.id FROM public.pack_rips r
    WHERE r.collection_id = v_cid AND r.dist_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.topshot_pack_rip_attribution a WHERE a.rip_id = r.id)
    ORDER BY random()
    LIMIT v_safe
  ),
  re AS (
    SELECT c.id AS rip_id, m.edition_id
    FROM cand c
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = c.id
    JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = v_cid
    WHERE m.edition_id IS NOT NULL
    GROUP BY 1,2
  ),
  rc AS (SELECT rip_id, count(*) n FROM re GROUP BY 1 HAVING count(*) >= 2),
  pair AS (
    SELECT re.rip_id, ep.dist_id, count(*) matched
    FROM re JOIN rc ON rc.rip_id = re.rip_id
    JOIN emp_pool ep ON ep.edition_id = re.edition_id
    GROUP BY 1,2
  ),
  full_match AS (
    SELECT p.rip_id, p.dist_id FROM pair p JOIN rc ON rc.rip_id = p.rip_id
    WHERE p.matched = rc.n
  ),
  uniq AS (
    SELECT rip_id, min(dist_id) AS dist_id FROM full_match GROUP BY rip_id HAVING count(*) = 1
  ),
  ins AS (
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence, n_editions)
    SELECT u.rip_id, u.dist_id, 'empirical_subset', 'medium', rc.n
    FROM uniq u JOIN rc ON rc.rip_id = u.rip_id
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN jsonb_build_object('inserted', v_inserted, 'limit', v_safe, 'finished_at', now());
END;
$function$;
-- <<< END verbatim attribute_topshot_rips_empirical <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''

-- ── Editions ────────────────────────────────────────────────────────────────
-- eA/eB belong to DIST-A's pool; eC/eD to DIST-B's; eS is in BOTH (so a rip made
-- only of shared editions is ambiguous); eX is in no observed pool.
\set eA '''eeee0000-0000-0000-0000-00000000000a'''
\set eB '''eeee0000-0000-0000-0000-00000000000b'''
\set eC '''eeee0000-0000-0000-0000-00000000000c'''
\set eD '''eeee0000-0000-0000-0000-00000000000d'''
\set eS '''eeee0000-0000-0000-0000-00000000000e'''
\set eX '''eeee0000-0000-0000-0000-00000000000f'''

-- ── Reference rips (GROUND TRUTH) ───────────────────────────────────────────
-- DIST-A gets 20 rip_dist rows -> it clears the >= 20 support bar.
-- DIST-B gets 20 as well.
-- DIST-THIN gets 19 -> deliberately ONE SHORT, so it is not a reference.
-- DIST-EMP gets 20 rows but with method 'empirical_subset' -> it is this
--   function's OWN OUTPUT and must NOT become a reference pool (property 1).
DO $seed$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  i int;
  v_rip uuid;
  v_nft text;
BEGIN
  FOR i IN 1..20 LOOP
    -- DIST-A: pool {eA, eB, eS}
    v_rip := ('aaaa0000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid;
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
    VALUES (v_rip, 'DIST-A', 'rip_dist', 'high');
    FOREACH v_nft IN ARRAY ARRAY['A1','A2','A3'] LOOP
      INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id)
      VALUES (v_nft || i::text, v_rip);
    END LOOP;
    INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
      ('A1' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000a'::uuid),
      ('A2' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000b'::uuid),
      ('A3' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000e'::uuid);

    -- DIST-B: pool {eC, eD, eS}
    v_rip := ('bbbb0000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid;
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
    VALUES (v_rip, 'DIST-B', 'rip_dist', 'high');
    INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
      ('B1' || i::text, v_rip), ('B2' || i::text, v_rip), ('B3' || i::text, v_rip);
    INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
      ('B1' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000c'::uuid),
      ('B2' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000d'::uuid),
      ('B3' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000e'::uuid);

    -- DIST-EMP: 20 rows, but INFERRED. Pool {eX} — the ONLY place eX appears.
    v_rip := ('dddd0000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid;
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
    VALUES (v_rip, 'DIST-EMP', 'empirical_subset', 'medium');
    INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id)
    VALUES ('E1' || i::text, v_rip), ('E2' || i::text, v_rip);
    INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
      ('E1' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000f'::uuid),
      ('E2' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000a'::uuid);
  END LOOP;

  -- ⚠ DIST-MIX: 15 rip_dist + 5 empirical_subset = 20 rows TOTAL, but only 15
  -- observations. It exists solely so `dist_support`'s OWN method filter is
  -- observable. Without that fixture the two method filters mask each other —
  -- dropping either one alone changes nothing, because the other still excludes
  -- a wholly-inferred distribution — and a mutation of each passed. Its rip_dist
  -- pool is {eA, eB}, the identifying pair, so if the count were taken over all
  -- methods it would become a second reference and rClean would go ambiguous.
  FOR i IN 1..15 LOOP
    v_rip := ('99990000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid;
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
    VALUES (v_rip, 'DIST-MIX', 'rip_dist', 'high');
    INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id)
    VALUES ('M1-' || i::text, v_rip), ('M2-' || i::text, v_rip);
    INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
      ('M1-' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000a'::uuid),
      ('M2-' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000b'::uuid);
  END LOOP;
  FOR i IN 16..20 LOOP
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
    VALUES (('99990000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
            'DIST-MIX', 'empirical_subset', 'medium');
  END LOOP;

  -- ⚠ One INFERRED row on DIST-A, holding eX — the mirror fixture, making
  -- `emp_pool`'s own method filter observable. DIST-A is eligible on its 20
  -- rip_dist rows regardless, so this row changes nothing today; but if emp_pool
  -- counted all methods, eX would enter DIST-A's pool and rFeed would attribute
  -- to it. That is the feedback loop closing INSIDE an already-eligible
  -- distribution, which the dist_support filter cannot catch.
  INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
  VALUES ('aaaa0000-0000-0000-0000-000000000099'::uuid, 'DIST-A', 'empirical_subset', 'medium');
  INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id)
  VALUES ('A-inf', 'aaaa0000-0000-0000-0000-000000000099'::uuid);
  INSERT INTO public.moments (nft_id, collection_id, edition_id)
  VALUES ('A-inf', v_ts, 'eeee0000-0000-0000-0000-00000000000f'::uuid);

  -- DIST-THIN: 19 rip_dist rows, ONE SHORT of the support bar. Pool {eA, eB}
  -- (identical to DIST-A's identifying pair) — so if the bar were relaxed, the
  -- clean rip below would match TWO distributions and stop being attributable.
  FOR i IN 1..19 LOOP
    v_rip := ('cccc0000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid;
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
    VALUES (v_rip, 'DIST-THIN', 'rip_dist', 'high');
    INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id)
    VALUES ('T1' || i::text, v_rip), ('T2' || i::text, v_rip);
    INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
      ('T1' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000a'::uuid),
      ('T2' || i::text, v_ts, 'eeee0000-0000-0000-0000-00000000000b'::uuid);
  END LOOP;
END $seed$;

-- ── Candidate rips (unattributed) ───────────────────────────────────────────
\set rClean  '''11110000-0000-0000-0000-000000000001'''
\set rAmbig  '''11110000-0000-0000-0000-000000000002'''
\set rOne    '''11110000-0000-0000-0000-000000000003'''
\set rPart   '''11110000-0000-0000-0000-000000000004'''
\set rDone   '''11110000-0000-0000-0000-000000000005'''
\set rWrongC '''11110000-0000-0000-0000-000000000006'''
\set rFeed   '''11110000-0000-0000-0000-000000000007'''

INSERT INTO public.pack_rips (id, collection_id, dist_id) VALUES
  (:rClean::uuid,  :TS::uuid, NULL),  -- {eA,eB}  -> DIST-A only            -> ATTRIBUTED
  (:rAmbig::uuid,  :TS::uuid, NULL),  -- {eS,eS}… shared only               -> ambiguous
  (:rOne::uuid,    :TS::uuid, NULL),  -- {eA}      single edition           -> skipped
  (:rPart::uuid,   :TS::uuid, NULL),  -- {eA,eX}   partial match            -> skipped
  (:rDone::uuid,   :TS::uuid, NULL),  -- already attributed as rip_dist     -> untouched
  (:rWrongC::uuid, :AD::uuid, NULL),  -- another collection                 -> ignored
  (:rFeed::uuid,   :TS::uuid, NULL);  -- {eX}+{eA}: only DIST-EMP holds eX  -> must NOT match

-- rClean: eA + eB. Both in DIST-A's pool; DIST-B has neither.
INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
  ('c-1', :rClean::uuid), ('c-2', :rClean::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('c-1', :TS::uuid, :eA::uuid),
  ('c-2', :TS::uuid, :eB::uuid);

-- rAmbig: eS + eA + eC. eS is in both pools, but eA is A-only and eC is B-only,
-- so neither pool fully contains it… that would be a PARTIAL, not an ambiguity.
-- For a genuine ambiguity the rip must be fully contained in BOTH pools, which
-- takes two shared editions. eS is the only shared one, and a rip needs >= 2
-- distinct editions — so the ambiguity is built from eS plus a second edition
-- seeded into both pools below.
\set eS2 '''eeee0000-0000-0000-0000-000000000010'''
DO $shared$
DECLARE v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  -- add eS2 to BOTH reference pools by attaching it to one existing rip of each
  INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
    ('sh-a', 'aaaa0000-0000-0000-0000-000000000001'::uuid),
    ('sh-b', 'bbbb0000-0000-0000-0000-000000000001'::uuid);
  INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
    ('sh-a', v_ts, 'eeee0000-0000-0000-0000-000000000010'::uuid),
    ('sh-b', v_ts, 'eeee0000-0000-0000-0000-000000000010'::uuid);
END $shared$;

INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
  ('m-1', :rAmbig::uuid), ('m-2', :rAmbig::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('m-1', :TS::uuid, :eS::uuid),
  ('m-2', :TS::uuid, :eS2::uuid);

-- rOne: a single edition. Identifying nothing.
INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES ('o-1', :rOne::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES ('o-1', :TS::uuid, :eA::uuid);

-- rPart: eA is in DIST-A, eX is in no GROUND-TRUTH pool -> partial, not a match.
INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
  ('p-1', :rPart::uuid), ('p-2', :rPart::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('p-1', :TS::uuid, :eA::uuid),
  ('p-2', :TS::uuid, :eX::uuid);

-- rDone: already carries a HIGH-confidence attribution to DIST-B, and a re-write
-- would DOWNGRADE it to empirical_subset/medium.
-- ⚠ Its editions are DIST-B's own (eC+eD), NOT the eA+eB identifying pair. A
-- rip_dist row is itself a reference, so seeding it with eA+eB would put those
-- two into DIST-B's pool and make rClean match BOTH distributions — the whole
-- fixture would then be testing ambiguity rather than what it says it tests.
-- (First draft did exactly that, and rClean silently stopped being attributed.)
INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
VALUES (:rDone::uuid, 'DIST-B', 'rip_dist', 'high');
INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
  ('d-1', :rDone::uuid), ('d-2', :rDone::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('d-1', :TS::uuid, :eC::uuid),
  ('d-2', :TS::uuid, :eD::uuid);

-- rWrongC: an All Day rip whose editions would otherwise match DIST-A cleanly.
INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
  ('w-1', :rWrongC::uuid), ('w-2', :rWrongC::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('w-1', :TS::uuid, :eA::uuid),
  ('w-2', :TS::uuid, :eB::uuid);

-- ⚠ rFeed: {eX, eA}. eX appears ONLY in DIST-EMP, which has 20 rows but they are
-- this function's own INFERENCES. If the reference pools were widened past
-- method='rip_dist', DIST-EMP would become a reference and this rip would be
-- attributed to it — an inference built on an inference.
INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
  ('f-1', :rFeed::uuid), ('f-2', :rFeed::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('f-1', :TS::uuid, :eX::uuid),
  ('f-2', :TS::uuid, :eA::uuid);

SELECT public.attribute_topshot_rips_empirical(8000);

-- ── The one rip that SHOULD be attributed ───────────────────────────────────
SELECT _assert_eq(
  (SELECT dist_id || '/' || method || '/' || confidence || '/' || n_editions
     FROM public.topshot_pack_rip_attribution WHERE rip_id = :rClean::uuid),
  'DIST-A/empirical_subset/medium/2',
  'a rip fully contained in exactly one reference pool is attributed — and LABELLED as an inference'
);

-- ⚠ THE MOST IMPORTANT ASSERTION IN THIS FILE — property 1, no feedback loop.
-- DIST-EMP has 20 rows, enough to clear the support bar on count alone. It is
-- excluded only because its rows are this function's OWN output. Widening either
-- pool CTE past method='rip_dist' makes each inference evidence for the next.
SELECT _assert_eq(
  coalesce((SELECT dist_id FROM public.topshot_pack_rip_attribution
    WHERE rip_id = :rFeed::uuid), 'NONE'),
  'NONE',
  'the reference pools are GROUND TRUTH only — an inferred distribution never becomes evidence'
);

-- ⚠ Property 5 — ambiguity is left unresolved, never guessed. Without the
-- HAVING count(*) = 1 this would silently become min(dist_id) = 'DIST-A', a
-- wrong attribution feeding a public pack-EV number.
SELECT _assert_eq(
  coalesce((SELECT dist_id FROM public.topshot_pack_rip_attribution
    WHERE rip_id = :rAmbig::uuid), 'NONE'),
  'NONE',
  'a rip matching TWO distributions is left UNATTRIBUTED, not assigned to min(dist_id)'
);

SELECT _assert_eq(
  coalesce((SELECT dist_id FROM public.topshot_pack_rip_attribution
    WHERE rip_id = :rOne::uuid), 'NONE'),
  'NONE',
  'a rip with ONE known edition is not identifying and is skipped'
);

-- Property 4 — a partial match is not a match.
SELECT _assert_eq(
  coalesce((SELECT dist_id FROM public.topshot_pack_rip_attribution
    WHERE rip_id = :rPart::uuid), 'NONE'),
  'NONE',
  'EVERY edition must be in the pool — a partial overlap does not attribute'
);

-- ON CONFLICT DO NOTHING: a high-confidence observation is never downgraded to
-- an inference, even though this rip would match DIST-A cleanly.
SELECT _assert_eq(
  (SELECT dist_id || '/' || method || '/' || confidence
     FROM public.topshot_pack_rip_attribution WHERE rip_id = :rDone::uuid),
  'DIST-B/rip_dist/high',
  'an existing attribution is never overwritten — high-confidence ground truth survives'
);

SELECT _assert_eq(
  coalesce((SELECT dist_id FROM public.topshot_pack_rip_attribution
    WHERE rip_id = :rWrongC::uuid), 'NONE'),
  'NONE',
  'another collection is never attributed by the Top Shot job'
);

-- ── The reported count, and idempotence ─────────────────────────────────────
SELECT _assert_eq(
  (public.attribute_topshot_rips_empirical(8000) ->> 'inserted'),
  '0',
  'a second run inserts nothing — the one attributable rip is now attributed'
);

-- ── Property 2 — the support bar, asserted from the other side ──────────────
-- DIST-THIN holds eA+eB, the exact identifying pair, and is excluded ONLY by
-- being one row short of 20. Top it up and rClean now matches TWO reference
-- pools, so a fresh equivalent rip stops being attributable. That is the bar
-- doing its job: a thin pool cannot meaningfully be failed to match, so it would
-- otherwise swallow rips that a well-observed distribution should claim.
\set rClean2 '''11110000-0000-0000-0000-000000000008'''
INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence)
VALUES ('cccc0000-0000-0000-0000-000000000020'::uuid, 'DIST-THIN', 'rip_dist', 'high');
INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id)
VALUES ('T1-20', 'cccc0000-0000-0000-0000-000000000020'::uuid),
       ('T2-20', 'cccc0000-0000-0000-0000-000000000020'::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('T1-20', :TS::uuid, :eA::uuid),
  ('T2-20', :TS::uuid, :eB::uuid);

INSERT INTO public.pack_rips (id, collection_id, dist_id) VALUES (:rClean2::uuid, :TS::uuid, NULL);
INSERT INTO public.moment_acquisitions (nft_id, source_pack_rip_id) VALUES
  ('c2-1', :rClean2::uuid), ('c2-2', :rClean2::uuid);
INSERT INTO public.moments (nft_id, collection_id, edition_id) VALUES
  ('c2-1', :TS::uuid, :eA::uuid),
  ('c2-2', :TS::uuid, :eB::uuid);

SELECT public.attribute_topshot_rips_empirical(8000);

SELECT _assert_eq(
  coalesce((SELECT dist_id FROM public.topshot_pack_rip_attribution
    WHERE rip_id = :rClean2::uuid), 'NONE'),
  'NONE',
  'once DIST-THIN reaches the 20-row bar it becomes a second candidate — the bar is what made rClean unambiguous'
);

-- ── The limit clamp, at both ends ───────────────────────────────────────────
SELECT _assert_eq(
  (public.attribute_topshot_rips_empirical(NULL) ->> 'limit'), '8000',
  'a NULL limit falls back to the default rather than making LIMIT NULL (unbounded)'
);

SELECT _assert_eq(
  (public.attribute_topshot_rips_empirical(0) ->> 'limit'), '1',
  'a zero/negative limit is floored at 1 — LIMIT 0 would make the job a silent no-op'
);

SELECT _assert_eq(
  (public.attribute_topshot_rips_empirical(999999) ->> 'limit'), '20000',
  'the limit is capped at 20000 — the live cron passes exactly that, i.e. it sits ON the ceiling'
);

ROLLBACK;
