> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-08-31T20:20Z — the pass was spending 18 M buffers to measure a 31 MB table, and both autonomous tasks are unbound

> ⚠ **SCOPE.** The push blocker here is specific to **this cloud session**. Trevor's machine and Claude Code push normally. **Commit the files as usual.**

## 1. Two tasks, both claiming a device, neither bound

`list_triggers`, read 2026-08-31T20:30Z:

- `trig_018AyNcnbCZuYb1Ztts6rbBR` — *"device-bound v2, folder-attached"*, `18 */2`, **enabled**, `bound_device = false`. This is the session writing this filing. No `mcp__remote-devices__*` tool exists in it; `git push --dry-run` → *"not in this session's authorized repository set"*.
- `trig_01AZzLzkTPp5xbSjK1EFmeCw` — the task v2 was supposed to supersede, `58 */2`, **still enabled**, also `bound_device = false`, next firing 20:58Z.

So **two** cloud-only passes run every two hours, 40 minutes apart, and each can apply migrations to production that neither can commit. **A binding cannot be added to an existing task** — v2 has to be recreated from the Claude desktop app on the machine itself. Disabling the superseded one needs one click: `update_trigger(enabled=false)` from this session returned *"requires approval"* with nobody present.

## 2. A migration existed only in prod

`20260831183251` (`get_player_top_sales`, applied 18:32:51Z) had a ledger entry and an inbox note but **no `APPLIED-COMMIT-ONLY.sql` doc**, so 8,648 bytes of `CREATE OR REPLACE FUNCTION` — revert path included — lived in `supabase_migrations.schema_migrations` and nowhere else. Recovered and verified byte-exact (md5 `fb3258af6fd0bcaf222dcd12a6af7466`, 8,648 bytes both sides). ⭐ A cloud pass should end by re-listing the versions it applied and confirming a Project doc exists for **each** one.

## 3. The instrument was the load

Ranking the pgss **diff** 18:59:35Z → 20:19:28Z (80 min): four snapshot-diff queries in the top five, **17,733,789 buffers / 71.5–78.0 s each** — ~53 M buffers and ~294 s of exec time spent measuring, in 80 minutes. `public.audit_20260830_pgss_snap` is 31 MB / 92,540 rows and carried **zero indexes**; the newest `at` is always outside the histogram (`n_mod_since_analyze` = one snapshot), so the planner estimated `rows=1` and picked a Nested Loop with a 3,894-page inner Seq Scan per outer row.

⚠ **ANALYZE was not the fix and was checked first** — `last_analyze` 19:06:59Z, `last_autoanalyze` 18:21:01Z, and the misestimate happened anyway, because the offending value is always the one inserted *after* the last ANALYZE.

Shipped `idx_audit_20260830_pgss_snap_at` (20260831202552) + exit condition (20260831202630). Full diff: **17,733,789 → 503 buffers**, 71,829 → 351 ms.

## 4. Recorded as a coincidence, not a cause

At **20:24:36Z, one single second**, twelve unrelated `/[collection]/pack/dist/[distId]` sub-reads all blew their 5,000 ms budgets on one render; `market_bundle`, `public/profile resolve`, `candy_scarcity_board` and a 30 s Vercel timeout fired at 20:22–20:26Z. That window is exactly when this pass was running the 17.7 M-buffer diff. **Not claimed as causation** — over 24 h those groups burst only twice and passes run every 2 h, so bursts do not track pass cadence. If they stop recurring at pass times now the index is in, that is the evidence.

## 5. Two carry-forwards

- **Item 19's trailing-window class should also name `snapshot-institutional-wallets` and `topshot-active-listings-ingest`.** Both alert today; both last failed on or before 2026-08-30T16:49Z; both have succeeded since.
- **`public.v_rpc_trust_health` exceeds 60 s.** The precomputed table behind it reads instantly, so the breach logic in the view is the slow part.
