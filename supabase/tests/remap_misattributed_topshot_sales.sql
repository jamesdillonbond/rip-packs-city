-- DB invariant: public.remap_misattributed_topshot_sales() → integer
-- — the TopShot sales re-keying sweep, and the widest-blast member of the
-- parallel-conflation family: it rewrites BOTH edition_id and serial_number on
-- `sales`, which every edition-keyed FMV is derived from.
--
-- Pins the three properties that are not obvious from reading the body:
--
--   1. ROTATION. The sweep deliberately does NOT scan all of sales. It covers a
--      fresh 4-day window plus ONE rotating 2-day slice selected by the cursor in
--      remap_sweep_state (14 slices → 32 days). A sale in the GAP between the
--      fresh window and the current slice is legitimately left alone — so a
--      regression that widened or dropped the windows would present as "more rows
--      fixed", not as a failure.
--   2. AMBIGUITY IS DROPPED, NOT GUESSED. `having count(distinct edition_key) = 1`
--      excludes any moment whose wmc rows disagree. Without it such a moment is
--      re-keyed on EVERY run, oscillating between editions and rewriting sale
--      history each time — a defect that never converges and never errors.
--   3. SERIAL COLLISIONS ARE DROPPED. dup_pairs removes any (edition_key, serial)
--      mapping to more than one moment, so a sale is never attributed to a serial
--      that is not uniquely identified.
--
-- The cursor advance is the FIRST statement and is deliberately not conditional
-- on the scan succeeding: a slice that throws must still advance, or one poison
-- slice wedges the rotation permanently.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260815161000_audit_20260815_snapshot_remap_misattributed_topshot_sales.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
);

CREATE TABLE sales (
  id            bigint,
  collection_id uuid,
  nft_id        text,
  edition_id    uuid,
  serial_number integer,
  sold_at       timestamptz
);

CREATE TABLE wallet_moments_cache (
  collection_id uuid,
  moment_id     text,
  edition_key   text,
  serial_number integer
);

CREATE TABLE remap_sweep_state (
  slice_no      integer,
  last_run_at   timestamptz,
  last_cycle_at timestamptz
);

