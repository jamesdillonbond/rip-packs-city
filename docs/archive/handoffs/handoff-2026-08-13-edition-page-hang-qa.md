# Handoff — entity-detail pages (edition, player, …) hang on "SCANNING THE MARKETPLACE…" (2026-08-13, weekly surface QA)

**Severity: HIGH — the bulk of the indexable SEO surface is unusable.** Both `/[collection]/edition/[slug]` AND `/[collection]/player/[slug]` pages hang indefinitely on the route `loading.tsx` fallback ("SCANNING THE MARKETPLACE…"). The whole page body — hero FMV, Special Serials board, Recent Sales, parallels, packs — never renders. Because these are the five `fetchEntityDetailRaw` SEO routes (edition / set / player / team / series) that **share the same `loading.tsx` and gate**, set/team/series are almost certainly affected too — that is ~20,480 edition + ~thousands of player/team/set/series URLs, i.e. the majority of the 33,195-URL sitemap. Moment pages (`/moment/[id]`), pin pages (`/pinnacle/moment/…`), pack pages, insights boards, and the dashboard all render fine — those are NOT in the `fetchEntityDetailRaw` family.

This is invisible to the DB-side monitor and the night pass: it is an HTTP 200 streaming shell whose RSC stream never completes, with **no console error and no client-visible 5xx**. Only live DOM reading catches it (which is why weekly QA exists).

## Reproduction (live, 2026-08-13 ~09:20–09:36 PDT)

Loaded via Claude-in-Chrome against `www.rippackscity.com` (browser logged in; irrelevant — the page is public):

| URL | Result |
|---|---|
| `/nba-top-shot/edition/124:4493` (Cam Reddish) | **HUNG** — `main` innerText stayed literally `"SCANNING THE MARKETPLACE…"` (25 chars) for **2+ minutes** across two tabs |
| `/nba-top-shot/edition/233:7730` (Cooper Flagg, $512) | **HUNG** — identical |
| `/nfl-all-day/edition/2577` (Chris McAlister) | **HUNG** — identical (so it is NOT Top-Shot-specific) |
| `/nba-top-shot/player/cooper-flagg` | **HUNG** — identical (so it is NOT edition-specific — the whole entity-detail family) |
| `/moment/36688255` (Kahleah Copper) | ✅ renders fully (FMV, serial, sections) |
| `/pinnacle/moment/OEV1-BATB-MAUR-S2B` (Maurice) | ✅ renders fully |
| `/nba-top-shot/pack/dist/7800`, `/insights/pack-sniper`, `/dashboard`, `/` | ✅ all render fully |

- Server metadata renders (the browser tab title shows the correct player + `Value $X` from `generateMetadata`), so `get_edition_detail` succeeds — it is the **page body render/stream** that never completes.
- The browser makes **no edition-data XHR** (only session calls: `/api/profile/me`, `/api/pro-status`, `/api/wallet/profile`, telemetry). The edition data is fetched **server-side** in the RSC, so the stall is in the Vercel serverless render of `EditionPage`, not a client fetch.
- **No console errors** on any hung page (checked with the hydration patterns `418|423|hydrat|Minified|Exception` — clean).

## What is NOT the cause (measured, ruled out)

The whole shell (covered by `loading.tsx`) blocks on the top-level `Promise.all` in `app/(collections)/[collection]/edition/[slug]/page.tsx` (~line 462 + 473):

```
const detail = await fetchDetail(coll.id, slug)                 // get_edition_detail
const [history, bundle, insightLinks, badgeArt, repSales] = await Promise.all([
  fetchHistory(...),        // get_edition_fmv_history
  fetchMarketBundle(...),   // get_edition_market_bundle
  fetchInsightLinks(...),   // get_edition_insight_links   (TS only — AllDay skips it)
  fetchBadgeArt(...),       // get_badge_display_metadata  (short-circuits on empty badges)
  fetchSales(...),          // get_edition_recent_sales
])
```

