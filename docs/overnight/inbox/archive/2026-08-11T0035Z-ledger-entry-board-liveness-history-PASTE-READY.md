# Paste-ready ledger entry — append at the TOP of `docs/overnight/ledger.md`

⚠ Written as a separate file deliberately: do not let a cloud session write `ledger.md`.

---

### 2026-08-10 · SHIPPED — DB (Cowork cloud) · the board-liveness sweep had no persistence store, so its own "trust only persistent breaches" rule was unactionable

The honest sweep (`4fbb7a7c`, jobid 288 `28 */6`) closed the `count(*)`-pruning blindness and its author drew the right conclusion from the result: on this instance **a single honest timing is not trustworthy** — measured 20 minutes apart, `candy_pack_ev_model` went **94,508 ms → under budget** and `panini_squeeze_board` **>60,000 ms → 4,284 ms**. Cache residency dominates, so the only trustworthy signal is a board that breaches **persistently across sweeps**.

**Verified live: there was nowhere to read that from.** `public_board_liveness_state` holds **45 rows / 45 distinct `view_name` / exactly ONE distinct `checked_at`** — it upserts one row per board and keeps no history; each sweep overwrites the last. The sweep writes no `pipeline_runs` row either (checked `prosrc` for all three functions). So the rule was correct and unactionable.

**Shipped `20260811003456_audit_20260810_board_liveness_history_decoupled_capture`** — deliberately **DECOUPLED**, with **zero edits** to `public_board_liveness_sweep()` / `public_board_liveness_probe()` / `rpc_thp_leg_board_liveness()`, all shipped ~1 h earlier by a concurrent session:

- `public_board_liveness_history`, created `LIKE public_board_liveness_state` (so column types cannot drift from the source) plus `captured_at`, PK `(view_name, checked_at)`, index on `checked_at DESC`.
- `capture_board_liveness_history()` — appends the current state rows `ON CONFLICT DO NOTHING`, prunes >90 days, returns `{inserted, pruned, at}`.
- pg_cron `rpc-capture-board-liveness-history` at **`51 */6`** — the sweep starts `:28` and takes ~202 s (done ~:32), so this leaves ~20 min of margin. `:51` is a free minute (the `*/2` job occupies even minutes only).

**Idempotent by construction and honest about absence:** keyed on `(view_name, checked_at)`, so a re-run appends nothing (verified: 2nd call `inserted: 0`) and a **failed or skipped sweep appends no row at all** — missing history is then evidence the sweep did not run, rather than a silently duplicated one.

**Verified after apply:** seed inserted **45**; second call **0**; RLS **on**; **0** anon/authenticated/PUBLIC table grants; `anon` EXECUTE on the function **false**; `check_public_security_invariants()` **[]**; `check_secdef_anon_exec_drift()` **[]**; cron entry `51 */6` active; **83 active jobs** (81 + sweep 288 + this).

**What it unlocks — the triage query the sweep's own caveat asks for:**

```sql
SELECT h.view_name,
       count(*)                                   AS sweeps,
       count(*) FILTER (WHERE h.elapsed_ms > w.max_ms) AS breaches,
       round(avg(h.elapsed_ms))                    AS avg_ms,
       max(w.max_ms)                               AS budget
  FROM public.public_board_liveness_history h
  JOIN public.public_board_liveness_watchlist w USING (view_name)
 WHERE w.is_active AND h.checked_at > now() - interval '7 days'
 GROUP BY h.view_name
HAVING count(*) FILTER (WHERE h.elapsed_ms > w.max_ms) >= 3   -- persistent, not a cache miss
 ORDER BY breaches DESC, avg_ms DESC;
```

⚠ **It needs several sweeps before it says anything** — at `28 */6` that is 4/day, so ~2 days for a usable `>= 3` threshold. Until then the 13 currently-over-budget boards remain a snapshot, not a ranking.

**Target metric:** the 13 breaching boards become separable into persistent vs cache-miss.
**Revert (DB):** `SELECT cron.unschedule('rpc-capture-board-liveness-history'); DROP FUNCTION public.capture_board_liveness_history(); DROP TABLE public.public_board_liveness_history;`
**Revert (repo):** `git revert <sha>` removes the file only.
