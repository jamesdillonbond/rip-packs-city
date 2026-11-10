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
