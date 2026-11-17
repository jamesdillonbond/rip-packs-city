# One of the four never-run walkers is a DUPLICATE of a live pipeline, not a gap — and that halves the decision

**Filed 2026-08-22 ~08:00 PT (15:00Z), Claude Code interactive. MEASURED, with positive
controls. NOT acted on — deleting or wiring an ingest route is Trevor's call.**

Re-derivation of `inbox/2026-08-21T1701Z-four-of-the-nineteen-hardened-walkers-have-never-run.md`,
per this repo's rule that a filed finding is a hypothesis. **Its measurements all hold.
Its option 3 — "decide separately" for `app/api/pinnacle/ingest-events` — is superseded
by a fact it did not have.**

---

## 1. The prior filing re-derived: every zero still stands

| walker | runs (all time) | last day |
|---|---:|---|
| `golazos-listings-indexer` *(control)* | 2,273 | 2026-08-22 |
| `allday-offers-indexer` *(control)* | 1,703 | 2026-08-22 |
| **`topshot-listings-indexer`** | **0** | never |
| **`golazos-offers-indexer`** | **0** | never |
| **`ufc-listings-indexer`** | **0** | never |

⚠ **The controls are in the SAME query as the zeros**, so a broken instrument cannot
produce this shape. `pipeline_runs_daily` is retained indefinitely, so a zero here is a
real absence, not the ~73 h `pipeline_runs` retention artifact.

`backfill_state.id = 'pinnacle_flow_events'` is **still absent** (0 rows). Control: the
table is live — 10 ids, newest `last_run_at` 2026-08-22 13:39Z.

## 2. ⚠ THE FINDING: `app/api/pinnacle/ingest-events` is a SECOND IMPLEMENTATION of a live pipeline

The prior filing treated it as an unwired walker needing a telemetry decision. It is
narrower than that. Compared against the live `pinnacle-sales-indexer` (1,438 runs, ran
today):

| | dormant `lib/pinnacle/flow-events.ts` | live `app/api/pinnacle-sales-indexer` |
|---|---|---|
| event | `NFTStorefrontV2.ListingCompleted` | `NFTStorefrontV2.ListingCompleted` |
| filter | `A.edf9df96c92f4595.Pinnacle.NFT` | `Pinnacle` type match |
| writes | **`pinnacle_sales`** | **`pinnacle_sales`** |
| cursor | `backfill_state.pinnacle_flow_events` | `event_cursor` |

**Same event, same NFT type, same destination table — two independent cursors.** So it is
not a gap in coverage; Pinnacle sales ARE being ingested. ⚠ **And wiring it would be
actively harmful rather than merely redundant: two walkers writing `pinnacle_sales` from
cursors that know nothing about each other.** The dedup in the live route is keyed on its
own reads, not on a second writer.

**This makes it the same class as `topshot-listings-indexer`** — a superseded alternate,
which the prior filing had already identified for that one (`ts-listing-ingest` /
`topshot-listing-cache` serve TopShot listings). Two of the four are duplicates.

⚠ **A NEAR-MISS WORTH RECORDING, because the tidy answer was wrong.** My first hypothesis
was that the live `app/api/cron/pinnacle-events-ingest` (2,272 runs) was the substitute —
the names are nearly identical and it was the obvious match. **It is not**: that route
ingests `ListingAvailable` into `pinnacle_listing_events`. It is LISTINGS; the dormant one
is SALES. Reading the two route headers is what separated them, not the names. **A name
collision this close is exactly the "two objects one suffix apart yielded opposite
conclusions" trap this repo already records for `cron.job.command`.**

## 3. The other two have no substitute — confirmed by enumeration, not by search

Every `ufc%` and `golazos%` pipeline in `pipeline_runs_daily`, all live today:

- **golazos**: listings-indexer, listing-cache, sales-indexer, sales-history-backfill,
  studio-sales-history-backfill, badge-low-ask-refresh, buyer-discovery, buyer-backfill,
  compute-golazos-pack-ev, wallet-backfill-golazos, plus two `-heartbeat` arms.
  **There is no offers pipeline of any name.**
- **ufc**: sales-indexer, sales-history-backfill, studio-sales-history-backfill,
  enrichment-drain, stub-thumbnail-resolver, wallet-backfill-ufc.
  **There is no listings pipeline of any name.**

So if Golazos offers and UFC listings are wanted, they are genuinely not being ingested.

## 4. ⚠ Cross-link to the open "UFC Strike — deprecate or wire" item

These two decisions are the same decision. Wiring `ufc-listings-indexer` means building
listings ingest for a collection whose deprecation is already on the table.

⛔ **STATED AS UNVERIFIED: I could NOT re-derive UFC Strike's market state.** Two attempts
(`max(sold_at)`, and a 30/90-day count over `sales WHERE collection = 'ufc_strike'`) both
**timed out at 60 s** — this was 14:5xZ, inside the documented 20-hour band. The prior
figure (last sale 2026-05-13, zero sales in 30 and 90 days) is from
`inbox/2026-08-22T0256Z-...`, is a DATED SAMPLE, and I am citing it rather than confirming
it. **Re-measure in the 20:00–00:00Z window before deciding on that basis.**

## 5. What this leaves

- **`topshot-listings-indexer`** — duplicate of a live path. Delete candidate.
- **`app/api/pinnacle/ingest-events`** — duplicate of a live path, and dangerous to wire.
  Delete candidate, and the stronger of the two.
- **`ufc-listings-indexer`** — real gap, but for a possibly-deprecating collection. Decide
  with the UFC Strike item, not separately.
- **`golazos-offers-indexer`** — the one clean "wire it or drop it" call with no
  confounder.

Still Trevor's call. Nothing here was applied.

## 6. The durable lesson, promoted out of the prior filing

The prior filing's best sentence was buried in its section on the fourth route: **a
cursored walker with no `pipeline_runs` row can run, fail, and advance its cursor with
zero observability.** That is now in
[docs/reference/cron-and-schedulers.md](../../reference/cron-and-schedulers.md) rather than
only here, because a rule that lives in one inbox filing is read by nobody.