Every one of those RPCs is **fast** and the DB is **healthy** (measured live at the time of the hang, via direct SQL):

- `get_edition_detail('…','124:4493')` → returns a row, effectively instant.
- `get_edition_market_bundle` → **360 ms** (EXPLAIN ANALYZE).
- `get_edition_recent_sales` → **77 ms**.
- `get_edition_fmv_history` → **19 ms**.
- `pg_stat_activity`: **5** active backends, **0** DataFileRead waiters, **0** idle-in-transaction. Not saturated. (The only >10s queries were background `refresh_wmc_fmv_changed` / trust-health jobs — unrelated.)
- `fetchBadgeArt` short-circuits when `titles` is empty and is `try/catch`-guarded; `fetchInsightLinks` is skipped for AllDay yet AllDay still hangs.

So the hang is **not** in the DB layer and **not** in any single awaited RPC's own runtime. It is in the app/Vercel render+stream path.

## Most likely causes (for the fixer to confirm with Vercel logs)

1. **Vercel↔Supabase pooler connection acquisition from the app path, amplified by `rpcWithRetry`.** `fetchEntityDetailRaw` (`lib/entity-detail-gate.ts`) and the section fetchers (`lib/entity-section-rpc.ts`) wrap calls in retry-on-connection-class logic. If the app's pooled connection to Supabase is failing/slow to acquire *from Vercel* (invisible to a direct MCP DB connection), five concurrent RPCs each retrying with backoff can blow past the function's `maxDuration`; Vercel kills the function mid-stream and the client is stranded on the fallback forever. This fits: DB fine, RPCs fast when called directly, but the app render never completes.
2. **The edition page holds the most concurrent pooled connections of any entity page** (5-wide `Promise.all` at the top level, before the `<Suspense>` boundary). Moment/pin pages fan out less and render fine — consistent with pool-contention/acquire-timeout being specific to this route.
3. Less likely: an RSC serialization/streaming failure specific to this page's payload (but there is no console error, which usually accompanies a client-side RSC parse failure).

## Recommended next steps

1. **Pull Vercel runtime logs for the edition route** (the MCP `get_runtime_logs` timed out during QA; scope tight): `deploymentId` = current prod (assets served `dpl_7tjGXdq4ekdbKAsMeapgXqHyZnSn`), `query` `/edition/`, look for function **duration near maxDuration / timeouts**, and for the greppable `[entity-section]` retry warnings and `[edition] …` error lines the code already logs. That disambiguates "timing out mid-stream" vs "erroring."
2. If it is the pooler-acquire/retry loop: **cap total retry time** in `rpcWithRetry` / `entity-section-rpc` so a stuck acquire fails fast into the page's own error/empty handling instead of looping past `maxDuration`, and/or **move the non-critical members of the top-level `Promise.all` below the `<Suspense>` boundary** so the hero paints from `get_edition_detail` alone (the file comment at ~line 467 already states this is the intent — verify `fetchMarketBundle`/`fetchHistory`/`fetchSales` really need to block the shell).
3. Confirm whether this is transient (retry the same URLs off the cron-rush minutes and after any pooler pressure clears) or persistent. At QA time it was **100% reproducible for ~15 minutes** across 3 editions / 2 collections / 2 tabs, so treat as persistent until a green re-check.

## Revert / risk

No code was changed by QA — this is a diagnosis only. Any fix should be behind the existing per-request `cache()` + retry structure; the safe minimal change (option 2, moving members below `<Suspense>`) is reversible with `git revert <sha>` and has no DB component.

## Verification checklist for the fix

- [ ] `/nba-top-shot/edition/124:4493`, `/nba-top-shot/edition/233:7730`, and `/nfl-all-day/edition/2577` render the hero FMV + Special Serials + Recent Sales within a few seconds (rendered DOM, not HTTP 200).
- [ ] Vercel logs for `/edition/` show no function-duration-cap hits.
- [ ] Moment/pin/pack pages still render (no regression from the change).
