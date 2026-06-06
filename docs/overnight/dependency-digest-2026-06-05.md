# RPC bi-weekly dependency / platform-cleanliness digest — 2026-06-05

Scheduled task: `rpc-dependency-advisory-digest`. READ-ONLY except strictly-safe index drops. Supabase project `bxcqstmqfzmuolpuynti`. Run mode: **NO-PUSH** (scheduled sandbox has no GitHub creds) — the DB migration is live via the Supabase connector; this digest + the ledger entry are written to the working tree uncommitted.

## Status: GREEN — security 0/0/0/benign · 16 dead-Flowty indexes dropped · 1 actionable HIGH dep cluster (Next.js, hand-off) · DB flat ~5.98 GB

---

## 1. Security posture — clean (0 / 0 / 0 / benign)

| Check | Result | Expected |
|---|---|---|
| RLS-off public base tables (`relkind IN ('r','p')`, `relrowsecurity=false`) | **0** | 0 |
| Anon/authenticated write grants on RLS-off base tables (relkind-filtered) | **0** | 0 |
| Anon-readable non-`security_invoker` views | **0** | 0 |
| Anon-EXECUTE SECDEF functions — destructive? | **0 destructive** (22 total, all benign) | benign-only |

Anon-EXECUTE SECDEF enumeration (22): 19 public-page / insights / concierge / wallet reads (`get_top_deals`, `get_allday_sniper_deals`, `get_insights_hub_stats`, `get_moment_detail`, `get_pinnacle_moment_detail`, `get_pack_for_simulator`, `get_pack_lifecycle`, `get_trophy_slab_data_by_username`, `get_wallet_collection_snapshot`, `get_wallet_pack_summary`, `get_wallet_pack_history`, `get_wallet_squeeze_exposure`, `get_wallet_tc_report`, `get_insider_signals_top_n`, `get_top_deals`, `resolve_moment_id`, the 4 `mcp_*` concierge reads); `optimize_fast_break_lineup` (verified read-only — `SELECT ... INTO` + ranked CTE, returns JSONB, **0 write statements** in body); 2 trigger functions only invokable via their triggers (`editions_block_topshot_uuid_dupe`, `pack_purchases_set_is_primary_drop`); and `submit_allow_list_request` (early-access form, allowed by design).

**None of the forbidden destructive functions are anon-executable** (`query_sql`, `execute_sql`, `save_user_wallet`, `upsert_wallet_moments`, `activate_pro_from_payment`, `classify_acquisition`, `pinnacle_upsert_nft_map` — all confirmed NOT in the anon-EXECUTE set).

---

## 2. Performance / bloat

### Indexes DROPPED this run (16 — strictly-safe, shipped live)

Migration `audit_20260605_drop_unused_flowty_indexes`. Every one: `idx_scan=0` lifetime, non-unique, non-primary, on a dead/frozen `flowty_*` table (Flowty marketplace shut ~2026-05-13; `flowty_loan_events` cold since 2026-05-11). Data rows untouched, PKs/unique constraints intact, ~5.5 MB reclaimed, verified 0 of 16 remain. Full recreate path for all 16 is in `docs/overnight/ledger.md` (IDX-DROP entry).

`flowty_loan_events`: idx_floan_events_type_time (1144 kB), _collection_time (696 kB), _block (312 kB), _listing (304 kB), _funding (280 kB), _lender (176 kB).
`flowty_transactions`: idx_ftx_status_collection_sealed (560 kB), _authorizers (280 kB), _failure_cat (152 kB), _collection_failures (112 kB).
`flowty_loans`: idx_floans_collection_listed (304 kB), _collection_funded (296 kB), _funding_resource (240 kB), _funded_at (216 kB), _storefront (144 kB), _terminal_at (104 kB).

### Unused indexes >1 MB left for a human decision (NOT dropped)

None of these qualify for the strictly-safe rule (none are a non-unique duplicate that is a prefix of a UNIQUE index; the evm and sales ones are explicitly off-limits per the task):

| Index | Table | Size | Why left |
|---|---|---|---|
| evm_nft_transfers_2026_02_chain_id_lower_idx | evm_nft_transfers_2026_02 | 5200 kB | evm `to_address` pre-built — explicitly leave |
| evm_nft_transfers_2026_02_chain_id_lower_idx1 | evm_nft_transfers_2026_02 | 5168 kB | evm `from_address` pre-built — explicitly leave (NOT a duplicate of the above) |
| evm_nft_transfers_2026_03 _idx / _idx1 | evm_nft_transfers_2026_03 | 4576 / 4568 kB | same evm to/from pair — leave |
| evm_nft_transfers_2026_01 _idx / _idx1 | evm_nft_transfers_2026_01 | 1584 / 1576 kB | same evm to/from pair — leave |
| sales_2021_seller_address_idx | sales_2021 | 1352 kB | sales seller_address — explicitly leave |
| idx_pack_purchases_event_kind | pack_purchases | 7008 kB | (event_kind, sealed_at) — not prefix-of-unique; live table; human call |
| idx_pack_purchases_is_primary | pack_purchases | 5376 kB | (is_primary_drop, sealed_at) — not prefix-of-unique; live table; human call |
| fmv_snapshots_2026_collection_idx | fmv_snapshots_2026 | 6864 kB | indexes the denormalized text `collection` (vs the used `collection_id`); looks redundant but not prefix-of-unique; hot partitioned table; human call |
| idx_moments_collection_id | moments | 5048 kB | (collection_id) — not prefix-of-unique; human call |
| pinnacle_ownership_snapshots_owner_idx | pinnacle_ownership_snapshots | 1832 kB | (owner) — not prefix-of-unique; human call |
| idx_cl_v2_block_height | cached_listings_v2 | 1712 kB | (block_height) — not prefix-of-unique; human call |
| idx_fmv_caps_edition | fmv_calibration_caps | 1248 kB | (edition_id, applied_at) — shares only the leading col with the unique (edition_id, reason, applied_date); not a true prefix; human call |

