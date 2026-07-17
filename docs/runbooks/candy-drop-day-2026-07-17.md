# Candy Drop-Day Runbook — July 17, 2026 (10:00 AM PT / 1 PM ET)

Everything RPC-side is pre-verified (2026-07-16): helius-proxy live end-to-end, all secrets placed (worker `HELIUS_RPC_URL` + `HELIUS_PROXY_SECRET`, Vercel `HELIUS_PROXY_SECRET` baked), inert ingest deployed, `candy_mlb` seeded (`209ade70-32c5-4470-bc7c-4793d660f713`, `is_active=false`). This runbook is the ordered path from "drop is live" to "Candy data flowing." Refs: [handoff-2026-06-08-candy-ingest-prebuild.md](../archive/handoffs/handoff-2026-06-08-candy-ingest-prebuild.md) · [candy-recon-2026-07-16.md](../research/candy-recon-2026-07-16.md).

## 1 · Buy (Trevor, ~10:00 AM PT sharp)

- candy.io → Drop 1 (500 packs only; near-open purchase recommended). $10 + fees; Candy Credits usable. 1 pack = 10 ICONs = plenty of discovery material.
- Wallet receiving the mints: `63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY` (Candy-generated, shown in the account).
- Tell Cowork "drop is live" (a one-shot `candy-drop-day-check` also fires at 10:25 AM PT).

## 2 · Item 0 discovery (Trevor's machine, ~2 min)

```powershell
cd C:\Users\TDill\rip-packs-city
$env:HELIUS_PROXY_URL    = "https://helius-proxy.tdillonbond.workers.dev/"
$env:HELIUS_PROXY_SECRET = "<from password manager>"
node scripts/candy-discovery.mjs 63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY
```

Prints TOTAL assets, the collection address (TODO_1), all trait keys with samples (TODO_3/4), name patterns + placeholder edition grouping (TODO_5), burnt count, and archives raw JSON. Paste the output (no secrets in it) into Cowork.

## 3 · Fill TODOs + verify (Cowork/CC, same day)

1. Fill `CANDY_MLB_COLLECTION_ADDRESS`, `SERIAL_ATTR_KEY`, `EDITION_SIZE_ATTR_KEY`, and the real `editionKeyFromAsset()` in [lib/chains/solana/normalize.ts](../../lib/chains/solana/normalize.ts). **Confirm the edition key differentiates Rainbow colors** (each color is its own /15–/25 edition) and stays constant across serials of one card. Leave `CANDY_MLB_ME_SYMBOL` as TODO until Magic Eden secondary opens.
2. `npx tsc --noEmit` + `npm test` (solana suites).
3. Commit direct to main; verify deploy READY.

## 4 · First manual runs (bearer = INGEST_SECRET_TOKEN)

```powershell
# editions + serials (whole collection walk)
Invoke-WebRequest -Method POST -Uri "https://www.rippackscity.com/api/ingest/candy-editions" -Headers @{Authorization="Bearer $env:INGEST_SECRET_TOKEN"}
# wallet backfill (Trevor's wallet)
Invoke-WebRequest -Method POST -Uri "https://www.rippackscity.com/api/wallet-backfill-candy" -Headers @{Authorization="Bearer $env:INGEST_SECRET_TOKEN"} -ContentType "application/json" -Body '{"wallet":"63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY"}'
```

Verify in Supabase: `pipeline_runs` rows ok=true (`candy-editions-ingest`, `candy-wallet-backfill`); `editions`/`wmc` counts for collection `209ade70…` match the discovery script's edition count; `burnt_skipped` sane; spot-check `wmc.edition_key = editions.external_id` (the invariant).

## 5 · Only after counts verify

- cron-job.org triggers (operator console; own stagger slots, off the :00 rush, www host) + `pipeline_cadence_watchlist` rows — NOT before a clean manual run (unrun watchlisted pipeline = false stall page).
- FMV: point nothing new — the existing `fmv-recalc` engine picks up `candy_mlb` via collection_id once editions+sales exist. Expect LOW/sparse on a fresh book (honest, not a bug; never auto-ASK_ONLY zero-sale editions).
- Sales indexer (`candy-sales-indexer`) stays dormant until ME secondary opens → fill TODO_2 then.

## 6 · Explicitly NOT day one

- `is_active=true` / registry `published:true` / public pages / sitemap / OG — the PUBLIC go-live is readiness-gated on data quality (500-pack pilot = thin book) and is Trevor's call. Run the rpc-insights-qa checklist when flipping.
- No tweets/Reddit/promo (standing no-promo rule). Tagline unchanged until chain two ships visible product.
- No pack-EV/serial-FMV modeling on day-one data.

## Contingencies

- Drop slips again → recurring watch continues; nothing to unwind.
- Sold out before purchase → discovery alternative: find ANY buyer's wallet from the collection's first mint txs on Solscan (the collection address becomes visible on-chain once anyone mints) and run `getAssetsByGroup` instead — the script's group walk works from the collection address without owning assets.
- Discovery output ambiguous (edition key unclear) → buy nothing more; paste 2–3 same-player assets into Cowork and decide the key from what's constant.
- After discovery completes: revert `candy-solana-launch-watch` to daily 9:03 AM PT.
