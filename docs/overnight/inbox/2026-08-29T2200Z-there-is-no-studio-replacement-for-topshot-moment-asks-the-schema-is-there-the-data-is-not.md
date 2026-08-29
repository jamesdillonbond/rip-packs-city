# ⛔ There is NO Studio replacement for Top Shot moment asks — the schema is there, the data is not

**Filed 2026-08-29 ~22:00Z (15:00 PT). Status: MEASURED, DECISION-GRADE, NOTHING SHIPPED.
This answers step 1 of [2026-08-29T1810Z](2026-08-29T1810Z-the-studio-endpoint-has-searchTopShotMarketplaceHistory-and-a-june-decision-deferred-it-on-a-now-dead-premise.md),
which asked for a fresh introspection "from an environment with egress".**

## How the egress was obtained

The agent proxy denies **both** hosts to this sandbox (`403 Host not in allowlist`), so the
probes were dispatched from the **database** via `net.http_post` and read back from
`net._http_response`. ⭐ **That is a general-purpose lever this repo had not used for
schema work: pg_net is an egress path that is neither the sandbox nor a deploy.** Latency is
~1–3 minutes per request through the queue, so batch the probes.

## Result 1 — EXHAUSTIVE introspection, not a "did you mean" guess

`__schema { queryType { fields { name } } }` returns **63 root fields**. The Top Shot ones,
in full:

`getTopShotTag`, `searchTopShotNft`, `searchTopShotNftAggregation`,
`searchTopShotMarketplaceHistory`, `searchTopShotVipNft`,
`searchTopShotVipNftAggregation`, `searchTopShotVipMarketplaceHistory`.

⛔ **No `searchTopShotEditions`.** `searchAllDayEditions`, `searchGolazosEditions` and
`searchPinnacleEditions` all exist — Top Shot is the one collection with no editions root
field. The 1810Z filing flagged its June list as "explicitly non-exhaustive" and treated the
absence as weak evidence; **this introspection is exhaustive, so the absence is now proof.**

## Result 2 — and the schema said the migration WAS possible

`searchTopShotNftAggregation` looked like a complete substitute for the dead
`searchMarketplaceEditions`:

- `TopShotNftAggregation.listing: ListingAggregation` → `price: UInt64Aggregation` with
  fields `min, max, avg, key, counts, value` — **a per-group minimum ask.**
- `TopShotNftAggregation.edition: TopShotEditionAggregation` → `id`, `set`, `play`,
  `series`, `tier`, `total_minted` — **the group key.**
- `TopShotNftFilter` accepts `edition`, `listing`, `sub_edition`, `owner_address` and
  **`tags: TopShotTagListFilter`** — the badge sweep's filter, by name.

Every one of those validated against the live server. On schema evidence alone this was a
green light for migrating `offers-sweep` — the highest user-facing item on the board, the
reason every Top Shot low-ask on the site is a day stale.

## 🚨 Result 3 — THE DATA IS NOT THERE, AND IT ANSWERS `200 OK` WITH ZERO

| probe | filters | totalCount |
|---|---|---|
| `searchPackNftAggregation` (Top Shot packs) | sealed + DUC + `type_name` | **1,998** ✅ |
| `searchAllDayNft` | `listing.exists` | **338,533** ✅ |
| `searchTopShotMarketplaceHistory` | none | **34** ✅ |
| `searchTopShotNft` | `listing.exists` | **0** ⛔ |
| `searchTopShotNft` | **none at all** | **0** ⛔ |
| `searchTopShotNftAggregation` | `listing.exists` (+ `type_name`, + DUC vault) | **0** ⛔ |
| `searchTopShotNftAggregation` | **none at all** | **0** ⛔ |

**Controls in both directions, as the null-result rule requires.** The pack probe rules out
the endpoint, the headers and my aggregation mechanics. The AllDay probe rules out the query
SHAPE — it is the same query against the sibling index and returns 338,533. The history probe
rules out "Studio does not serve Top Shot at all". **What is left is the narrow claim: the
Top Shot NFT/listing index on Studio is empty, while its AllDay twin is not.**

## ⭐⭐ The part worth carrying forward: the schema check would have shipped a data-destroying migration

`searchTopShotNftAggregation` returns **`{"totalCount": 0, "edges": null}` under a `200`**.
Not an error, not a 4xx, not a partial. A migration written off the schema — which validated
perfectly — would have run green on its first tick and **rewritten every Top Shot ask to
"no listings"**, which is this platform's most expensive defect class pointed directly at its
own database. ⭐ **This is CLAUDE.md's rule at the API boundary: an upstream that answers `200`
with zero is the same shape as `?? 0` on a failed count.** A schema is a claim about what
CAN be asked, never about what is there — **probe the data before migrating to a field, not
the type.**

## What this closes and what it leaves

⛔ **CLOSED — do not re-suggest without new evidence:** migrating `offers-sweep`,
`topshot-fmv-populate`, `topshot-badge-sync`/`badge-catalog`, or `topshot-moments-hydrator`
to studio-platform. There is no editions field and the NFT index is empty. The 1810Z filing's
⛔ column is **confirmed, for a better reason than it gave** — not "no such field" but
"the field exists and returns nothing".

✅ **STILL OPEN and unaffected:** the `searchTopShotMarketplaceHistory` sales-history lane
(1810Z, recommendation 3). It is the one Top Shot index on Studio with data, it augments by
`transaction_hash` dedup rather than replacing, and `lib/studio-sales-history.ts` already
takes a `queryName`. **⚠ Its value is a cross-check, not outage relief — sales history is
not the ask staleness, and shipping it must not be described as "migrating off the dead
endpoint".**

⛔ **NOT established:** whether the Top Shot NFT index is empty permanently or is a second
symptom of whatever took `public-api.nbatopshot.com` down (still `530 / error code: 1033`
at 21:26Z, ~28 h). A single re-probe of `searchTopShotNft` with no filters settles it — if it
ever returns non-zero, this filing's conclusion is void and the migration is back on.
👉 **That is the falsifier; it costs one query.**

⛔ **ALSO NOT established:** whether an authenticated session unlocks the Top Shot NFT index.
Every probe here was unauthenticated, matching the working pack client. AllDay returns 338k
unauthenticated, so auth is not obviously the discriminator, but it was not tested.

## ⚠ Unrelated exposure found while probing — needs Trevor

Reading `net.http_request_queue.url` to check queue depth printed a live pg_cron gate key
(`…/functions/v1/backfill-topshot-pack-sales?key=…`) into a session transcript. **The value is
not repeated here.** Two things follow: **that key should be rotated**, and **`net.http_request_queue`
should be treated like `get_edge_function` — never select `url` broadly**; select `id` and
`count(*)`, or mask with `split_part(url,'?',1)`. CLAUDE.md's secret-safety rule names the edge-function
tool and the DOM; this is a third instance of the same shape and belongs in that list.
