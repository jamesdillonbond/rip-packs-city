# `panini-set-progress-products` read-timeout — the Panini sibling of the already-filed All Day set-progress full-FMV read (1715Z)

Filed 2026-11-10 ~11:10 AM PT (19:10Z) by the daytime health monitor. Read-only finding; nothing was changed. **Not a spell** — positive control at 19:09Z read `io_wait 0 / active 6`, so this is a real read-timeout, not saturation collateral.

## What was observed

- Vercel runtime errors, last 6 h (team `team_YWGCVToPBJSS60NgVh8jiCFV`, project `prj_YBJ6Utl32GfyBOIzbsp3kbshJh96`): a new group
  `[api/panini-set-progress] code=timeout detail=RPC_READ_TIMEOUT [panini-set-progress-products] read exceeded 8000ms`
  — **first = last = 2026-11-10T16:06:48Z**, count 1, users 1, on `lastDeployment=dpl_GGvTG9zhQevta9ZYqbT43sQG39kc`. It appeared for the first time today (no earlier first-seen), one minute before the All Day sibling's latest hit (16:08Z).
- The already-filed sibling `inbox/2026-11-10T1715Z-allday-set-progress-reads-the-whole-fmv-snapshot-set-per-call.md` root-caused `/api/allday-set-progress` → `get_allday_set_progress` recomputing the latest non-null FMV for **every** All Day edition on each call (63,233 buffers, ~3.4 s read I/O warm), and showed the obvious cached-table swap (`edition_fmv_current`) is NOT a drop-in (196 editions present only in the per-call CTE).

## Risk read

LOW-to-MEDIUM, and almost certainly the **same class** as 1715Z: both are `*-set-progress` endpoints with an 8 s RPC read budget, and the All Day one was proven to miss that budget cold because it streams the whole collection's FMV population per call. One occurrence so far, one user, degrades to a slow/failed read for that user (no wrong number published — a timeout, not a fabrication). Panini is the largest collection by editions (44,370), so a per-call full-population FMV read there would be at least as heavy as All Day's.

## Suggested action (for the nightly pass — NOT done here)

Quiet-window **re-measure**: pull the `panini-set-progress-products` RPC body (likely `get_panini_set_progress` or similar), `EXPLAIN (ANALYZE, BUFFERS)` it for a large Panini wallet, and confirm it carries the same per-call "latest non-null snapshot for every edition" CTE as `get_allday_set_progress`. If so, fold it into the **same fix** the night pass lands for 1715Z (the same cached-table-is-not-a-drop-in caveat about the ~0.4 % of editions present only in the non-null CTE applies — verify the Panini delta before swapping). Do not fix in isolation; treat 1715Z + this as one set-progress read-budget item so the class is closed together, not half-closed.

## ✅ RESOLVED 2026-11-10 ~12:05 PM PT (Claude Code cloud) — `20261110195805` + `20261110200203` + route change

**Not the All Day class.** The Panini functions read listed asks from `panini_card_serials`, not FMV snapshots, so the 1715Z `edition_fmv_current` swap had no Panini analogue. Two separate costs, both measured:

1. **Every read computed every product.** `panini_set_progress_products` wrapped `panini_set_progress_all`, which computes the market-wide 7-day low ask over ~296k listed serials (~1.1 s, 64k buffers) the picker never uses; and the route filtered `panini_set_progress_all(...)` on `product_set_id` AFTER it returned (a SQL function with `SET search_path` is never inlined). Fixed: the picker counts without asks; the sets table calls the new `panini_set_progress_for_product(p_username, p_product_set_id)`, which scopes to the product first and reads the low ask per edition (World Cup, the largest product: 64,104 → 23,981 buffers). Equivalence before applying, pg_temp copies vs live at one instant: picker 448 rows / 4 usernames, sets 389 rows / 3 products × 3 usernames, `EXCEPT` both ways 0.
2. **A big holder's "what do I own" read was a heap fetch per card.** The `(lower(owner))` key carried only `owner`. `Jascar` (141k cards): picker **84.1 s / 195,291 blocks** — that collector's Sets tab could never load. New covering index `idx_panini_serials_owner_lower_cover` (CIC via one-off pg_cron 855, 2 m 13 s, 442 MB, valid; postgres timeout reset, job removed): picker **173 ms / 8,802 blocks**, sets read for his main product 0.75 s.

Route: `app/api/panini-set-progress/route.ts` calls `panini_set_progress_for_product`; `__tests__/api-panini-set-progress.test.ts` now asserts the product is an ARGUMENT and no post-hoc `.eq` is applied (reverting the route reds 3 tests). `panini_set_progress_all` is unchanged (concierge reader). Follow-up for a later pass: `idx_panini_serials_owner_lower_incl` is now a strict subset of the new index — drop it once its `idx_scan` stops moving (baseline 260,775 at 12:01 PM PT 11-10).
