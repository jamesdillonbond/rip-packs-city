# Claude Code handoff — FMV Items 4 + 5

Companion to `docs/handoff-2026-05-28-cowork-pass.md` (Items 4 + 5 there). This doc supersedes the high-level descriptions with concrete file:line patches after a Cowork pass that read the actual routes and decomposed the LOW-zero-90d-sales population by algo.

One DB migration already shipped live (the 828-TS-edition honesty pass). Two code patches remain, both in `app/api/fmv-recalc/route.ts`.

---

## Discoveries from the Cowork pass

### Item 4 — it's not throughput, it's coverage

The handoff assumed "the sweep is moving but slow." That premise was wrong. Decomposed by 1.7.0-snapshot history, the 3,786 AllDay editions stuck on `allday-gql-v1` split as:

- **3,369 (89%) have NEVER had a 1.7.0 snapshot.** They're not in the recent-sales sweep (likely zero/stale 30d sales) AND Step 5b's historical fallback only writes `WHERE fs.edition_id IS NULL` (they already have a snapshot from `allday-fmv-populate`, so it skips them).
- **417 (11%) have a 1.7.0 row in history that lost the latest-by-computed_at race.** `allday-fmv-populate` ran more recently than `fmv-recalc` did for those edition_ids. Bumping cron frequency on `fmv-recalc` alone can't help — `allday-fmv-populate` would just win the next round.

The fix has to either (a) make Step 5b cover editions with a non-1.7.0 latest snapshot, or (b) add a new step that targets the `allday-gql-v1` population specifically.

### Item 5 — the LOW write site is in Step 5b, not Step 1's main path

The lib (`lib/fmv-confidence.ts`) is pure HIGH/MEDIUM/LOW math with no recency input — STALE is a write-site decision. The 2,759 zero-90d-sales LOW editions decompose by algo as:

| algo | editions | notes |
|---|---:|---|
| `allday-gql-v1` | 1,827 | AllDay; needs Item 4 fix first or `allday-fmv-populate` re-clobbers |
| `1.7.0` (TS) | 828 | shipped — see migration below |
| `1.7.0` (AllDay) | 91 | needs Item 4 + Item 5 |
| `allday-gql-v1_haircut` | 8 | follows allday-gql-v1 |
| `thin-sales-guard-v3` | 3 | other |

The 828 TS rows were entered by Step 5b's historical fallback at lines 685-705, which writes `confidence: "LOW"` regardless of `daysSinceSale`. Median `days_since_sale` for these is 73. The fix is one line in Step 5b.

---

## Shipped live (1 DB migration, durable)

**`audit_20260528_low_to_stale_topshot_zero_90d_sales`** — flipped 828 TS LOW-on-1.7.0 editions with zero 90-day sales to STALE via fresh snapshots tagged `cold-tail-low-recency-1.0`. Durability analysis (in the migration body): no existing fmv-recalc / drain-fmv-cold-tail / apply_fmv_thin_sale_haircut / topshot-fmv-populate path will overwrite STALE for an edition with zero 90d sales and no listings. STALE counts: 1,673 → 2,505.

The matching 1,827 AllDay rows are left untouched. `allday-fmv-populate` would re-clobber them every 30 min until Item 4's catch-up logic lands.

---

## Item 4 patch — make Step 5b cover stuck-on-other-algo editions

File: `app/api/fmv-recalc/route.ts`, **lines 649-669** (Step 5b historical sales fallback).

### Current

```ts
const { data: histRows, error: histErr } = await supabaseAdmin
  .rpc("query_sql", {
    query: `
      SELECT
        e.id AS edition_id,
        e.collection_id,
        AVG(s.price_usd)::numeric AS avg_price,
        MIN(s.price_usd)::numeric AS min_price,
        COUNT(s.id) AS sales_count,
        MAX(s.sold_at) AS latest_sold_at
      FROM editions e
      JOIN sales s ON s.edition_id = e.id
      LEFT JOIN fmv_snapshots fs ON fs.edition_id = e.id
      WHERE fs.edition_id IS NULL
        AND s.price_usd > 0
        AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
        AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
      GROUP BY e.id, e.collection_id
      LIMIT 1000
    `,
  })
```

