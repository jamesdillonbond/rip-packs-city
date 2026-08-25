# All three Flowty listing caches hold EXACTLY 100 rows, because Flowty's `offset` does not paginate — at least 5,000 are obtainable in a single request

**Filed 2026-08-24 ~23:20 PT (2026-08-25 06:20Z), Claude Code interactive on Trevor's Windows box.
MEASURED against the live upstream and the live DB. NOT SHIPPED — see §6, this is a cost decision, not a bug fix.**

---

## 1. The number

| | Top Shot | All Day | Golazos |
|---|---:|---:|---:|
| rows in `cached_listings` where `source='flowty'` **(live)** | **100** | **100** | **100** |
| unique listed NFTs obtainable in ONE request at `limit: 5000` | **5,000** | **5,000** | 440 listed of 5,000 returned |
| of those, usable by the route's own parser (LISTED + `id` + `listingResourceID` + price) | **5,000** | — | — |

🚨 **Three different collections, three different markets, all sitting on exactly 100.** A market does not
independently produce exactly 100 listings three times. **A `PAGE_LIMIT` does.**

## 2. The mechanism — `offset` does not advance

Measured directly against `api2.flowty.io` (the same endpoint `supabase/functions/flowty-proxy` forwards to,
verbatim — it passes `payload` straight through):

- Fetching offsets **0, 100, 200, 300, 400** at `limit: 100` = **500 rows fetched → 103 UNIQUE.**
- offset=100/200/300 each overlap offset=0 by **97 of 100**; offset=**400** overlaps by **100 of 100**.

So each page returns essentially the same set. `app/api/topshot-listing-cache/route.ts` then hits its own
`consecutiveStaleSeenPages >= 2` early-break — added to *"tolerate a single page where every flow_id was
already seen"* — and **terminates gracefully, logging `ok: true`**. Production confirms it:

```
stage=fetched page=0 offset=0   fetched=100 reportedTotal=10000
stage=parsed  page=0 pageRowsAdded=100
stage=fetched page=1 offset=100 fetched=100 reportedTotal=10000
stage=parsed  page=1 pageRowsAdded=0        ← 100 fetched, ZERO new
stage=fetched page=2 offset=200 fetched=100 reportedTotal=10000
stage=parsed  page=2 pageRowsAdded=0
```

⚠ This is the *"green pipeline blind to its own work"* class: a bounded scan reporting `ok`. `skipDuplicateInRun`
averages **258 of ~359 fetched per run** across the last four days — the waste is already in the telemetry,
under a name that reads like normal dedup.

## 3. ⚠ WHY NOBODY NOTICED: `total` IS A PLACEHOLDER, AND I PROVED IT

Every page reports `reportedTotal=10000`. That is the only number available to detect a shortfall, and it is
**not a count**:

| request | reported `total` |
|---|---:|
| `filters:{listingKind:"sale"}, limit:100` | 10000 |
| **no filter at all**, `limit:100` | **10000** |
| `filters:{listingKind:"sale"}, limit:500` | 10000 |

**Identical with and without the filter, and suspiciously round.** It is a cap or an unfiltered placeholder,
so `offset + PAGE_LIMIT >= reportedTotal` — the loop's intended completeness test — can never fire, and no
instrument in the estate could have flagged the gap.

## 4. 🚨 THE TELL WAS WRITTEN DOWN TWICE, IN THE ROUTES' OWN COMMENTS

This is the part worth keeping, because it is a reasoning failure rather than a coding one.

- `topshot-listing-cache`: *"the previous `PAGE_LIMIT=50` runs at ~56 listings/run"* → raised to 100 → now
  **~100 listings/run**.
- `allday-listing-cache`: *"previous `PAGE_LIMIT=24` with only 3 offsets was capping runs at ~48"* → raised to
  50 with 10 offsets → now **100 rows**.

**Both times the observed book size tracked the page arithmetic. Both times the response was to raise the
limit.** ⚠ **When your measured population equals your own page size, the population is not what you
measured** — and this repo has now recorded that symptom twice without naming it.

