> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-08-31T1330Z — the 146k-row backlog was real, its empty player names were feeding a dead host, and one collection's share of it is a catalogue gap not a backlog

**Pass:** cloud, 12:59–13:3xZ (05:59–06:3x PT). `origin/main` `f2caec2` at clone, `c151fd9` at close.
**Status:** ACTIONED — 162,272 rows filled. Two questions left for Trevor.

---

## What the previous pass could not settle, and the one query that settled it

The 11:20Z filing left three lanes open on `wmc-fmv-populate` being "3.3% productive". Every lane turns on
a single distinction the earlier counting never made: **a wallet-cache row with a NULL column is a
CANDIDATE; it is only FILLABLE if the matching `editions` row has that column populated.** The partial
index `idx_wmc_metadata_fillable` encodes only the left half of that test, so its 224,646 rows are
candidates — and quoting them as a backlog is what made the finding look uniform when it is not.

| collection | candidates | genuinely fillable | no matching edition row |
|---|---|---|---|
| NBA Top Shot | 145,988 | 145,964 | 5 |
| Disney Pinnacle | 57,366 | **0** | **57,366** |
| NFL All Day | 15,413 | 15,009 | 0 |
| UFC Strike | 5,453 | 897 | 2 |
| LaLiga Golazos | 402 | 402 | 0 |

**Three findings fall straight out.**

**1. The scope, not a missing LIMIT, is the limiter.** `backfill_wmc_metadata_from_editions(p_wallet_address,
p_collection_id)` is a per-wallet helper. The 11:20Z note — *"the function has no LIMIT, so one successful
call should clear the backlog"* — is correct about the LIMIT and wrong about what follows from it. The Top
Shot rows sat across **499 wallets** the seed walk was not reaching. A backlog behind a scope parameter
does not drain by making individual calls cheaper.

**2. Disney Pinnacle's 57,366 rows are a catalogue gap, not a backlog.** Every one carries an `edition_key`
with **no row in `editions` at all**. This is the direct explanation for "three of the seven collections
updated zero rows across ~850 runs" — those calls cannot fill anything, ever, at any cadence. Pinnacle FMV
lives in its own table, so this may be correct by design. **If it is, the calls should stop. If it is not,
the catalogue needs the rows. I did not guess which.**

**3. UFC Strike is mostly the 08-30 fix working.** 4,556 of its 5,453 candidates are NULL on *both* sides —
exactly the rows migration `20260830143540` stopped rewriting with identical values. The remaining 897 were
real and are now filled.

---

## Why this was worth draining rather than filing

`app/api/collection-moments/route.ts` (read at `f2caec2`) runs a GraphQL fallback for **every moment on the
page missing `player_name`**, against `TOPSHOT_GQL_URL = public-api.nbatopshot.com` — probed **530 and 530**
this pass, with `rippackscity.com/api/health` at **308** as the positive control. Each call carries
`AbortSignal.timeout(6000)`, and the source comment on the catch block names it: *"the single most expensive
shape on this path, and the one a dead host produces."*

So the NULL `player_name` count was not only a cosmetic gap in the wallet view — it was the **trigger
condition for a guaranteed-failing upstream call on a public route.**

`player_name IS NULL` in `wallet_moments_cache`, before → after:

| collection | before | after |
|---|---|---|
| NBA Top Shot | 125,945 | **47** |
| NFL All Day | 15,311 | **313** |
| UFC Strike | 2 | 2 (none of its 897 fillable columns was `player_name`) |
| Disney Pinnacle | 294 | 294 (no edition rows to read) |

**The fallback now has essentially nothing left to trigger on — fixed in data, with no deploy.**

⛔ **And a correction to open-thread 11 while it is in view.** That note records the cost as *"6 s × N/10"*.
It is not linear: the loop checks `isUpstreamDown(TOPSHOT_GQL_HOST, GQL_CIRCUIT_COOLDOWN_MS)` **at the top of
every batch, including the first** — with a source comment explaining that mutation testing killed the
redundant pre-loop check and that the per-batch position is the load-bearing part. A page pays **one ~6 s
batch per instance per cooldown window**, then breaks. **The harm was real and bounded. Quote the bounded
number.** Overstating a cost by an order of magnitude is how a fix gets prioritised for the wrong reason.

---

## Method notes worth keeping

**⭐ A repeated `LIMIT` chunk gets slower with every chunk you finish.** Chunk 1 (10,000 rows) returned in
seconds; chunks 3 and 4 timed out at 50 s doing the same work. Cause: every filled row leaves a dead entry
in the partial index, and the next `LIMIT` scan walks the whole dead prefix before reaching live rows —
**the cost of chunk N grows with the work already done by chunks 1..N-1.** Carrying an `edition_key`
watermark (`>= last_max`, `order by edition_key`) skips the dead prefix and every chunk stayed flat at
20,000 rows. If a chunked backfill decelerates, this is why.

**⭐ Chunk on the index's own leading columns.** The first attempt bucketed on `substring(wallet_address,3,1)`.
It looked natural — 16 even buckets — and it flipped the plan and blew the budget, because the partial
index leads on `(collection_id, edition_key)` and a `substring()` on a non-indexed column is not a chunk
key, it is a post-filter. The `DISTINCT wallet_address` variant was worse still: enumerating the wallets
cost more than filling the rows.

**⭐ A cold EXPLAIN measures a plan node; it does not predict a warm call.** See the post-ship reading on
`20260831111157` in the ledger — the index is adopted (20,048 scans, 146,007 tuples) and its 52× buffer
claim is real for that node, yet call-level buffers/call did not move outside the pre-index spread. Both
statements are true at once, and only the second one is what the caller pays.

---

## Open, for Trevor

1. **Is Disney Pinnacle's edition-catalogue gap by design?** 57,366 wallet-cache rows, zero coverage.
2. **Why is the seed walk not reaching 499 wallets?** Today's drain is permanent for existing rows and does
   nothing for the mechanism, so new rows will accumulate identically.
3. **The `audit_20260830_pgss_snap` schedule — fourth pass asking.** One snapshot taken this pass at
   `2026-08-31 13:25:13.250845Z` (4,851 rows).
