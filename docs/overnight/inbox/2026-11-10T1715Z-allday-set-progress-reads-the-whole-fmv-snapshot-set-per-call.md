# `get_allday_set_progress` streams every All Day FMV snapshot on each call — 8 s read budget missed cold; the cached table is NOT a drop-in

Filed 2026-11-10 ~9:15 AM PT by Cowork cloud (platform audit pass, sixth round). Read-only finding; nothing was changed.

## What was read

- Vercel runtime errors, last 5 h: `/api/allday-set-progress` → `[api/allday-set-progress/get_allday_set_progress] read exceeded 8000ms`, 8:08 AM PT (my own headless load of `/nfl-all-day/sets` for a 3,798-moment wallet — the tracker did not render inside 22 s; a second load minutes later did). Same group first seen 11-08 6:08 PM PT.
- `EXPLAIN (ANALYZE, BUFFERS)` of the function for that wallet, 9:05 AM PT, a warm-ish box: **63,233 buffers (53,267 hit + 9,966 read), 3,385 ms of read I/O, 3,691 ms total.** The route's own warm time was 4.2 s.
- The body (`md5(prosrc) = 074174a9…`, SQL-language, SECURITY DEFINER, service_role only): the `edition_fmv` CTE is `SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots WHERE collection_id = p_collection_id AND fmv_usd IS NOT NULL ORDER BY edition_id, computed_at DESC` — the latest non-null price for every All Day edition, recomputed per call whatever the wallet holds.

## Why it was not fixed here

The obvious lever is `edition_fmv_current` (latest snapshot per edition, PK on `edition_id`). **It is not equivalent**, measured over the whole All Day population:

| | rows |
|---|---|
| CTE (latest NON-NULL snapshot) | 5,735 |
| `edition_fmv_current` with a non-null price | 5,539 |
| in the CTE only | **196** |
| in both, price differs | 4 (sum of differences $0.30) |

So 196 editions carry a price in the tracker's "cost to complete" that their newest snapshot has withdrawn. Swapping the source changes those 196 answers. Which reading is right — the last price ever published, or no price once the newest snapshot has none — is a product call on an accuracy surface, not a performance change. `check_edition_fmv_current_source_drift(1)` also read **3** at the time (it is a ban at zero).

## Options

1. Decide the 196: if a withdrawn price should not price a missing piece (my reading — the Sets tab already prints "—" for an unpriced set), point the CTE at `edition_fmv_current` and the function drops to a few thousand buffers.
2. Keep today's semantics and make it cheaper: restrict the snapshot read to the editions the wallet is MISSING (the only ones summed), via a per-edition lookup; measure buffers before shipping, the index must carry `fmv_usd`.
3. Leave it: the route already answers a timeout with an honest retry state; this is a slow first load for large wallets, not a wrong number.

## Also seen, same pass (no action taken)

- **Fast Break** is still a "Coming soon" tile on `/nba-top-shot/play` (parked "hidden for launch", `components/play/PlayHub.tsx`), while roadmap-status #8 says its projections lane has been live since 10-23. Un-parking is a launch decision and wants an in-season QA of the optimizer first.
- **"Candy MLB" label — decided: keep.** Read line by line, 30+ of the 105 code lines that print it are true statements about the MLB product (ICONs board, MLB pack market, team and player pages, ESPN stats, the published checklist), the live market and the search term are MLB, and the non-MLB legacy collections hold 1 priced edition of ~21,000. A blanket rename to "Candy" would make more copy wrong than right. Reverses the "Candy" recommendation in the fifth-pass handoff.

## ↳ 9:45 AM PT — the 196 were read, and this is an accuracy defect, not only a slow read

All 196 editions have a NEWER snapshot than the one the tracker uses, written 11-03 → 11-10 by `cold-tail-1.0` with confidence `NO_DATA` and a NULL price: the pricing engine withdrew those prices. The tracker still sums the withdrawn figures into "cost to complete" — **$78,407.10 across the 196, one of $4,999.50, the oldest dated 2026-05-10.** Every other surface shows those editions unpriced. So option 1 above is the right one, and `get_allday_set_detail` carries the identical CTE.

**Staged, not applied:** `docs/proposals/audit_20261110_allday_set_tracker_reads_current_fmv_cache-STAGED.sql` rewrites both functions from their live bodies under md5 guards (`074174a9…`, `1ed93d19…`). `apply_migration` was refused for this session ("Modify Shared Resources"). Before-reading for the post-check: wallet `0xbd94cade097e50ac` total cost to complete $423,045.11 over 258 sets at 9:35 AM PT.

`get_ufc_set_progress` has the same CTE shape (closed market, prices frozen; not examined).
