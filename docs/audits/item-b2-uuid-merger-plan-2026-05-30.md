# Item B2 — UUID-keyed TS editions merger plan

**Status:** DRAFTED, NOT APPLIED. Stage manually in your next sit-down session.

This plan resolves the second TS edition leak source (`compute-topshot-pack-ev` + `seed_topshot_editions`) that Item B's `/api/ingest` fix doesn't cover. Per the 2026-05-30 overnight analysis, the leak is real (~1,500/day, sentinel CRITICAL at 3,107/48h) and rows are inert-not-corrupt — the trigger does its job, but the rows accumulate and fragment the editions table.

The fix has three phases. Each is a separate apply_migration. Stop between phases to inspect.

## Live state (2026-05-30)

```
7,230  total UUID-keyed TS edition rows
5,185  have player_name + set_name (hydrated)
4,985  of those have a canonical integer-pair sibling matching name+set+tier+circulation (strict match)
1,947  empty stubs (no metadata yet — created by seed_topshot_editions but never hydrated)
   35  have set_id_onchain + play_id_onchain populated (trigger hasn't fired on update; rare race)
```

Dependent rows on UUID-keyed editions:
```
33,291  pack_drop_pool rows
16,093  moments rows
14,000+ fmv_snapshots rows (estimated)
 7,089  sales rows
       moment_acquisitions, wallet_moments_cache (text FK)
```

## Why the edge-only fix can't work (Claude Code's analysis, confirmed)

`seed_topshot_editions` inserts the UUID row with `set_id_onchain = NULL` and `play_id_onchain = NULL` because the RPC is given only the UUID-pair external_id — it has no way to resolve on-chain ids from SQL alone. The downstream `hydrateSeededEditions` edge function call then fetches GQL metadata and tries to update the row with on-chain ids, but the `editions_block_topshot_uuid_dupe_trg` trigger nulls them back if a canonical exists.

The only working fix is a one-time merge (move dependents to canonical, delete UUID rows) plus a redesign of the seed RPC to not create UUID rows in the first place.

## ⚠️ 2026-05-30 (second-pass) investigation — the loose strict-match key is UNSAFE

Before staging Phase 1, a read-only dry-run (Claude Code) found the drafted strict-match key **`(player_name, set_name, tier, circulation_count)` is not unique** for ~10% of the merge set:

```
4,985  uuid rows match ≥1 canonical under the loose key (matches the draft count exactly)
4,490  match exactly ONE canonical (safe 1:1)
  495  match 2+ DISTINCT canonicals (different play_id_onchain) — ALL of them
       (canonicals_are_dupes_safe = 0; genuinely_different_plays = 495)
```

The drafted `Phase 1A` build uses `DISTINCT ON (u.id) ... ORDER BY u.id, c.id`, which for those 495 rows would **arbitrarily** pick one canonical and repoint that uuid row's sales / moments / fmv / pack_drop_pool to possibly the **wrong** edition. That is silent attribution corruption, not cleanup. **Do not run the drafted loose-key build.**

**Fix: add `game_date` to the key.** `game_date` and `name` are 100% populated on all 495 ambiguous rows (`video_url` / `thumbnail_url` / `play_id_onchain` are NOT). Testing the tighter key `(player_name, set_name, tier, circulation_count, name, game_date)`:

```
491 of 495 ambiguous rows resolve to exactly ONE canonical (different plays = different game dates)
  2 still-multi  → genuinely indistinguishable: both are Steph Curry "From the Top" LEGENDARY
                   circ 59, game_date 2020-03-06, canonicals 12:147 vs 12:156 (a real TS
                   two-play "From the Top" variant). DEFER — needs manual play-id assignment.
  ~10 drop to 0  → name/game_date formatting mismatch vs their lone canonical. DEFER.
```

Applied **uniformly across the whole hydrated set**, the tight key yields:

```
4,976  uuid rows resolve to exactly 1 canonical  → SAFE TO MERGE (correct attribution)
    2  tight_still_multi (the Steph Curry pair)  → defer
  ~10  had a loose canonical but tight drops to 0 → defer / investigate name-format drift
2,045  empty stubs (no metadata)                 → Phase 3 cleanup, unchanged
 ~200  hydrated but no canonical sibling at all   → NOT dupes; leave in place
```

Net: the tight key **removes the 495-row corruption risk AND raises safe coverage** (4,976 vs the conservative 4,490 floor). Use the corrected build below for Phase 1A; everything in Phase 1B/1C/2/3 is unchanged except that the map now carries only verified-unique 1:1 targets.

### Corrected Phase 1A build (USE THIS, not the loose-key version below)

