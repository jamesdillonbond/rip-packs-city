# Catalog backfill — prioritize never-catalogued sets (fast art for new drops)

Date: 2026-06-05. Tiny, low-risk route change; no DB. Rebase on latest main.

CONTEXT
topshot-catalog-backfill (/api/admin/backfill-topshot-catalog; daily 4am ET cron; Bearer RPC_ADMIN_TOKEN) fills thumbnail_url/video_url on editions by walking sets and reading assetPathPrefix from TS GQL searchEditions. Integer-keyed TS editions get player/set/tier from Cadence but NOT art — only this backfill writes the image/video. Its natural-mode candidate query orders sets by updated_at ASC (least-recently-touched first), so brand-new sets (recent updated_at) are processed LAST in the cycle. Result: a fresh drop's art lags until the sweep wraps around to the newest sets. This change front-loads never-catalogued sets so a new drop's art lands on the very next run.

WHY NOW (verified prod DB 2026-06-05)
The inaugural WNBA drop landed and 4 of its sets are in `sets`, UUID-keyed, but asset_path_prefix IS NULL (never catalogued): WNBA Origins (set_id_onchain 252), Level Up (256), WNBA Rookie Debut (257), WNBA Base Set (258). Their canonical int-keyed editions (Portland Fire, Toronto Tempo, etc.) therefore have player/set/tier but thumbnail_url/video_url NULL, so the team pages' Top Editions + checklist grids (which filter thumbnail_url IS NOT NULL) render empty for those teams. ~35 other WNBA sets already have asset_path_prefix (they were caught by earlier sweeps).

CHANGE — app/api/admin/backfill-topshot-catalog/route.ts, the natural-mode candidate query (the `else` branch around line 365, currently `.eq("collection_id", COLLECTION_ID).order("updated_at", { ascending: true, nullsFirst: true }).limit(1000)`). Add asset_path_prefix as the PRIMARY sort key, nulls first, so uncatalogued sets always come before already-catalogued ones:
    const { data: setsRaw, error: setsErr } = await supabase
      .from("sets")
      .select("id, external_id, name, set_id_onchain, cover_art_url, asset_path_prefix, updated_at")
      .eq("collection_id", COLLECTION_ID)
      .order("asset_path_prefix", { ascending: true, nullsFirst: true })
      .order("updated_at", { ascending: true, nullsFirst: true })
      .limit(1000);
Everything else stays (UUID_RE filter, time budget, walkSet pagination, upsert onConflict external_id+collection_id, pipeline_runs log, startAfter ad-hoc). Once a set is catalogued, asset_path_prefix becomes non-null and it drops back into the normal updated_at ordering — so this only front-loads genuinely-new sets; no churn on the steady state.
Optional (not required): also add an explicit `?forceRefresh=missing_prefix` mode mirroring the existing staleThumbnailMode branch but selecting sets WHERE asset_path_prefix IS NULL — a targeted manual trigger. The ordering change alone fixes the cron path; the mode is just convenience.
Revert: git revert <commit> (restores the single updated_at order).

VERIFY
After deploy, trigger once (Bearer RPC_ADMIN_TOKEN). Within one run:
- SELECT name, (asset_path_prefix IS NOT NULL) AS has_prefix FROM sets WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND set_id_onchain IN (252,256,257,258); → all true.
- editions for team_name IN ('Portland Fire','Toronto Tempo') now show thumbnail_url populated (has_thumb=true) on the int-keyed rows.
- The Fire/Tempo team pages' Top Editions + checklist grids populate; pipeline_runs shows the topshot-catalog-backfill row ok=true with editions_upserted > 0.

GUARDRAILS
- Direct-to-main, no branches/PRs. PowerShell git commit; re-verify git rev-list --count origin/main..HEAD = 0.
- curl fails silently in Git Bash for Vercel/admin REST — use PowerShell Invoke-WebRequest to trigger.
- CRLF: full-file write. After deploy: npx tsc --noEmit clean; Vercel READY.

LET CLAUDE CODE CORRECT FALSE PREMISES
Inspect the real natural-mode query block before editing (line number is from 2026-06-05 HEAD and may drift); the PostgREST chained .order() with nullsFirst is the intended shape, but confirm the installed supabase-js supports the second .order() chaining (it does in v2). The staleThumbnailMode branch is unrelated — leave it.

END STATE
The catalog backfill processes never-catalogued sets first. The inaugural WNBA drop's art lands on the next run (or the next 4am cron), the Fire/Tempo grids populate, and every future drop self-heals same-day instead of waiting for the oldest-first sweep to wrap around.