-- >>> BEGIN verbatim remap_misattributed_topshot_sales (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.remap_misattributed_topshot_sales()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  n integer;
  v_t_start    timestamptz := now();   -- captured BEFORE the scan
  v_slice      integer;
  v_fresh_from timestamptz;
  v_slice_from timestamptz;
  v_slice_to   timestamptz;
  c_fresh_days constant integer := 4;
  c_slice_days constant integer := 2;
  c_slices     constant integer := 14;  -- 4 + 14*2 = 32 days total coverage
begin
  -- claim this run's slice and advance the rotation cursor
  update public.remap_sweep_state
     set slice_no      = (slice_no + 1) % c_slices,
         last_run_at   = v_t_start,
         last_cycle_at = case when (slice_no + 1) % c_slices = 0
                              then v_t_start else last_cycle_at end
   returning slice_no into v_slice;

  v_slice := coalesce(v_slice, 0);

  v_fresh_from := v_t_start - make_interval(days => c_fresh_days);
  v_slice_from := v_t_start - make_interval(days => c_fresh_days + (v_slice + 1) * c_slice_days);
  v_slice_to   := v_t_start - make_interval(days => c_fresh_days + v_slice * c_slice_days);

  with win_sales as (
    -- always-fresh window
    select s.id as sale_id, s.nft_id, s.edition_id, s.sold_at
    from sales s
    where s.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' and s.nft_id is not null
      and s.sold_at >= v_fresh_from
    union all
    -- one rotating older slice (disjoint from the fresh window)
    select s.id as sale_id, s.nft_id, s.edition_id, s.sold_at
    from sales s
    where s.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' and s.nft_id is not null
      and s.sold_at >= v_slice_from and s.sold_at < v_slice_to
  ),
  -- one canonical (edition_key, serial) per moment, ONLY when wmc rows agree on
  -- edition_key (count distinct = 1). Ambiguous moments are dropped here so they
  -- never oscillate.
  nft_map as (
    select w.moment_id, min(w.edition_key) as ek, min(w.serial_number) as ser
    from wallet_moments_cache w
    join (select distinct nft_id from win_sales) ws on ws.nft_id = w.moment_id
    where w.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
      and w.edition_key ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    group by w.moment_id
    having count(distinct w.edition_key) = 1
  ),
  cand as materialized (
    select ws.sale_id, ws.sold_at, ew.id as new_ed, nm.ser as new_ser, nm.ek, nm.ser as ser
    from win_sales ws
    join nft_map nm on nm.moment_id = ws.nft_id
    join editions ew on ew.external_id = nm.ek and ew.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    where ew.id <> ws.edition_id
  ),
  cand_pairs as (select distinct ek, ser from cand),
  -- serial-collision guard scoped to candidate pairs (indexed, not a full scan):
  -- a (edition_key, serial) that maps to >1 moment is ambiguous — never re-key it.
  dup_pairs as materialized (
    select w2.edition_key, w2.serial_number
    from wallet_moments_cache w2
    join cand_pairs cp on cp.ek = w2.edition_key and cp.ser = w2.serial_number
    where w2.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
    group by w2.edition_key, w2.serial_number
    having count(distinct w2.moment_id) > 1
  )
  update sales s
  set edition_id = c.new_ed,
      serial_number = coalesce(c.new_ser, s.serial_number)
  from cand c
  left join dup_pairs d on d.edition_key=c.ek and d.serial_number=c.ser
  where s.id=c.sale_id and s.sold_at = c.sold_at and d.edition_key is null;
  get diagnostics n = row_count;
  return n;
end$function$;
-- <<< END verbatim remap_misattributed_topshot_sales <<<

-- ── Fixture ────────────────────────────────────────────────────────────────
-- Cursor starts at 0, so this run claims slice 1 (RETURNING yields the NEW
-- value): fresh window = [now-4d, ∞), rotating slice = [now-8d, now-6d).
-- A 5-day-old sale therefore falls in the GAP between them.
INSERT INTO remap_sweep_state (slice_no, last_run_at, last_cycle_at) VALUES (0, NULL, NULL);

-- e0 = where the sales currently (wrongly) point. e1 = where wmc says they belong.
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000e0', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1000'),
  ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652'),
  ('00000000-0000-0000-0000-0000000000e2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:9999'),
  -- ⚠ This UUID-keyed edition is what makes the edition_key regex assertion
  -- MEAN something. Without a matching edition the m-badkey sale is left alone
  -- whether or not the regex exists (the join simply finds nothing), so the
  -- guard has to be tested against a key that WOULD otherwise resolve.
  ('00000000-0000-0000-0000-0000000000e3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'uuid-a:uuid-b');

INSERT INTO sales (id, collection_id, nft_id, edition_id, serial_number, sold_at) VALUES
  (1,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-fresh',  '00000000-0000-0000-0000-0000000000e0', 10, now() - interval '1 day'),
  (2,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-slice',  '00000000-0000-0000-0000-0000000000e0', 11, now() - interval '7 days'),
  (3,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-gap',    '00000000-0000-0000-0000-0000000000e0', 12, now() - interval '5 days'),
  (4,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-old',    '00000000-0000-0000-0000-0000000000e0', 13, now() - interval '20 days'),
  (5,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-amb',    '00000000-0000-0000-0000-0000000000e0', 14, now() - interval '1 day'),
  (6,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-dup',    '00000000-0000-0000-0000-0000000000e0', 15, now() - interval '1 day'),
  (7,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-same',   '00000000-0000-0000-0000-0000000000e1', 16, now() - interval '1 day'),
  (8,  '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL,       '00000000-0000-0000-0000-0000000000e0', 17, now() - interval '1 day'),
  (9,  '06248cc4-b85f-47cd-af67-1855d14acd75', 'm-fresh',  '00000000-0000-0000-0000-0000000000e0', 18, now() - interval '1 day'),
  (10, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-badkey', '00000000-0000-0000-0000-0000000000e0', 19, now() - interval '1 day');

INSERT INTO wallet_moments_cache (collection_id, moment_id, edition_key, serial_number) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-fresh',  '48:1652', 77),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-slice',  '48:1652', 78),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-gap',    '48:1652', 79),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-old',    '48:1652', 81),
  -- m-amb: two DIFFERENT edition_keys → count(distinct)=2 → dropped by nft_map.
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-amb',    '48:1652', 82),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-amb',    '48:9999', 82),
  -- m-dup + m-dup2 share (edition_key, serial) → dup_pairs drops the re-key.
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-dup',    '48:1652', 90),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-dup2',   '48:1652', 90),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-same',   '48:1652', 91),
  -- Not int-keyed → excluded by the edition_key regex.
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm-badkey', 'uuid-a:uuid-b', 92);

-- ── Run ────────────────────────────────────────────────────────────────────
-- Only the fresh-window and in-slice sales qualify.
SELECT _assert_eq(remap_misattributed_topshot_sales()::text, '2', 'exactly 2 sales re-keyed (fresh window + the one rotating slice)');

SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=1), '00000000-0000-0000-0000-0000000000e1', 'fresh-window sale re-keyed to the wmc edition');
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE id=1), '77', 'serial_number rewritten from wmc, not left at the old value');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=2), '00000000-0000-0000-0000-0000000000e1', 'in-slice sale re-keyed');