### Patch

Replace the `WHERE fs.edition_id IS NULL` predicate with a subquery against the latest snapshot's algo_version. Adds editions whose latest snapshot was written by a writer that isn't `1.7.0` so `fmv-recalc` "catches up" on every tick.

```ts
const { data: histRows, error: histErr } = await supabaseAdmin
  .rpc("query_sql", {
    query: `
      WITH latest_algo AS (
        SELECT DISTINCT ON (edition_id) edition_id, algo_version
        FROM fmv_snapshots
        ORDER BY edition_id, computed_at DESC
      )
      SELECT
        e.id AS edition_id,
        e.collection_id,
        AVG(s.price_usd)::numeric AS avg_price,
        MIN(s.price_usd)::numeric AS min_price,
        COUNT(s.id) AS sales_count,
        MAX(s.sold_at) AS latest_sold_at
      FROM editions e
      JOIN sales s ON s.edition_id = e.id
      LEFT JOIN latest_algo la ON la.edition_id = e.id
      WHERE (la.edition_id IS NULL OR la.algo_version NOT LIKE '1.7.%')
        AND s.price_usd > 0
        AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
        AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
      GROUP BY e.id, e.collection_id
      LIMIT 1000
    `,
  })
```

### Behaviour after the patch

Step 5b now writes a fresh 1.7.0 snapshot for any edition whose latest snapshot is on `allday-gql-v1`, `cold-tail-1.0`, etc., as long as it has any historical sale. The downstream delete-then-insert at lines 708-718 deletes today's snapshot for those editions (so the haircut-suffixed variants get nuked) and writes the fresh 1.7.0 row.

The `LIMIT 1000` caps the per-tick catch-up. At 150 ticks/24h that's 150k writes/24h cap — enough to clear the 3,369 in ~half an hour of cron ticks. Realistically the haircut and other downstream writers will keep some churn going, but the steady-state should shift the LOW-on-`allday-gql-v1` population toward 1.7.0 within ~2 days.

### Side effect — also fixes Item 5 for AllDay

Once the 1,827 AllDay LOW-zero-90d-sales editions land on 1.7.0 via this catch-up, Item 5's Step 5b downgrade (below) catches them too. Item 4 + Item 5 together honesty-up the entire population without needing a separate AllDay one-shot.

### Verify after deploy

```sql
-- Should drop steadily from 3,786 toward 0 over 1-3 days.
SELECT COUNT(*) FROM (
  SELECT DISTINCT ON (edition_id) algo_version
  FROM fmv_snapshots
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'  -- AllDay
  ORDER BY edition_id, computed_at DESC
) x WHERE algo_version = 'allday-gql-v1';

-- HIGH+MEDIUM% on AllDay should rise from current 3.7% toward TS's 6.9%.
SELECT COUNT(*) FILTER (WHERE confidence IN ('HIGH','MEDIUM'))::numeric
       / NULLIF(COUNT(*), 0) * 100 AS high_medium_pct
FROM (
  SELECT DISTINCT ON (edition_id) confidence
  FROM fmv_snapshots
  WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  ORDER BY edition_id, computed_at DESC
) x;
```

---

## Item 5 patch — LOW→STALE downgrade in Step 5b

File: `app/api/fmv-recalc/route.ts`, **line 699** (Step 5b historical sales fallback insert).

### Current

```ts
return applyAllFmvGuards({
  edition_id: row.edition_id,
  collection_id: row.collection_id,
  fmv_usd: Number(avgPrice.toFixed(2)),
  floor_price_usd: Number(Number(row.min_price).toFixed(2)),
  wap_usd: Number(avgPrice.toFixed(2)),
  wap_without_outliers: Number(avgPrice.toFixed(2)),
  liquidity_rating: liquidityRating(Number(row.sales_count)),
  confidence: "LOW",                                              // ← line 699
  sales_count_7d: 0,
  sales_count_30d: 0,
  days_since_sale: daysSinceSale,
  algo_version: ALGO_VERSION,
})
```

