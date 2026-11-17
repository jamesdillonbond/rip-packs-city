---
name: rpc-fmv-audit
description: Cross-check Rip Packs City FMV against LiveToken's serial-adjusted market FMV to verify accuracy and find mispriced editions. Triggers on "audit FMV", "check FMV accuracy", "compare to LiveToken", "verify moment values", "FMV vs LiveToken", or any seeded-wallet FMV accuracy pass. Encodes the proven LiveToken extraction method (setID:playID join, FMV_DESC sort, Vue/interceptor capture), the RPC comparison query, and the do-not-clobber safety rule.
---

# RPC FMV audit vs LiveToken

Use to verify RPC FMV accuracy for a wallet's holdings against LiveToken (an independent, sales-based, serial-adjusted FMV source) and surface mispriced editions. Read-only on RPC unless a fix is explicitly approved.

## Why LiveToken
LiveToken portfolio moments key on `setID` + `playID`, which equal RPC `editions.external_id` (`setID:playID`) exactly — a clean edition-level join, no fuzzy player/serial matching. LiveToken `valueFMV` is **serial-adjusted** (specific to the held serial); RPC FMV is **edition-level**. Expect modest gaps from serial premium on very low/high serials; treat only >30% divergence as real mispricing.

## Prereqs
- Trevor signed into LiveToken in the connected Chrome (portfolios are public by address regardless).
- Supabase project `bxcqstmqfzmuolpuynti`; TS collection_id `95f28a17-224a-4025-96ad-adf8a4c63bfd`.

## Extraction recipe (per wallet)
1. `navigate` to `https://livetoken.co/myaccount?address=<HEX_NO_0x>&mode=portfolio`.
2. Install a fetch+XHR interceptor that stashes any `/api/topshot/portfolio/` JSON response to `window.__cap` (the app uses an in-memory auth token; a bare fetch with the stale localStorage `id_token` returns `authResult:6`, so always capture the app's own call — never call the API directly).
3. Find the Vue portfolio sort component (traverse `el.__vue__.$root` → `$children`; the one whose `$data.sortOrder.label` matches /acquired/ and has method `onChangedSort`) and call `comp.onChangedSort({label:'Sort by FMV (highest)', sort:'FMV_DESC'})`. The app refetches page 1 with valid auth → captured to `window.__cap`.
4. Read `window.__cap.portfolio.moments` (100/page; `paginationResult.pages` for more). Map each to `{k:setID+':'+playID, fmv:valueFMV, s:serialNumber, c:circulationCount, ns:numSales}`. Sort desc by fmv. (For a full audit, page through with the same captured mechanism or `onChangedSort` re-trigger per page.)
5. Output compactly as `key:fmv:serial:circ` comma-joined (browser tool truncates long returns — slice into halves if needed).

**Privacy guard:** the browser JS tool blocks outputs containing cookie/address/long-hex data. Redact with `.replace(/0x[0-9a-f]{6,}/gi,'#').replace(/[0-9a-f]{16,}/gi,'#')` and never print auth tokens.

## Comparison query (RPC side)
Paste the LiveToken pairs into a VALUES list and join to the latest snapshot per edition:
```sql
WITH lt(key, lt_fmv) AS (VALUES ('100:3345',2499.52), ...)
SELECT lt.key, e.player_name, e.set_name, e.circulation_count AS circ,
  f.fmv_usd::numeric(10,2) AS rpc_fmv, f.confidence AS rpc_conf, lt.lt_fmv,
  round((f.fmv_usd - lt.lt_fmv)/NULLIF(lt.lt_fmv,0)*100) AS rpc_minus_lt_pct
FROM lt
LEFT JOIN editions e ON e.external_id=lt.key AND e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
LEFT JOIN LATERAL (SELECT fmv_usd, confidence FROM fmv_snapshots fs
  WHERE fs.edition_id=e.id ORDER BY computed_at DESC LIMIT 1) f ON true
ORDER BY ABS((f.fmv_usd - lt.lt_fmv)/NULLIF(lt.lt_fmv,0)) DESC NULLS LAST;
```

## Interpreting confidence (validated 2026-06-02)
- **STALE**: $ value can be wildly stale (seen +740%). High trust damage despite the honest label.
- **LOW**: unreliable both directions (−89% to +317%). The dominant bucket (~71% of displayable TS editions).
- **NO_DATA** on low-circ (≤150): valuable misses — the edition trades rarely but at high value; recalc's 30d window never priced it.
- **ASK_ONLY**: reasonably calibrated (~±15%) with a slight over-tilt; ask×0.90 runs a bit high on thin-liquidity editions.
- **HIGH/MEDIUM**: trust.

## Safety — DO NOT clobber FMV with LiveToken values
Never bulk-write LiveToken values into `fmv_snapshots`. It clobbers canonical `fmv-recalc` 1.7.0 under latest-wins, goes stale unmaintained, and is a pricing-LOGIC change. Deliver the comparison + recommend recalc-pipeline fixes (STALE display, NO_DATA low-circ lookback, ASK multiplier) as a Claude Code handoff. One-off RPC-native data fixes are fine; third-party-sourced price writes are not. See memory `fmv-pipeline-patch-restraint`.

## Seeded-wallet roster
The 10-wallet set + status lives in `docs/audits/fmv-livetoken-accuracy-2026-06-02.md`. Pull each wallet's RPC top-100 with `wallet_moments_cache` joined to `editions` + latest `fmv_snapshots`, ordered by RPC fmv desc.