-- Rotation: the gap and the far-past sale are OUT of scope this run.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=3), '00000000-0000-0000-0000-0000000000e0', '5-day-old sale sits in the gap between fresh and slice → untouched');
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE id=3), '12', 'gap sale kept its serial');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=4), '00000000-0000-0000-0000-0000000000e0', '20-day-old sale is outside the 32-day coverage this run → untouched');

-- Guard 2: ambiguity is dropped, not guessed.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=5), '00000000-0000-0000-0000-0000000000e0', 'moment whose wmc rows disagree on edition_key → NOT re-keyed (would oscillate every run)');

-- Guard 3: serial collisions are dropped.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=6), '00000000-0000-0000-0000-0000000000e0', '(edition_key, serial) shared by two moments → NOT re-keyed');

-- Already-correct, NULL nft, other-collection and non-int-keyed rows are all no-ops.
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE id=7), '16', 'sale already on the right edition is not rewritten (and not counted)');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=8), '00000000-0000-0000-0000-0000000000e0', 'NULL nft_id excluded');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=9), '00000000-0000-0000-0000-0000000000e0', 'other-collection sale untouched');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=10), '00000000-0000-0000-0000-0000000000e0', 'non-int edition_key excluded by the regex');

-- ── Cursor bookkeeping ─────────────────────────────────────────────────────
SELECT _assert_eq((SELECT slice_no::text FROM remap_sweep_state), '1', 'cursor advanced 0 → 1');
SELECT _assert((SELECT last_run_at IS NOT NULL FROM remap_sweep_state), 'last_run_at stamped');
SELECT _assert((SELECT last_cycle_at IS NULL FROM remap_sweep_state), 'last_cycle_at only stamped on a wrap, not on every run');

-- Wrap: 13 → 0 stamps last_cycle_at (one full 32-day cycle completed).
UPDATE remap_sweep_state SET slice_no = 13, last_cycle_at = NULL;
SELECT remap_misattributed_topshot_sales();
SELECT _assert_eq((SELECT slice_no::text FROM remap_sweep_state), '0', 'cursor wraps 13 → 0 after 14 slices');
SELECT _assert((SELECT last_cycle_at IS NOT NULL FROM remap_sweep_state), 'last_cycle_at stamped on the wrap');

SELECT '✓ remap_misattributed_topshot_sales invariants pass' AS result;
ROLLBACK;