### DB size + top 10 tables

DB total: **5983 MB** (6,273,494,163 bytes). Trend flat: 5912 (06-01) → 5966 (06-02) → 5999 (06-03) → 5920 (06-04) → 5978 (06-05 night) → **5983** now. The big one-time reduction already happened on 2026-05-24 (flowty_archive hard-delete, 13.8 GB → ~5 GB); flowty_archive is no longer in the top 10.

1. wallet_moments_cache — 1077 MB
2. evm_nft_transfers_2026_02 — 281 MB
3. evm_nft_transfers_2026_03 — 248 MB
4. fmv_snapshots_2026 — 219 MB
5. moment_acquisitions — 211 MB
6. sales_2026 — 151 MB
7. moments — 145 MB
8. pack_purchases — 122 MB
9. pack_rips — 93 MB
10. marketplace_offers_2025 — 91 MB

---

## 3. Dependency CVEs (`npm audit --omit=dev`)

Production-dependency advisories: **0 critical · 3 high · 12 moderate · 1 low** (16 total).

### HIGH (3) — flag

1. **next** — installed/locked **16.1.6**; fix **16.2.7** (non-major, `isSemVerMajor:false`). This single bump clears a large advisory cluster: HTTP request smuggling in rewrites, **multiple Middleware / Proxy bypasses in App Router** (directly relevant — RPC's entire site-lockdown auth gate lives in `proxy.ts`/Next middleware), null-origin Server Actions CSRF bypass, cache poisoning (×3), SSRF via WebSocket upgrades, XSS (CSP-nonce / beforeInteractive), and several DoS. Bumping `next` also resolves the moderate **postcss** XSS (pulled transitively). **Top recommendation.**
2. **defu** (`<=6.1.4`) — prototype pollution via `__proto__` (GHSA-737v-mqg7-c878). Deep transitive; `fixAvailable: true`.
3. **fast-uri** (`<=3.1.1`) — path traversal + host confusion via percent-encoded segments (GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc). Deep transitive; `fixAvailable: true`.

### MODERATE (12) — note

- **6 × `@onflow/*`** (fcl, fcl-core, fcl-wc, react-core, react-sdk, sdk) — **no fix available**; monitor upstream. These are core Flow client libs; nothing to do but track.
- **@anthropic-ai/sdk** (0.79.0–0.91.0) — insecure default file perms in the Local Filesystem Memory Tool; fix `0.100.1` (semver **major**). RPC's concierge use likely doesn't touch that tool path — low practical exposure, but a major bump to evaluate.
- **postcss** (`<8.5.10`) — CSS-stringify XSS; resolved by the `next` → 16.2.7 bump.
- **ws** (8.0.0–8.20.0) — uninitialized memory disclosure; `fixAvailable: true`.
- **viem** — `fixAvailable: true`.
- **brace-expansion** (5.0.2–5.0.5) — `max` DoS bypass; `fixAvailable: true`.

### Dependabot

Config confirmed **security-only** (`.github/dependabot.yml`: wildcard `ignore` on all semver patch/minor/major for every package, so only CVE advisories open PRs; `open-pull-requests-limit: 3`; npm daily + github-actions). Live open-PR enumeration was **not possible this run** — no GitHub connector auth and no `gh` CLI in the scheduled sandbox; `npm audit` above is the authoritative CVE source. The most likely live dependabot PR is a `next` security bump (next is named in the config rationale).

---

## Recommended next actions (none auto-shippable from Cowork — all need a git push / human)

1. **Bump `next` 16.1.6 → 16.2.7** (non-major) — clears 3 HIGH `next` CVEs incl. the middleware/proxy-bypass class that bears on `proxy.ts` auth, plus moderate postcss. `package.json` + lockfile change → Claude Code / human. Highest priority.
2. Pick up the transitive HIGH fixes (`defu`, `fast-uri`) and the fixable moderates (`ws`, `viem`, `brace-expansion`) in the same dependency PR (`npm audit fix` where non-breaking; verify lockfile + `tsc`).
3. The 12 unused non-flowty indexes (incl. the apparently-redundant `fmv_snapshots_2026_collection_idx` on the text `collection` column) are a separate human decision — left untouched per the strictly-safe rule.
