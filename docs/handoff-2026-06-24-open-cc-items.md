# Open Claude Code items — consolidated (2026-06-24)

Single list of everything still needing CC after this session's Cowork work. Everything else from the thread is shipped + verified. Health green throughout (security 0/0/0/0, trust 9/9). Each item has the precise action + revert.

## Shipped LIVE by Cowork this session — repo-sync these migration files (parity only, no behavior change)
The `supabase/migrations/` dir is live-only since 2026-05-17; add faithful parity copies + ledger entries:
- `audit_20260624_allday_sales_history_backfill_targets` — monitoring queue (view), AllDay backfill (2,295 zero-sale editions at ship).
- `audit_20260624_pinnacle_sales_history_backfill_targets` — monitoring queue (view), Pinnacle backfill (264 zero-sale renders).
- `audit_20260624_recover_allday_video_url_media_cdn_v2_bare` — **the live AllDay video recovery** (6,176 editions → `media.nflallday.com/editions/<id>/media/video`). Revert: `UPDATE editions SET video_url=old from audit_20260624_allday_video_backfill_v2 ...` (backup table retained).
- Also record (already self-contained, net no-op): `audit_20260624_recover_allday_video_url_to_media_cdn` (v1, wrong form) + `audit_20260624_revert_allday_video_recovery_stale_form` (its revert).
- All four `audit_20260623_*` migrations (thumbnails, videos, pinnacle ASK_ONLY, anon-DML) were already repo-synced earlier — skip if done.

## 1. Fix `lib/media/momentVideoUrl.ts` AllDay video form (1-line — HIGH, trivial)
The helper's AllDay form is **stale**: `https://media.nflallday.com/editions/${editionId}/media/video?width=512&format=mp4` → live returns *"ERROR 9401: 'mp4' is not a supported output format"* (that `?format=` endpoint is an image resizer). The **correct live form** (read from `app.nflallday.com`'s own `<video>` elements + confirmed via direct nav returning `Content-Type: video/mp4`) is the **bare path, no query params**:
```
https://media.nflallday.com/editions/${editionId}/media/video
```
Change line ~51 to drop the `?width=512&format=mp4`. This fixes the **Trophy modal's** AllDay video (the only consumer of the helper; the main grids/edition pages already read `editions.video_url`, which Cowork already repointed to the bare form). Verify: the trophy modal plays AllDay video; `npx tsc --noEmit` clean.

## 2. Historical sales-capture program — verification + deep tails
- **First-tick verification is autonomous:** the scheduled task `verify-allday-backfill-first-tick` (07:05 UTC) checks decode quality on all 5 backfill routes' first ticks + auto-reverts clearly-broken with the ledger predicates. Read its output before assuming the backfills are clean. **FYI — all 5 fired their first ticks OK already** (06:08-06:48 UTC): topshot-flowty wrote 470 / Pinnacle 64 / AllDay 69 historical sales, golazos 0 / ufc 0 (current-spork window thin for those). Capturing history as designed.
- **`v_rpc_trust_health.unmapped_resolution_backlog_max` will breach while backfills run (EXPECTED).** Its threshold (breach_at 100) was set for the forward indexer's tiny backlog; the history backfills write historical sales that can't always edition-resolve (the holder moved / no cache), so they land in `unmapped_sales` pending the chained resolver — first tick already pushed it to ~384 (TS-Flowty skipped 384 of 858). The chained `*-resolve-unmapped` drains the resolvable portion; a residual is inherent to backfilling old sales. **Once the resolvers reach steady state (watch over ~a day), raise this leg's threshold** (in `v_rpc_trust_health`) to the new normal so it stops false-alarming + can still catch a real resolver stall — don't raise blindly now; let the steady-state level reveal itself first. Confirm the TS-Flowty route actually fires a TS unmapped-resolver (AllDay/others chain theirs); if not, its 384 won't drain.
- **AllDay drain cadence:** at 30k blocks/tick × 3h that's ~47 days for the 11.3M-block window. If you want history sooner, bump the `vercel.json` cron (e.g. `7,37 * * * *`, off-rush) — that's the throughput lever. The 07:05 verification reports the real blocks/tick + an ETA.
- **Deep pre-2025-12-29 tails** (AllDay 2021→, Pinnacle 2024→, TS-Flowty 2022→): all 5 routes stop cleanly at the spork floor (137,390,146). The deep tail needs the `spork-proxy` worker to gain a historical **event-range** scan route (it currently only exposes `?tx=` + health, and lists only sporks mainnet24-27), plus `SPORK_PROXY_URL`/`SPORK_PROXY_SECRET` Vercel env vars and mainnet1-18 wired. Infra workstream — values + reachability findings are in `handoff-2026-06-24-historical-sales-capture-program.md`.

## 3. Golazos / UFC hover-play video (LOW — enhancement, not a bug)
`editions.video_url` is **NULL for all 581 Golazos + 518 UFC** editions → those grids show thumbnail only (graceful, not broken). To add hover-play, populate `video_url` after verifying each collection's live video CDN form (the `momentVideoUrl.ts` Golazos `assets.laligagolazos.com/...mp4` + UFC `.png→.mp4` forms may be stale like AllDay's was — read a live `laligagolazos.com` / `ufcstrike.com` `<video>` src first, the same way the AllDay form was found). Tiny collections; low priority.

## 4. Optional security hardening — durable anon-grant default (LOW, reviewed)
The 2026-06-23 anon-DML revoke (482→46) is "leaky": **new objects re-acquire Supabase's default anon grants** (I had to `REVOKE anon` explicitly on each new view this session). A durable fix is `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT,UPDATE,DELETE ON TABLES FROM anon` — but it's per-creating-role in Supabase and a posture change, so review which role(s) create objects before applying. Until then, every new public table/view must `REVOKE anon` explicitly. No live hole (RLS gates; `check_public_security_invariants()` = []).

## Guardrails
Direct to `main`, no branches/PRs. PowerShell `git`; re-verify push `git rev-list --count origin/main..HEAD` → 0. Vercel Pro `maxDuration` cap 800s. `npx tsc --noEmit` before deploy; confirm READY + smoke.

## End state
The substantive program is shipped: 5 backfill routes live + auto-verifying, AllDay thumbnails+videos recovered (8,255 thumbs / 8,235 TS videos / 6,176 AllDay videos), Pinnacle + AllDay FMV ASK_ONLY parity, scarcity board, security hardening, two monitoring queues. CC's remaining work is the 1-line helper fix (#1), repo-sync, and the infra-gated deep tails (#2). Everything is near-mechanical with the params/forms captured above.
