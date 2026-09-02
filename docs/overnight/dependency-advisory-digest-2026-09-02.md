# RPC Platform-Cleanliness Digest — 2026-09-02

Bi-weekly `rpc-dependency-advisory-digest`. READ-ONLY run. **Nothing shipped** (no ship-eligible index drop; deps flag-only).

## Status: GREEN on security · CLEAN index posture · deps carry 10 high CVEs (0 critical), all fixable

## 1. Security posture — all clean

| Check | Result | Expected |
|---|---|---|
| RLS-off public base tables (`relkind r/p`) | **0** | 0 |
| anon/authenticated write grants on RLS-off base tables | **0** | 0 |
| anon-readable non-`security_invoker` views | **0** | 0 |
| anon-EXECUTE SECDEF functions | **3, all benign** | benign only |

Note: the naive view check first read **53** — a false positive. `security_invoker` stores `on`/`off`, not `true`; matching `<> 'true'` flags every invoker-on view. All 53 are `security_invoker=on`. Corrected check → 0.

Anon-EXECUTE SECDEF functions (all benign public-page/FMV reads):
- `get_trophy_slab_data_by_username(text)` — public trophy-slab page read
- `serial_fmv_estimate(...)` ×2 overloads — pure FMV calc

None of the destructive functions (`query_sql`, `execute_sql`, `save_user_wallet`, `upsert_wallet_moments`, `activate_pro_from_payment`, `classify_acquisition`, `pinnacle_upsert_nft_map`) are anon-executable. ✅

## 2. Performance / bloat

**DB size: 14 GB.** Top 10 tables by total size:

| Table | Size |
|---|---|
| wallet_moments_cache | 2931 MB |
| pack_rips | 1981 MB |
| sales_2026 | 1250 MB |
| sales_2023 | 829 MB |
| fmv_snapshots_2026 | 811 MB |
| sales_2024 | 636 MB |
| moment_acquisitions | 604 MB |
| sales_2025 | 566 MB |
| allday_pack_pull | 451 MB |
| sales_2022 | 443 MB |

(`flowty_archive` ~2.6 GB is a deliberate keep, not in-schema top-10 here.)

### Indexes dropped: **0**

No index met the strict ship rule (non-unique duplicate-of-unique-prefix with 0 scans, OR index on dead `flowty_*` with 0 scans). The duplicate-of-unique-prefix probe returned empty, and none of the 0-scan >1 MB indexes are on `flowty_*` tables.

### Candidates left for human decision — 24 unused indexes (idx_scan=0, >1 MB, non-unique/non-primary)

Total ~146 MB. Notable — the strongest human-review candidates are on **one-off audit/sim snapshot tables** that appear to be finished work:
- `fmv_dust_sim_saleset_20260802_edition_id_idx` (1480 kB) — dust-sim snapshot from the 08-02 dust-filter removal
- `audit_20260716_rip_pull_value_revalue_rip_id_idx` (1120 kB) — dated audit table

Larger indexes (leave unless a plan proves them dead — several are speculative pre-builts or serve rarely-hit paths):
- `idx_allday_pack_sales_hist_pack` (31 MB), `moments`: `idx_moments_owner` (10 MB) / `idx_moments_collection_id` (7.4 MB)
- `sales_*`: `idx_sales_{2020..2025}_nullseller_soldat` (~35 MB combined — NULL-seller counterparty recovery path), `sales_2026_payer_address_idx` (5.3 MB, speculative — do not drop)
- `price_snapshots_2026_*` (2 idx, 10 MB), `pinnacle_trade_events_{from,to}_wallet_idx` (14 MB, speculative), `pinnacle_listing_events_*` (4 idx, 13 MB)
- `offers` (5 idx, ~13.6 MB), `fmv_calibration_caps` (2 idx, 4.7 MB), `idx_sales_ingest_recovered_insert` (1.5 MB)

Recommend a targeted human review of the two dated audit/sim indexes above; the rest are query-serving or speculative pre-builts and should stay per standing policy.

## 3. Dependencies (prod, `npm audit --omit=dev`)

**28 total: 0 critical · 10 high · 15 moderate · 3 low.** All have a fix available. Dependabot config is security-only; open-PR list could not be enumerated this run (GitHub MCP failed to connect — "does not support dynamic client registration").

### High CVEs (flagged — ship nothing, decision is Trevor's)

| Package | Range | Fix | Note |
|---|---|---|---|
| **next** | 16.2.9 installed | **next@16.3.4 (minor, non-major)** | Highest priority — App Router middleware/proxy bypass (Turbopack + single locale), Server Action SSRF/DoS, cache confusion, image-optim SVG DoS. RPC runs `proxy.ts` as its auth wall, so the middleware-bypass class is directly relevant. The 16.3.4 bump also clears the transitive **postcss** high. |
| @vercel/og | 0.10.0–0.11.1 | @vercel/og@1.0.2 (**major**) | Pulls **sharp** (libvips CVEs). Major bump — verify OG rendering after. |
| sharp | <0.35.0 | via @vercel/og@1.0.2 | transitive of above |
| ws | 7.x/8.0–8.20.1 | non-major | mem-disclosure / DoS (transitive via viem) |
| brace-expansion, browserslist, defu, fast-uri, nanoid | various | all non-major | build/tooling-chain DoS / prototype-pollution; low real exposure |

No critical CVEs. Recommended action for Trevor: take the **`next` 16.2.9 → 16.3.4** minor bump (clears next + postcss highs at once), then decide separately on the `@vercel/og` major.

## DB size trend
14 GB this run. (Prior-run figure not re-derived in-session — compare against the last digest's number.)

---
*Read-only digest. No `main`/prod state changed; no ledger entry (no drop shipped).*
