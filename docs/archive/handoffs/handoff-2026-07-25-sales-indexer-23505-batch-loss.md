# Handoff — 2026-07-25: the 23505 batch-insert data-loss class (5 sales writers)

**Status: the 23505 fix is SHIPPED to `main`, deployed, CI green.**
This doc covers (a) that fix, and (b) — added after Trevor said *"we should have all historical
sales"* — a **measurement of the actual historical-sales gap**, which turns out to be a different and
much larger problem than the bug. **Read §5 first if you only read one section.** §5 ends in a
decision for Trevor (billing + two ingest changes), not a patch.

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

## 5. MEASURED: "we should have all historical sales" — we don't, and the 23505 bug is not why

Trevor's call, so I measured instead of accepting. **The 23505 loss is a rounding error next to a
missing ERA.** Two hard blockers, and they must be fixed in this order.

### The gap, proven without external data

`sales` holds 4.56M rows (TopShot 3.01M · UFC 813k · AllDay 661k · Golazos 78k · Candy 200).
By partition:

| year | rows |
|---|---|
| 2020 | 79,160 |
| **2021** | **166,141** ← Top Shot's boom year |
| 2022 | 748,205 |
| 2023 | 1,208,416 |
| 2024 | 804,473 |
| 2025 | 738,102 |
| 2026 | 814,630 |

**Top Shot alone: 166,141 sales in 2021 (the mania year) vs 679,691 in 2023 (a quiet year) — 4.1×.**
That comparison is internally verifiable and sufficient on its own. (Compare TS-to-TS, not partition
to partition: the raw 2023 partition is 1,209,696 but includes AllDay/UFC/Golazos, whereas 2021 is
essentially all Top Shot — an earlier draft of this doc quoted 7.3× off that apples-to-oranges read.) The intra-2021 monthly TopShot curve is also
inverted vs. known history: Jan 74,969 → **Feb 27,552** → Mar 7,133, when Feb/Mar 2021 were the
single largest months Top Shot ever had. The 2020–21 V1 `Market.MomentPurchased` era is essentially
absent.

### Blocker 1 — Dune datapoint cap (hard stop, nothing is flowing)

`sales-ingest-dune` is armed and firing every 2h, but **4 ok / 37 runs**; every run since
2026-07-24 06:23Z fails identically:

```
execute HTTP 402: "This api request would exceed your configured datapoint limit per billing cycle"
```

Cursor `sales_ingest_state` is parked at **2025-06-21**, walking backward toward the 2019-01-01
floor — roughly 6 months done out of ~7 years, `windows_done: 0`, `inserted: 0` on every failed
tick. This is the carried `DUNE-DATAPOINT-CAP-402` item; the 07-19 `window_days` 7→2 hedge did not
clear it, because the cap is per *billing cycle*, not per request.

### Blocker 2 — edition resolution (the deeper one; fix BEFORE paying Dune)

Look at what the runs achieved *when Dune did work*:

| rows_found | skipped_unresolved | skipped_existing | **inserted** |
|---|---|---|---|
| 152,195 | 139,266 | 11,848 | **1,074** |
| 162,024 | 149,672 | 10,672 | **1,664** |
| 141,087 | 123,786 | 15,527 | **1,756** |
| 126,358 | 104,829 | 18,879 | **2,610** |

**~85–90% of every batch is dropped as edition-unresolvable**, and only ~1–2.6k rows are actually
gained per run. Cause: the ingest resolves `nft_id → edition` via `moments`, which holds only
**565,345** rows against a Top Shot mint universe in the millions (`nft_edition_map` is 130,946).

**And `apply_sales_ingest_external` does NOT park the unresolved rows** — verified against the live
function definition (no `unmapped_sales` reference). They are counted and thrown away. So every
Dune datapoint spent on an unresolvable row is spent *again* on any future re-run.

⇒ **Paying to lift the Dune cap today would burn ~85–90% of the spend on rows we immediately
discard.** That is the single most important conclusion here.

### UPDATE (same session, after "Dune reset yesterday?" + "keep doing all you can")

Two findings that change the plan. **Both are measured, not inferred.**

**(a) Dune has NOT reset — the 402 is still live.** Every 2-hourly tick through **2026-07-25 16:11:36Z**
returns `HTTP 402 … exceed your configured datapoint limit per billing cycle`. The last `ok` run was
**2026-07-24 06:11Z**; all ~12 runs since (9 of them today) failed identically, cursor frozen at
`2025-06-19..2025-06-21`. So the cap did not roll over. Either the cycle boundary is later than
assumed, or the reset did not restore datapoint headroom. **Check the Dune account's billing-cycle
date and datapoint balance directly** — our telemetry can only prove it is still refusing us.

**(b) The "free resolution" lever does NOT transfer from AllDay to Top Shot as-is — do not run it.**
`backfill_nft_edition_map_from_sales(p_collection_id, p_limit)` is already collection-parameterised,
so it *looks* like a drop-in for TopShot. It is not, for two independent reasons:

1. **It resolves ambiguity by "latest sale wins"** — `DISTINCT ON (s.nft_id) … ORDER BY s.nft_id,
   s.sold_at DESC`. That was safe on AllDay because AllDay had **0 ambiguous** nft_ids. **TopShot has
   287 ambiguous nft_ids in the 2021 partition alone** (nft_id mapping to 2+ distinct `edition_id`).
   Inspected samples are **not** the benign `::` parallel re-key — they are cross-set misattribution:
   `nft_id 102839 → both 134:5038 and 5:12` on the same day; `107831 → 29:584 and 5:50`;
   `108961 → 29:1346 and 5:14`. Different setIDs entirely, so one side is simply wrong. "Latest wins"
   picks arbitrarily when both land the same day. Running this for TopShot would **bake
   misattributions into `nft_edition_map`**, which then propagates into future sale resolution and
   therefore into FMV. (Related known machinery: the misattribution drain +
   `audit_topshot_sale_misattrib_remap_20260621`.)
   ⇒ A TopShot run needs an **ambiguity-safe variant**: resolve only where
   `count(DISTINCT edition_id) = 1` and quarantine the rest, instead of latest-wins.
2. **It only drains nft_ids already parked in `unmapped_sales`** (`FROM public.unmapped_sales …
   WHERE resolved_at IS NULL`). Since `apply_sales_ingest_external` **discards** its unresolved rows
   rather than parking them, this function can never see the Dune backlog at all. That makes
   "park unresolved rows" a hard **prerequisite**, not merely an optimisation.

**Why the miss rate is so extreme, quantified:** of **106,559** distinct TopShot nft_ids appearing in
2021 sales, only **702 are in `moments` (0.66%)** and **33 in `nft_edition_map`**. Since the Dune
ingest resolves *only* via `moments`, ~99% of that era is unresolvable by construction. `sales`
itself is the far richer source (3.01M resolved TopShot rows) — which is exactly why the
park-then-resolve route is right, and exactly why it must be ambiguity-safe before it runs.

### Recommended sequence (do not reorder)

1. **Free, first — stop discarding.** Park unresolved Dune rows in `unmapped_sales` (the pattern the
   forward indexers already use) so a resolution improvement retro-fills them without re-buying the
   data. Small change, but it must land before any paid backfill.
2. **Free — raise resolution.** Extend the AllDay trick shipped 2026-07-25 to Top Shot: an NFT's
   edition is immutable, so any *later* sale reveals the edition for all its earlier sales
   (`backfill_nft_edition_map_from_sales`, pg_cron jobid 215). On AllDay this drained 2,619 sales
   with zero on-chain calls. Re-measure the unresolved rate after it settles.
3. **Then decide the spend.** Only once (1) and (2) land is the Dune datapoint budget worth sizing —
   and at that point the alternative deserves a look too: the **free Flow REST lane** already beat
   Dune once on this repo (`sales_counterparty_recovered` 26,127 → 208,834 via a Cloudflare Worker,
   no per-row billing).

**Not shipped by me, deliberately:** (1) and (2) touch `sales` ingest/resolution logic, which is
explicitly off-limits for autonomous shipping, and (3) is a billing decision. All three are Trevor's
call — this section is the measurement to decide on, not a patch.

## 6. Open — needs a decision, not code

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

## 7. Also fixed this session (unrelated to the above)

- **`app/api/cron/offers-sweep/route.ts`** — `fetchSubeditionMap` read Top Shot's `::` parallel
  editions with a bare `.limit(10000)`, which PostgREST clamps to **1,000**; live count is **3,610**,
  so ~72% of parallel editions were missing from the `(play, subedition) → external_id` map and their
  best-offer / lowest-ask never reached `edition_offers` (and `badge_editions` holds 0 `::` rows, so
  the fallback was empty too). Now paginated with `.order("external_id").range()`.
  `fetchSetOnchainMap` left alone — 250 rows, far under the cap.
- **A pre-existing `main` typecheck red** cleared (`c2f53227`): 8 concurrent-session coverage-test
  files with the recurring `data: [] as any[]` → assigned `data: null` inference error. Third
  occurrence in one day (`72835ebe`, `d872110`).

## 8. Still queued from the earlier hunt (unchanged, not regressions)

- `lib/market-sources.ts::getSupabaseMarketMap` — fetches the global newest-1,000 `fmv_snapshots`
  instead of the requested editions. This is the already-tracked, FMV-adjacent
  `MARKET-SOURCES-FMV-RECENT-WINDOW-CAP`, explicitly **do-not-auto-ship**.
- `app/api/pack-listings/historical-pulls/route.ts` — truncates to an arbitrary 1,000 pack-pulls with
  no `.order()`. Real, but the route has **zero in-repo callers**; a correct fix is a redesign.
- `candy-sales-indexer` boundary `<=` — a sale at exactly the high-water second that was skipped for
  another reason is never revisited. Left as-is on purpose: the naive `<` fix would re-fetch DAS
  assets for already-recorded boundary sales every tick, burning the asset-fetch budget.

## 9. Verification performed

- All 6 CI jobs green (typecheck, unit tests + coverage ratchet, DB invariants, cadence lint,
  cadence escrow, ledger guard).
- Both earlier deploys reached **READY** in production; the offers-sweep row count (3,610) was
  measured live against Supabase before fixing, not assumed.
- The guard's predicates were validated by simulation before shipping (no local `node_modules` in
  this sandbox): passes on all 8 current sites, and a reconstructed old-buggy-shape negative control
  trips it.
- Ledger heading count checked non-decreasing on every write; one rebase conflict resolved by
  keeping **both** sides.