```sql
INSERT INTO _b2_uuid_merge_map (
  uuid_edition_id, uuid_external_id,
  canonical_edition_id, canonical_external_id,
  player_name, set_name, tier, circulation_count
)
SELECT u.id, u.external_id::text, c.id, c.external_id::text,
       u.player_name, u.set_name, u.tier::text, u.circulation_count
FROM editions u
JOIN editions c
  ON c.collection_id = u.collection_id
 AND c.external_id ~ '^[0-9]+:[0-9]+$'
 AND c.player_name = u.player_name
 AND c.set_name    = u.set_name
 AND c.tier        = u.tier
 AND c.circulation_count = u.circulation_count
 AND c.name        = u.name                              -- ADDED
 AND c.game_date IS NOT DISTINCT FROM u.game_date        -- ADDED (the disambiguator)
WHERE u.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND u.external_id !~ '^[0-9]+:[0-9]+$'
  AND u.player_name IS NOT NULL
  AND u.set_name IS NOT NULL
GROUP BY u.id, u.external_id, c.id, c.external_id,
         u.player_name, u.set_name, u.tier, u.circulation_count
HAVING COUNT(*) = 1;   -- ONLY rows with a single unique canonical land in the map
-- Expect ~4,976 rows. If the count drifts far from this, re-run the dry-run analysis
-- before continuing — the leak is still accruing so the absolute number moves slowly.
```

**Status of this pass:** investigation only — NO merge table created, NOTHING repointed or deleted. Awaiting go-ahead to run the corrected Phase 1A→1C.

---

## Phase 1 — One-time merge of strict-match rows  (⚠️ see corrected key above)

Move dependents from each UUID edition_id to its canonical integer-pair edition_id, then delete the UUID rows. ~~Strict match: same `player_name`, `set_name`, `tier`, `circulation_count`.~~ **Corrected match adds `name` + `game_date` — see the investigation block above; the loose build below is retained only for context and must NOT be run as-is.**

```sql
-- ── Phase 1A: Build the merge map (idempotent / dry-runnable) ────────────
CREATE TABLE IF NOT EXISTS public._b2_uuid_merge_map (
  uuid_edition_id uuid PRIMARY KEY,
  uuid_external_id text NOT NULL,
  canonical_edition_id uuid NOT NULL,
  canonical_external_id text NOT NULL,
  player_name text,
  set_name text,
  tier text,
  circulation_count int,
  built_at timestamptz NOT NULL DEFAULT NOW()
);

TRUNCATE _b2_uuid_merge_map;

INSERT INTO _b2_uuid_merge_map (
  uuid_edition_id, uuid_external_id,
  canonical_edition_id, canonical_external_id,
  player_name, set_name, tier, circulation_count
)
SELECT DISTINCT ON (u.id)
  u.id, u.external_id::text,
  c.id, c.external_id::text,
  u.player_name, u.set_name, u.tier::text, u.circulation_count
FROM editions u
JOIN editions c
  ON c.collection_id = u.collection_id
 AND c.external_id ~ '^[0-9]+:[0-9]+$'
 AND c.player_name = u.player_name
 AND c.set_name = u.set_name
 AND c.tier = u.tier
 AND c.circulation_count = u.circulation_count
WHERE u.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND u.external_id !~ '^[0-9]+:[0-9]+$'
  AND u.player_name IS NOT NULL
  AND u.set_name IS NOT NULL
ORDER BY u.id, c.id;

-- Verify the map size before continuing:
-- SELECT COUNT(*) FROM _b2_uuid_merge_map;  -- expect ~4,985
```

```sql
-- ── Phase 1B: Repoint dependents in dependency order ────────────────────
-- Each statement uses UPDATE … FROM the map. Run them one at a time
-- because they touch big tables and you want to watch row counts.

-- 1. pack_drop_pool — collapses to canonical edition. ON CONFLICT handles
-- duplicates by keeping the canonical row.
UPDATE pack_drop_pool p
SET edition_id = m.canonical_edition_id
FROM _b2_uuid_merge_map m
WHERE p.edition_id = m.uuid_edition_id
  AND NOT EXISTS (
    SELECT 1 FROM pack_drop_pool p2
    WHERE p2.edition_id = m.canonical_edition_id
      AND p2.collection_id = p.collection_id
      AND p2.dist_id = p.dist_id
      AND p2.slot_name = p.slot_name
  );
DELETE FROM pack_drop_pool p
USING _b2_uuid_merge_map m
WHERE p.edition_id = m.uuid_edition_id;
-- Expect ~33k repointed; ~0 deleted (the canonical row may not exist before).

-- 2. fmv_snapshots — partitioned. Each phase touches one partition.
UPDATE fmv_snapshots f
SET edition_id = m.canonical_edition_id
FROM _b2_uuid_merge_map m
WHERE f.edition_id = m.uuid_edition_id;
-- Watch: ~14k rows.

-- 3. moments
UPDATE moments mo
SET edition_id = m.canonical_edition_id
FROM _b2_uuid_merge_map m
WHERE mo.edition_id = m.uuid_edition_id;
-- ~16k rows.

-- 4. sales (year-partitioned; do each year)
UPDATE sales_2026 s
SET edition_id = m.canonical_edition_id
FROM _b2_uuid_merge_map m
WHERE s.edition_id = m.uuid_edition_id;
-- ~7k rows in 2026; 2020-2025 may also have hits — re-run with each year.

-- 5. moment_acquisitions (if it references edition_id; verify column first)
-- 6. wallet_moments_cache — repoint edition_key text column
UPDATE wallet_moments_cache w
SET edition_key = m.canonical_external_id
FROM _b2_uuid_merge_map m
WHERE w.edition_key = m.uuid_external_id
  AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
```

