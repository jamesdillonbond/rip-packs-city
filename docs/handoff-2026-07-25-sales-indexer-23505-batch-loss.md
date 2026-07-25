# Handoff — 2026-07-25: the 23505 batch-insert data-loss class (5 sales writers)

**Status: SHIPPED to `main`, deployed, CI green. Nothing is blocked on you to make it correct.**
This doc exists so the *next* session (or Trevor) knows what changed in the ingest layer, what was
deliberately NOT touched, and the one genuinely open question that needs a decision rather than code.

Commits (newest last): `a6cda9ec` (candy) · `053dfe65` (offers-sweep) · `c2f53227` (tsc red) ·
`39ad989c` (the remaining 4 sales indexers + guard). Ledger entries: `docs/overnight/ledger.md`,
2026-07-25 section. Durable rule: `CLAUDE.md` → "General rules".

---

## 1. What the bug was

A PostgREST/Postgres **batch insert is ALL-OR-NOTHING**. If any row in the batch violates a unique
constraint, the entire statement fails with `23505` and **none** of the batch is written.

Five forward sales indexers handled that error like this:

```ts
const { error } = await supabaseAdmin.from("sales").insert(batch)
if (error) {
  if (error.code === "23505") {
    // dupes — already recorded        <-- WRONG: the co-batched NEW rows are gone too
  } else {
    ...row-by-row retry...             <-- correct, but unreachable for the dupe case
  }
}
```

So one duplicate `transaction_hash` in a 100-row batch silently discarded up to 99 **genuinely new
sales**. On a cursored indexer the loss is **permanent**: nothing lands, but the block / high-water
cursor advances past those rows anyway, so they are never retried. Nothing logs an error —
the rows are counted as ordinary dedup, which is exactly why this survived so long.

**Fixed idiom** (now uniform across all five):

```ts
if (error.code !== "23505") console.log(...)   // log only genuine errors
for (const row of batch) { ...insert(row)... } // ALWAYS retry per row
```

Real duplicates then fail individually and are skipped; new rows land.

## 2. What shipped

| Route | Sites | Note |
|---|---|---|
| `app/api/candy-sales-indexer/route.ts` | 1 (`sales`) | first one found; ~53 sales/24h live |
| `app/api/golazos-sales-indexer/route.ts` | 2 (`sales`, `unmapped_sales`) | byte-identical |
| `app/api/allday-sales-indexer/route.ts` | 2 (`sales`, `unmapped_sales`) | byte-identical |
| `app/api/ufc-sales-indexer/route.ts` | 2 (`sales`, `unmapped_sales`) | byte-identical |
| `app/api/sales-indexer/route.ts` | 1 (`sales`) | **TopShot forward ingest — worst variant** |

`sales-indexer` deserves its own note: it counted the whole batch as `duped` and had **no row-by-row
retry at all** on the returned-error path. Its retry existed only inside a `catch` block — and
**supabase-js returns errors rather than throwing**, so a `23505` never reached it. It now shares one
`insertIndividually()` helper across both the returned-error and thrown-exception paths;
`inserted` / `duped` counter semantics are unchanged.

**Guard:** `__tests__/sales-batch-insert-23505-guard.test.ts` — directory-driven over
`app/api/*sales-indexer/route.ts`, so a new sales indexer is covered automatically. Asserts it is
wired to the 5 real routes, sees ≥8 batch-insert sites, that no handler branches positively on
`23505`, and that every site keeps a row-by-row retry reachable.

## 3. Deliberately NOT touched — do not "fix" these

- **`app/api/cron/*-sales-history-backfill/*` + `app/api/ingest/backfill`** (8 sites). These use a
  *different but correct* idiom: `else if (code === "23505") { ...row-by-row... }` — the positive
  branch **is** the retry. An early over-broad draft of the guard flagged them; that was a false
  positive and the guard was scoped down. Leave them alone.
