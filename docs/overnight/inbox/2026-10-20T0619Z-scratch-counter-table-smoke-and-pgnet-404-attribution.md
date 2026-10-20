# Daytime monitor candidates — 2026-10-20T06:19Z (≈2026-10-19 11:19 PM PT)

🟢 **GREEN infra pass.** Security invariants clean (`check_public_security_invariants()` = []), no stalled pipelines, no pg_cron failures, cross-collection refresh fresh (step1/step2 both `succeeded` daily; cohort 189 rows), FMV/editions drift all explained (Panini coverage growth; nba 1.8.x MEDIUM re-grade settling; DB 40,301 MB, +331 vs 10-19 night = normal). Trust health: 1 known breach only — `candy_sales_stale_hours` 194.8h (#58 OPENSEA_API_KEY, Trevor-only, climbing as expected, NOT re-logged). `topshot_missing_fill_offers_walk` forward re-seed is the ledger-declared deliberate weekly re-seed (10-19), NOT re-logged. `/api/ready` panini_sales 42501 and pinnacle-image MODULE_NOT_FOUND are both already CLOSED in the 10-19 2112Z filing — NOT re-logged. Run coincided with an active Claude Code live-shipping window (prod deploys every ~40s, all READY, zero ERROR).

Two NEW low-risk housekeeping candidates:

---

## 1 · LOW · Leftover `scratch_20261019_counter_checks_before` was the root cause of the 04:42–05:34Z smoke / analytics-smoke failures; now RLS-masked — drop it

- **Source:** Vercel runtime errors `/api/smoke-test` — `report` + `SMOKE-TEST HARD FAILURES`, both `rls_off_base_table:scratch_20261019_counter_checks_before` (10 occ, last 2026-10-20T05:34:22Z); matches `pipeline_runs` `analytics-smoke` `1 fail(s)` at 04:43/05:13/05:43Z. Ledger 10-19 ~10:40 PM PT CORRECTION already noted this scratch table "was NOT dropped".
- **State now (verified 06:11–06:19Z):** the table still exists (`relkind=r`) but `relrowsecurity=true`, so the public-security-invariant breach is CLEARED — someone enabled RLS on it between 05:34 and 06:11Z, which is why the 06:11 `rpc_ops_snapshot` reads `rls_off_base_tables []`. The next smoke tick (:13/:43) should read green. The RLS-on is a workaround masking a leftover table, not a fix.
- **Risk:** low — it is a read-side scratch table from the 10-19 supply-counter-check work; nothing live reads it.
- **Suggested action (night pass):** confirm no reader, then `DROP TABLE public.scratch_20261019_counter_checks_before;` (removes both the leftover and the RLS-on workaround). Also drop the two older `scratch_20261010_rip_*` tables if likewise spent. Verify the next `analytics-smoke` / `/api/smoke-test` tick reads clean after the drop.

## 2 · LOW · `pg_net_http_404` arm shows 9 un-attributable HTTP 404s / 2h with a Next.js `__next_error__` body — likely a cron/pg_net dispatch against a route changed in the heavy 10-19 sweep

- **Source:** `rpc_ops_snapshot` `pipeline_alerts` → `pg_net_http_404` (severity high, 9 calls in 02:00:00, body is our own app's `__next_error__` page with `dpl_6rzwqB4ZNajGYA5AAPhj1nX3PVWc`). A sibling `pg_net_http_403` (severity critical, 2 calls) carries a Cloudflare "Just a moment" body = the self-inflicted-probe reading, benign. The 404 body being OUR app (not an upstream) is the one worth attributing. Not present in the 10-19 08:06Z metrics baseline pipeline_alerts summary.
- **Context:** the 10-19 sweep deleted `/api/migrate-acquired-at` and changed many routes; a pg_cron/pg_net job still dispatching to a retired or renamed path would answer `__next_error__` 404 while pg_cron logs `succeeded` (dispatch worked, no `pipeline_runs` row).
- **Risk:** low, read-only correlation; the arm is ambiguous by design and loses nothing.
- **Suggested action (night pass):** join recent `net._http_response` 404 ids to `net.http_request_queue` (URL lives there until drained) to name the endpoint; if it is a retired route still on a schedule, point the dispatch at the live route or retire the job. If it settles to 0 on its own on the next window, drop.