### Patch

```ts
return applyAllFmvGuards({
  edition_id: row.edition_id,
  collection_id: row.collection_id,
  fmv_usd: Number(avgPrice.toFixed(2)),
  floor_price_usd: Number(Number(row.min_price).toFixed(2)),
  wap_usd: Number(avgPrice.toFixed(2)),
  wap_without_outliers: Number(avgPrice.toFixed(2)),
  liquidity_rating: liquidityRating(Number(row.sales_count)),
  // Honesty gate: if the edition hasn't traded in 60+ days, it's not LOW —
  // it's STALE. Writing LOW with a 73-day-old single sale labels stale
  // pricing data as healthy LOW signal to collectors.
  confidence: daysSinceSale >= 60 ? "STALE" : "LOW",
  sales_count_7d: 0,
  sales_count_30d: 0,
  days_since_sale: daysSinceSale,
  algo_version: ALGO_VERSION,
})
```

### Threshold choice

60 days mirrors the `apply_fmv_thin_sales_guard`'s stale-30d-no-ask logic in spirit (no sale recently + no ask = capped). 60 days is the conservative version — once an edition hasn't traded in 2 months, the WAP is unreliable signal.

### Verify after deploy

```sql
-- After Items 4 + 5 are both live, this should trend toward 0.
SELECT COUNT(*) FROM (
  SELECT DISTINCT ON (edition_id) confidence, days_since_sale
  FROM fmv_snapshots ORDER BY edition_id, computed_at DESC
) x WHERE confidence = 'LOW' AND days_since_sale >= 60;
```

---

## Order of operations

Ship Items 4 + 5 in the same commit. They're complementary: Item 4 forces the AllDay catch-up, Item 5 then writes STALE for the zero-90d-sales subset that lands on 1.7.0. Shipping just Item 5 without Item 4 leaves the AllDay 1,827 editions stuck on `allday-gql-v1` (which doesn't have the new LOW→STALE gate).

After ~24-48 hours of cron ticks:
- AllDay HIGH+MEDIUM% should rise from 3.7% toward TS's 6.9% baseline
- LOW-zero-90d-sales total should drop from 2,759 toward <100
- STALE total should rise from 2,505 toward ~4,500-5,000

---

## Append to CLAUDE.md after shipping

Under "## Recent sessions" at the top:

```markdown
### May 28, 2026 (afternoon) — FMV honesty pass: LOW→STALE for stale pricing + AllDay catch-up

Code-side follow-up to the morning's Cowork pass. Two changes to `app/api/fmv-recalc/route.ts`:

- **Step 5b catch-up:** WHERE predicate changed from `fs.edition_id IS NULL` to a CTE that also matches editions whose latest snapshot's `algo_version NOT LIKE '1.7.%'`. Forces fmv-recalc to re-evaluate the 3,369 AllDay editions that have never had a 1.7.0 snapshot (currently stuck on `allday-gql-v1` because `allday-fmv-populate` keeps winning the latest-by-computed_at race). Cap is 1000/tick.
- **Step 5b LOW→STALE gate:** `confidence: "LOW"` → `confidence: daysSinceSale >= 60 ? "STALE" : "LOW"`. Honesty-ups editions whose only historical sales are 60+ days old.

Pre-shipped DB migration: `audit_20260528_low_to_stale_topshot_zero_90d_sales` flipped 828 TS LOW-zero-90d-sales editions to STALE inline. The matching 1,827 AllDay editions are left for Item 4's catch-up sweep to handle (allday-fmv-populate would re-clobber them otherwise). After 1-2 days expect LOW-zero-90d-sales total to drop from 2,759 toward <100 and AllDay HIGH+MEDIUM% to rise from 3.7% toward TS's 6.9%.

Full handoff: `docs/handoff-2026-05-28-fmv-items-4-5.md`. Diagnostic basis: `docs/audits/fmv-confidence-decomposition-2026-05-28.md`.
```

End. Ship both patches in one commit.