- **`app/api/pinnacle-sales-indexer/route.ts`** — uses
  `.upsert(batch, { onConflict: "id", ignoreDuplicates: true })`; duplicates never raise, so there is
  no all-or-nothing loss. Its `23505` branch is dead defensive code.

## 4. Process lesson worth carrying (this one bit me mid-session)

My first sweep ran `grep -rn "23505" … | head -20` and I reported that truncated list as the complete
set — it named 2 writers when there were 4 (allday and ufc were cut off). I published that wrong
count to the ledger and CLAUDE.md before a full untruncated scan (48 sites / 22 files) corrected it.
**Never make a completeness claim from a `head`-limited grep.** Both docs are now corrected; the
superseded queued entry was replaced in place, heading count verified non-decreasing.

## 5. Open — needs a decision, not code

**Is there historical loss worth recovering?** The fix stops *future* loss; it does not backfill what
was already dropped. Nothing was measured on this, because the loss is invisible by construction —
dropped rows were counted as ordinary dupes and the cursors advanced. Two honest options:

1. **Accept it.** The existing `cron/*-sales-history-backfill` walkers re-scan history with the
   *correct* idiom and are idempotent, so they will re-land anything they cover as they sweep. This
   is probably already true for most of it.
2. **Measure it.** For a bounded window, compare on-chain sale events against `sales` rows per block
   range and quantify the gap. Non-trivial, and the answer may well be "the backfills already got it."

Recommendation: **option 1**, unless someone has an independent reason to think a specific collection
is short on sales. Do not launch a bespoke recovery pipeline without measuring first.

## 6. Also fixed this session (unrelated to the above)

- **`app/api/cron/offers-sweep/route.ts`** — `fetchSubeditionMap` read Top Shot's `::` parallel
  editions with a bare `.limit(10000)`, which PostgREST clamps to **1,000**; live count is **3,610**,
  so ~72% of parallel editions were missing from the `(play, subedition) → external_id` map and their
  best-offer / lowest-ask never reached `edition_offers` (and `badge_editions` holds 0 `::` rows, so
  the fallback was empty too). Now paginated with `.order("external_id").range()`.
  `fetchSetOnchainMap` left alone — 250 rows, far under the cap.
- **A pre-existing `main` typecheck red** cleared (`c2f53227`): 8 concurrent-session coverage-test
  files with the recurring `data: [] as any[]` → assigned `data: null` inference error. Third
  occurrence in one day (`72835ebe`, `d872110`).

## 7. Still queued from the earlier hunt (unchanged, not regressions)

- `lib/market-sources.ts::getSupabaseMarketMap` — fetches the global newest-1,000 `fmv_snapshots`
  instead of the requested editions. This is the already-tracked, FMV-adjacent
  `MARKET-SOURCES-FMV-RECENT-WINDOW-CAP`, explicitly **do-not-auto-ship**.
- `app/api/pack-listings/historical-pulls/route.ts` — truncates to an arbitrary 1,000 pack-pulls with
  no `.order()`. Real, but the route has **zero in-repo callers**; a correct fix is a redesign.
- `candy-sales-indexer` boundary `<=` — a sale at exactly the high-water second that was skipped for
  another reason is never revisited. Left as-is on purpose: the naive `<` fix would re-fetch DAS
  assets for already-recorded boundary sales every tick, burning the asset-fetch budget.

## 8. Verification performed

- All 6 CI jobs green (typecheck, unit tests + coverage ratchet, DB invariants, cadence lint,
  cadence escrow, ledger guard).
- Both earlier deploys reached **READY** in production; the offers-sweep row count (3,610) was
  measured live against Supabase before fixing, not assumed.
- The guard's predicates were validated by simulation before shipping (no local `node_modules` in
  this sandbox): passes on all 8 current sites, and a reconstructed old-buggy-shape negative control
  trips it.
- Ledger heading count checked non-decreasing on every write; one rebase conflict resolved by
  keeping **both** sides.
