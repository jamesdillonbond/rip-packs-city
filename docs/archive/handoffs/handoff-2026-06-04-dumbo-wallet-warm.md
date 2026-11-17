# Handoff — Warm "Dumbo" wallet across all 5 collections (VIP)

## Context

- Trevor asked to prewarm the wallet behind Top Shot username "Dumbo" — a Dapper Labs / Flow Blockchain employee about to check out RPC — so it presents well across collections with accurate FMV.
- Dumbo resolves to wallet 0x37a7e864611c7a85 (wallet_usernames, source topshot_gql).
- Current state, verified 2026-06-04 against Supabase bxcqstmqfzmuolpuynti: the wallet is COLD — 0 rows in wallet_moments_cache, no wallet_holdings_snapshot, never seen as buyer/seller in sales. On-chain he holds 596 Top Shot moments (26,904 TSS pts) and ~27 NFL All Day moments. Pinnacle / UFC / Golazos holdings unknown until walked.
- This handoff covers Phase 1 (the WARM) ONLY. It needs INGEST_SECRET_TOKEN, which only your local env has — Cowork can't reach it. There is NO code change here: nothing to commit, no deploy, no tsc. It is authenticated route calls + read-only verification.
- After the warm lands, Cowork (Claude in this session) handles Phase 2 (FMV recovery on Dumbo's holdings) and Phase 3 (presentation verification on /share, /profile, dashboard) live via the Supabase MCP — no token needed for those.

## What to run

This is a single wallet, so the multicollection orchestrator's pool-saturation staggering is irrelevant — but it is still the simplest one-shot. It fans out to all 5 collections: nba_top_shot (fire-and-forget), nfl_all_day + disney_pinnacle (sync-polled), laliga_golazos + ufc_strike (fire-and-forget). It returns 202 immediately and runs the walk in the background for roughly 5–10 minutes.

Use PowerShell Invoke-RestMethod — curl silently fails in Git Bash on Windows for these calls. If $env:INGEST_SECRET_TOKEN is not already in your shell, load it from .env.local (or .env) first.

Primary (one call, all 5 collections):

    $h = @{ Authorization = "Bearer $env:INGEST_SECRET_TOKEN" }
    Invoke-RestMethod -Method Post -Uri "https://www.rippackscity.com/api/wallet-backfill-multicollection" -Headers $h -ContentType "application/json" -Body '{"wallet":"0x37a7e864611c7a85","skip_cached":false}'

Expected: HTTP 202, accepted_count 5, sync_collections [nfl_all_day, disney_pinnacle], fire_and_forget_collections [nba_top_shot, laliga_golazos, ufc_strike].

Per-collection fallbacks — run any collection that shows a gap in the verify step below. Each is independent, idempotent, returns 202. Same body for all: {"wallet":"0x37a7e864611c7a85","skip_cached":false} (append ?force=true to force a full re-walk).

    TS:       POST /api/wallet-backfill
    AllDay:   POST /api/wallet-backfill-allday
    Pinnacle: POST /api/wallet-backfill-pinnacle
    Golazos:  POST /api/wallet-backfill-golazos
    UFC:      POST /api/wallet-backfill-ufc

PowerShell example for a single fallback (Top Shot, forced):

    Invoke-RestMethod -Method Post -Uri "https://www.rippackscity.com/api/wallet-backfill?force=true" -Headers $h -ContentType "application/json" -Body '{"wallet":"0x37a7e864611c7a85","skip_cached":false}'

## Verify the walk landed

Wait ~3–5 min after firing, then run against Supabase bxcqstmqfzmuolpuynti. TS is the big one (expect ~596). AllDay ~27. Pinnacle / UFC / Golazos may legitimately be 0 if he holds none.

    SELECT c.slug AS collection, count(*) AS moments,
           count(*) FILTER (WHERE w.edition_key IS NOT NULL) AS has_edition_key,
           count(*) FILTER (WHERE w.tier IS NOT NULL)        AS has_tier,
           count(*) FILTER (WHERE w.set_name IS NOT NULL)    AS has_set,
           count(*) FILTER (WHERE w.fmv_usd IS NOT NULL)     AS has_fmv,
           max(w.last_seen_at) AS last_seen
    FROM wallet_moments_cache w
    JOIN collections c ON c.id = w.collection_id
    WHERE w.wallet_address = '0x37a7e864611c7a85'
    GROUP BY c.slug ORDER BY moments DESC;

Done = at minimum nba_top_shot ~596 rows with has_edition_key approximately equal to moments (so FMV + the entity pages can resolve). If anything is missing, check the orchestrator telemetry:

    SELECT pipeline, ok, extra->>'wallet_address' AS w,
           extra->'dispatched_per_collection' AS dispatched, finished_at
    FROM pipeline_runs
    WHERE pipeline LIKE 'wallet-backfill-multicollection%'
      AND extra->>'wallet_address' = '0x37a7e864611c7a85'
    ORDER BY finished_at DESC LIMIT 4;

## Guardrails

- No code change: nothing to commit, no branch, no PR, no deploy, no tsc.
- skip_cached:false forces a full re-walk; on a cold wallet it just means "walk everything and enrich." Every route is safe to re-run — writes are idempotent upserts on (wallet_address, collection_id, moment_id).
- Do NOT add him to seeded_wallets / allow_list for this — it is a one-off VIP warm, not an ongoing 6h-refresh subscription.
- PowerShell Invoke-RestMethod, not Git-Bash curl (silent failure on Windows for these calls).
- Your direct inspection wins over this doc on any disagreement — adapt to the actual route/response shape.

## Hand back

Once TS shows ~596 warmed rows (ping Trevor, or just confirm the verify query), Cowork picks up Phase 2 (FMV recovery on Dumbo's NO_DATA-with-recent-sales editions, scoped to his holdings) and Phase 3 (presentation: /share/0x37a7e864611c7a85, /profile, dashboard) and delivers a readiness summary.

## End state

0x37a7e864611c7a85 fully warmed in wallet_moments_cache across every collection he holds (TS ~596 + AllDay ~27 + any Pinnacle / UFC / Golazos), with edition_key / tier / set_name populated — ready for the FMV + presentation polish from Cowork.
