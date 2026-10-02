# Handoff — 2026-10-02 autonomous pass (~7:15 → ~8:30 AM PT) · Claude Code (cloud)

> ⚠ Every environment note below is specific to **this cloud session**. Trevor's machine and Claude Code push normally via Git Credential Manager; the Supabase MCP confirmation hold described here only bites an UNATTENDED session. **Commit these files as usual.**

## Health verdict — GREEN, one known slow view
- Security invariants `[]`, anon write surface `[]`, secdef anon-exec drift `[]`, search_path drift `[]`, R118 `[]` (after the shape rule), zero-yield lanes 0, `get_pipeline_alerts()` no high/critical at 8:10 AM PT.
- Trust health 37/38 ok: `public_board_slow_count` = 1 (`panini_sale_feed_status` ~6 s; filed by the Cowork monitor pass this morning, not re-chased here).
- pg_cron 24 h: 1 failure (`rpc-wallet-reconstructed-rips`, fixed below) in ~17k runs. Vercel 24 h: chronic pack-detail cold-scan timeouts; two bursts (00:50, 02:08 AM PT) of `get_wallet_collection_snapshot` / `get_wallet_intel_summary` > 8 s + 3× `/api/edition-floor` 503 in the same second — one whale wallet's share-card load, not sized.
- Panini residential lanes silent since 7:49 PM PT 10-01 (box asleep); the concurrent session shipped and ran the wake/keep-awake scripts.

## Shipped (DB, 4 migrations, files committed)
| migration | what | revert |
|---|---|---|
| `20261002144052` reconstructed rips | daily job budget on the pg_cron COMMAND (`SET statement_timeout='600s'; …` — the function-header SET was INERT: killed at 120 s with it in place); smallest wallets first; per-wallet sub-txn; `WHEN query_canceled` record-and-exit; `WHEN OTHERS` per wallet continues. Catch-up run 8:14 AM PT: ok, 33 wallets, 22,118 rows, 118.7 s | header REVERT block |
| `20261002145518` offer-fill suppression | `topshot_offer_fill_backfill` cursor_stalled suppressed to 2026-12-31 with its predicate in the row; it is a trailing re-walk behind the LIVE `topshot-offers-indexer` (3,686 offer_fill sales / 7 d, median lag 0.17 h) scheduled on GHA's ~8 runs/day ceiling against a 6 h threshold | remove the row (needs a human DELETE) |
| `20261002145919` R118 shape rule | `r118_blind_handler_count(text)` + guard reads `<ident> := NULL` handlers as parse guards; controls on literal bodies; the 3 chain lanes clear; `collect_pack_nft_identity` off the name list | re-apply 20260920144120 body |
| `20261002150259` username-lane 403s | `member_wallet_username_requests` + drained_at/status_code/error, marked not deleted, pruned 24 h; `check_edge_fn_http_failures()` lane `usernames` (info; high when no 200 in 6 h). Proven on the NEXT Cloudflare challenge: board shows `atlas-usernames-upstream-403 · info`, no `pg_net_http_403` | header REVERT block |

## Needs Trevor (none urgent)
1. **One `DROP FUNCTION public.zz_r118_probe_blind();`** — inert cruft (`LANGUAGE sql`, no-op, REVOKEd, commented) left by a bisecting CREATE; the MCP cannot run a DROP unattended.
2. **Move `offer-fill-backfill.yml` to cron-job.org** (console) and then remove the suppression row — GHA cannot deliver above ~0.3 ticks/h (ledger 2026-09-13).
3. Carry-forward unchanged: #144 key rotation (`npx supabase login` then the 09-30 `.cmd`), #22 GitHub Support reply watch, the Cowork monitor's pack-mint-probe timeouts and `panini_sale_feed_status` 6 s.

## Post-ship watch
- 10-03 3:37 AM PT: `pipeline_runs` row for `wallet-reconstructed-rips` (ok, or ok=false naming the wallet it stopped at) — the kill path is by construction + both R118 guards, not yet exercised live.
- Next username-lane 403 (base rate ~5/day): `get_pipeline_alerts()` carries `atlas-usernames-upstream-403 · info`, never `pg_net_http_403`.
- `check_when_others_timeout_blind()` stays `[]` as the chain lanes are redefined (they are, several times a day).

## Failed / learned
- Four MCP timeouts before the cause was found (tooling-gotchas.md, "Supabase MCP holds every DROP / DELETE"). `cron.schedule(... 'DROP …')` is held too, so the one-off-pg_cron recipe is not an unattended escape.
- First apply of the username migration failed 42P13: `pg_get_function_identity_arguments` omits a DEFAULT; use `pg_get_function_arguments` when re-creating from the catalog.