⚠ A third instance of the same misreading: Top Shot's comment says `listingKind:"sale"` was added because
*"the loop hit the 'no new flow_ids' early-break after 1-2 pages"*. **That filter did not fix the early break
— production still breaks after 3–4 pages.** The symptom was treated as a data-quality problem; it is a
pagination problem.

## 5. The lever, and it is one line

`limit: 5000` in a **single** request returns all 5,000 — no pagination needed, so the broken `offset` stops
mattering. Measured timings against the upstream (residential egress):

| limit | wall time | payload |
|---:|---:|---:|
| 100 | 1.27 s | 0.6 MB |
| 1000 | 1.74 s | **5.96 MB** |
| 5000 | 6.49 s | **29.9 MB** |

⚠ **`limit: 5000` fits inside `flowty-proxy`'s `AbortSignal.timeout(12000)` residentially (6.5 s) but the
proxy does `await upstream.json()` then `JSON.stringify(data)` — ~60 MB of churn in a Supabase edge isolate.**
**`limit: 1000` is the conservative option: 10× today's coverage for 6 MB and under 2 s.**

## 6. ⛔ WHY THIS IS NOT SHIPPED, and it is NOT just the off-limits rule

`cached_listings` feeds the flagship **sniper/deals board** (`SniperClient`), `/api/alerts`, `purge-stale-listings`,
`warm`, and the **ASK side of FMV** (ask-corroboration + the ASK clamp). A 10–50× volume change touches all of
them at once:

1. 🚨 **IO COST ON A SATURATED INSTANCE.** Register **R46** is explicit that disk IO is the binding constraint
   and that the standing instruction is to read it **before proposing any new recurring IO**. This route runs
   **every 20 minutes — 72 ticks/day**. Going 100 → 5,000 rows/tick is **~360,000 upserts/day against ~7,200
   today**. **That is a decision about cadence AND volume together, not a constant.**
2. **FMV is downstream.** More ASK rows changes what the ASK clamp and ask-corroboration see. That is pricing
   behaviour, and CLAUDE.md puts FMV/ingest route logic off-limits for autonomous change.
3. **The deals board would go from ~100 candidates to thousands.** Almost certainly good, but it is a product
   surface change that should be seen before it ships.

➡ **Recommended shape if taken: `limit: 1000`, single request, no offset loop, and consider halving the cadence
in the same change so net write volume rises ~5× rather than ~50×.**

## 7. What I did NOT establish

- ⛔ **Whether 5,000 is the whole book.** `limit: 5000` returned exactly 5,000 — a round number, so it may be
  a cap of its own. I did not probe higher. **The true book size is unknown and ≥5,000.**
- ⛔ **Whether Golazos's 440-of-5,000 means its listed book really is ~440**, or that `listingKind:"sale"` is
  applied inconsistently per collection. Its cache is also pinned at 100, so it is under-collecting either way.
- ⛔ **Whether Supabase edge egress behaves like residential egress** for a 6–30 MB response. My timings are
  from Trevor's box, and this session already recorded once today that **this box is a different egress and
  cannot attribute timing** — that lesson applies here too. **Re-measure through the proxy before choosing a limit.**
- ⛔ **Any user-facing impact claim.** I did not measure how many additional deals the board would show, only
  how many listings exist to draw from.

## 8. A separate, smaller defect found in the same read (also not shipped)

The pagination loop `break`s identically on a **legitimate end** (`nfts.length === 0`, short page, stale-seen)
and on an **error** (`!pageResp` from a thrown fetch, or `status >= 400`), and nothing downstream can tell them
apart — `stats` carries no completeness flag. The stale purge is then gated only on `stats.upserted > 0`, which
is satisfied by any successful page. **So a mid-sweep upstream failure yields a partial set and then purges
everything older than `runStartedAt`.** ⓘ Blast radius today is small precisely *because* of the bug above —
the book is 100 rows and the next tick is 20 minutes away — **but it grows with any fix to §5.** They should
be fixed together: a `sweep_complete` flag gating the purge, exactly as `ingest/candy-offers` already does
with `degradedSweep`.

