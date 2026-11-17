-- Partition index inheritance gaps: an index that exists on OLDER partitions but
-- is missing from the NEWEST one.
--
-- WHY THIS SHAPE, AND WHY NOT THE OBVIOUS ONE. The naive query — "index shapes
-- present on some partitions but not all" — is NOT a defect list. A covering index
-- deliberately built on hot partitions only (idx_sales_2026_pulse_window lives on
-- 2026 + 2027 and nowhere else) is an optimisation, and it shows up as a gap on six
-- partitions. Measured 2026-09-13: that query returned 12 rows on `sales` and
-- `fmv_snapshots`, nearly all intentional.
--
-- The DEFECT direction is narrow: present on the OLD partitions, absent from the
-- NEWEST. That is a partition created after the index migration, which never
-- inherited it — the index was written for the partitions that existed that day and
-- nothing re-applies it when the year rolls.
--
-- THE CASE THIS WAS WRITTEN FROM. idx_sales_<year>_nullseller_soldat was built on
-- sales_2020..sales_2025 on 2026-07-24, with 2026 explicitly excluded as "the
-- active-ingest partition" holding only a "small above-cursor residual". By
-- 2026-09-13 sales_2026 was the LARGEST partition in the table and — after that
-- day's re-arm migration — the one claim_sales_counterparty_batch() starts every
-- sweep in. Its 2026 branch degraded to Bitmap Heap Scan + SORT over 308 MB:
-- production ticks of 53–115 s and four statement timeouts.
--
-- ⚠ A ZERO HERE MEANS NOTHING WITHOUT THE POSITIVE CONTROL BELOW. Run it: it
-- reconstructs the pre-fix state by excluding the two indexes built that day, and
-- must return exactly one row. If it returns zero, the detector is broken, not the
-- database clean.
--
-- Result 2026-09-13 (after the fix): main query 0 rows; control 1 row. So that gap
-- was the only instance of this class in the database.
--
-- HAVING count(*) >= 3 keeps it to shapes with a real history across partitions;
-- lower it to 1 to see every asymmetry, and expect deliberate ones in the output.

-- ── the detector ───────────────────────────────────────────────────────────
WITH parts AS (
  SELECT i.inhparent::regclass::text AS parent, i.inhrelid::regclass::text AS part, i.inhrelid AS oid
  FROM pg_inherits i
  JOIN pg_class pc ON pc.oid = i.inhparent
  JOIN pg_namespace n ON n.oid = pc.relnamespace
  WHERE n.nspname = 'public' AND pc.relkind = 'p'
),
newest AS (SELECT parent, max(part) AS newest_part FROM parts GROUP BY parent),
idx AS (
  SELECT p.parent, p.part,
         -- strip the index name and table name so the same shape compares across
         -- partitions; keep columns, INCLUDE list and predicate
         regexp_replace(
           regexp_replace(pg_get_indexdef(x.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON \S+ ', 'IDX '),
           '\s+', ' ', 'g') AS shape
  FROM parts p JOIN pg_index x ON x.indrelid = p.oid
  -- POSITIVE CONTROL: uncomment to reconstruct the 2026-09-13 pre-fix state.
  -- Must return exactly one row (sales / sold_at DESC WHERE seller_address IS NULL).
  -- WHERE x.indexrelid::regclass::text NOT IN
  --   ('idx_sales_2026_nullseller_soldat', 'idx_sales_2027_nullseller_soldat')
)
SELECT i.parent,
       n.newest_part          AS missing_from,
       i.shape,
       count(*)               AS older_partitions_with,
       string_agg(i.part, ', ' ORDER BY i.part) AS present_on
FROM idx i
JOIN newest n ON n.parent = i.parent
WHERE i.part <> n.newest_part
  AND NOT EXISTS (
    SELECT 1 FROM idx j
    WHERE j.parent = i.parent AND j.part = n.newest_part AND j.shape = i.shape
  )
GROUP BY i.parent, n.newest_part, i.shape
HAVING count(*) >= 3
ORDER BY older_partitions_with DESC;