```sql
-- ── Phase 1C: Delete UUID edition rows ──────────────────────────────────
-- Verify zero dependents survived. If any of these COUNT > 0, do NOT delete:
SELECT
  (SELECT COUNT(*) FROM pack_drop_pool p JOIN _b2_uuid_merge_map m ON p.edition_id = m.uuid_edition_id) AS pdp_left,
  (SELECT COUNT(*) FROM fmv_snapshots f JOIN _b2_uuid_merge_map m ON f.edition_id = m.uuid_edition_id) AS fmv_left,
  (SELECT COUNT(*) FROM moments mo JOIN _b2_uuid_merge_map m ON mo.edition_id = m.uuid_edition_id) AS moments_left,
  (SELECT COUNT(*) FROM sales_2026 s JOIN _b2_uuid_merge_map m ON s.edition_id = m.uuid_edition_id) AS sales_2026_left;

-- All zero? Then delete the UUID rows:
DELETE FROM editions e
USING _b2_uuid_merge_map m
WHERE e.id = m.uuid_edition_id;
-- Expect ~4,985 rows deleted.
```

## Phase 2 — Fix `seed_topshot_editions` so the leak stops

The RPC needs two changes:

1. **Skip UUID-pair external_ids entirely** when their on-chain pair can be resolved via a sidecar table or via the just-merged canonical row (now: the canonical exists because of Phase 1, so the UUID pair maps to it via badge_editions or via a precomputed external-id-mapping table).
2. **Return the canonical edition_id** to the caller (`compute-topshot-pack-ev`) so its pack_drop_pool inserts target canonical rows directly.

```sql
-- Sketch of the redesigned RPC. The caller (edge fn) sends UUID-pair OR
-- integer-pair external_ids; the RPC returns a map of input → canonical
-- edition_id. UUID-pair inputs that don't have a canonical sibling get a
-- NULL in the map and the caller falls through to GQL hydration.

CREATE OR REPLACE FUNCTION public.seed_topshot_editions_v2(p_external_ids text[])
RETURNS TABLE(input_external_id text, canonical_edition_id uuid, canonical_external_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- For int-pair inputs: insert if missing, return the row.
  -- For UUID-pair inputs: look up canonical by joining to the prior merge
  -- map OR by attempting a sibling match on name+set+tier when metadata is
  -- known. If nothing matches, return NULL (caller hydrates via GQL and
  -- only THEN decides whether to insert a new canonical int-pair row).
  RETURN QUERY
  WITH parsed AS (
    SELECT
      ext AS input,
      CASE WHEN ext ~ '^[0-9]+:[0-9]+$' THEN ext ELSE NULL END AS int_pair,
      CASE WHEN ext !~ '^[0-9]+:[0-9]+$' THEN ext ELSE NULL END AS uuid_pair
    FROM unnest(p_external_ids) AS ext
  )
  -- Integer-pair: insert if missing, return canonical.
  -- (Implementation continues — full RPC in the staged migration.)
  ...
END;
$$;
```

The full RPC + the `compute-topshot-pack-ev` edge function update need to ship together. Don't apply only one half.

## Phase 3 — Defensive cleanup

After Phase 1+2 hold for 24h with no new UUID rows:

- Delete the 1,947 empty-stub UUID rows (no metadata + no dependents post-merge).
- Drop the `editions_block_topshot_uuid_dupe_trg` trigger (it's defending against the now-fixed leak).
- Drop the `_b2_uuid_merge_map` working table.

## What NOT to do

- **Don't run Phase 1 without verifying the strict-match count first.** If `_b2_uuid_merge_map` builds <4,500 rows, something has changed since this plan was drafted — the live state numbers may have shifted from canonical-merger work happening upstream. Investigate before continuing.
- **Don't delete UUID edition rows before all dependents are repointed.** The CASCADE rules in CLAUDE.md ([editions dependents shape](.../memory/editions-dependents-shape.md)) include some FKs that would cascade-delete dependents you want to keep — verify with `\d+ editions` and the `editions-dependents-shape` memory entry before any DELETE.
- **Don't ship Phase 2 alone.** The edge function counterpart in `supabase/functions/compute-topshot-pack-ev/index.ts` must change at the same time, or the new RPC contract breaks the existing caller.
- **Don't run this autonomously.** Surface B (pack-reality) sits on top of pack_drop_pool. A botched Phase 1B leaves the public surface broken until repair.

## Suggested sequencing

1. Read this doc fresh in a sit-down session.
2. Build `_b2_uuid_merge_map`. Verify count ≈ 4,985.
3. Apply 1B one statement at a time. Spot-check dependent counts after each.
4. Apply 1C only after the verification query in 1C returns all zeros.
5. Pause 24h. Confirm sentinel leak count drops.
6. Draft and review Phase 2 RPC + edge function changes together.
7. Apply Phase 2.
8. After 24h with no new UUID rows, Phase 3.

Total wall-clock if uninterrupted: 2-3 hours of careful execution. Reversible only via point-in-time recovery on the editions table (Supabase Pro supports this). Don't run it on a Friday.