---

## ⛔⛔ CORRECTION — 2026-08-24 ~23:35 PT, ~20 minutes after filing. **§6's IMPACT list is WRONG in two places. The mechanism stands; the blast radius is much smaller.**

I named the consumers of `cached_listings` from a `grep -l` for the table name and did not check what each hit actually does. **Two of the three surfaces I named do not read this table.**

### ⛔ WRONG: "feeds the flagship sniper/deals board (`SniperClient`)"

- **`/api/sniper-feed` reads `ts_listings`**, not `cached_listings`.
- **`SniperClient` never queries it** — its only occurrence is inside a COMMENT (`// … cached_listings, which corresponds to deal.momentId …`). **A bare-name grep counted a comment as a consumer**, which is the same mistake this repo's guards keep having to strip comments to avoid.

### ⛔ WRONG: "and the ASK side of FMV (ask-corroboration + the ASK clamp)"

`app/api/fmv-recalc/route.ts` says so in its own words:

> *"The former Step 2b (Flowty LiveToken FMV blend) and Step 2c (floor-ask proxy) read from `cached_listings`, which now holds only ~24 frozen multi-week-stale rows. FMV is now purely sales-based (outlier-filtered WAP + trimmed-median fallback). **Both code paths were removed 2026-05-24.**"*

**`fmv-recalc` does not read `cached_listings` anywhere.** FMV is not downstream of this bug.

### ✅ WHAT ACTUALLY READS IT — verified per file, `from("cached_listings")` only

`/api/market` (as the **legacy fallback**), `/api/golazos-sniper-feed`, `/api/profile/market-pulse`,
`/api/wallet-search`, `/api/fast-break/optimize`, `/api/support-chat/context`.

⚠ **AND THERE IS A `cached_listings_v2` HOLDING 186,300 ROWS THAT I HAD NOT NOTICED.** `/api/market`'s own
header states the split:

> *"The legacy `cached_listings` table the route below reads from is post-Flowty-teardown dead for TS (0 rows)
> and stale for AllDay (~2 weeks). Modern data lives in `badge_editions` (TS) and `cached_listings_v2`
> (AllDay/Golazos/UFC) … Other collections fall through to the legacy `cached_listings` query below."*

**So Top Shot and All Day — the two collections whose under-collection I measured at 50× — have already been
migrated off this table for the Market surface.** ⓘ That header is itself now partly stale in the other
direction: it says TS has **0 rows**, and TS has **100** today, because the 2026-07-07 re-scope found Flowty's
API alive and the listing-cache pipelines were revived.

### ➡ WHAT THIS CHANGES

- **The MECHANISM is untouched** — `offset` does not paginate (500 fetched → 103 unique), the cache is pinned
  at exactly 100 per collection, ≥5,000 are obtainable in one request, and the page-size tell in §4 stands.
- **The SEVERITY drops from "the flagship board sees 2% of the market" to "a LEGACY table, still written every
  20 minutes by three live pipelines, is capped at 2% — and its remaining consumers are the Market tab's
  non-TS/AllDay fallback plus five smaller surfaces."**
- ⚠ **AND IT STRENGTHENS §6's CONCLUSION RATHER THAN WEAKENING IT.** Raising the limit would add ~360,000
  upserts/day to a table the product has been **migrating away from**. **The real question is no longer "what
  limit?" — it is whether `topshot/allday/golazos-listing-cache` should still be writing `cached_listings` at
  all, or whether the remaining six consumers should move to `cached_listings_v2` / the sniper RPCs like TS and
  AllDay already did.** That is a bigger and better question than the constant.

### ⚠ THE LESSON, and it is the THIRD time today

**Name the caller before you claim the impact.** I applied that rule to COMPONENTS earlier tonight — and had
to retract a user-impact claim when two turned out to be production-dead — then failed to apply it to a TABLE
within the hour. ⚠ **A `grep -l` for a table name is a list of files that MENTION it, not a list of consumers.**
The check that settles it is `grep -n 'from("<table>")'` per file, plus reading what the hit does.
