# Daytime monitor candidate — 2026-10-15 ~08:05 AM PT (first tick of day)

Read-only sense pass. Health GREEN otherwise: security clean (invariants/anon-write/rls-off/secdef all []), trust 37/37 arms ok (0 breaches), stalled_pipelines [], check_pgcron_recent_failures() [], cross-collection pg_cron refresh fresh (step1 10:02Z + step2 10:35Z both succeeded, cohort 193 rows, overlaps fresh), sentinel ts_uuid 48h = 0, latest prod deploy READY (edd4ade5). One novel low-priority runtime signal worth a glance; everything else is known/tracked.

## [LOW — single, non-recurring] sniper-feed badge_editions page-8 fetch throws "Project not specified"

- **Source:** Vercel runtime-errors (project prj_YBJ6Utl32GfyBOIzbsp3kbshJh96), route `/api/sniper-feed`. Group text: `[sniper-feed] badge_editions fetch error @page 8: Project not specified.` — count=1, users=1, first=last=2026-10-15T07:04:19Z. Serving deploy dpl_3hiEUYmWvmM9hSpwRZFTgAdscQRH.
- **Risk read:** LOW / weak signal. One occurrence, no recurrence in the ~8 h since (one tick, one user). "Project not specified" is code-shaped — a Supabase/fetch call reaching the badge_editions pagination branch without a resolved project ref — distinct from the upstream-502 class of the other three runtime groups this window (two transient supabase.co Cloudflare 502s on market-cap tiles + the known panini-collector-walk statement timeout). Not previously in ledger or inbox. Could equally be a one-off cold-start/transient; the signal is too thin to call a defect.
- **Suggested action (night pass):** Confirm recurrence FIRST. If it stays count<=1 / non-recurring, it is a transient — close it. If it recurs, trace the `badge_editions` fetch on the sniper-feed page-8 (pagination) path and check whether that branch builds its Supabase client/URL without the project ref that pages 1-7 carry. Read-only repro via /api/sniper-feed paging to page 8. Do NOT treat as a confirmed bug on one occurrence.

## Known / tracked — deliberately NOT re-logged this run
- candy-opensea listings+sales indexers 100% fail = #58 OPENSEA_API_KEY (lanes unscheduled 10-13; failure_rate pools 3 cal-days so pre-unschedule rows still show, age out ~10-16). Routed, awaiting Trevor env var.
- golazos_sales_v1_backfill cursor_stalled 14 d = 10-14 ledger PENDING (needs one bounded "Completed backfill" suppression apply; cursor at floor block 137,390,146).
- topshot-misattrib-drain suppression_count_predicate_drift 705 > 500 = 10-14 ledger NOTE (Atlas resolver at floor, 695 answered totalCount:0 / never traded; won't drain under 500 — threshold needs raising, Trevor/night-pass call).
- zz_probe_20261014() function_search_path_mutable = filed 2026-10-15T0604Z; deep-audit (run 6) drop attempt DENIED by auto-approver same day.
- topshot-pack-supply-atlas / atlas-market-feed per-tick "N request(s) failed" + atlas upstream-403 info rows = by-design Cloudflare 403 re-walk (last 200s fresh, nothing lost — tick re-asks the failed page).
- panini-collector-walk per-walk 10-min cap (32% fail) = by design (walkOrder rotates start collection).
