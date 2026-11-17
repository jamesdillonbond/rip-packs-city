# Handoff — Candy (chain two) productization: FMV maturation, Drop 3 pack-EV, first public board

**Date:** 2026-07-24 · **Author:** Cowork · **For:** Claude Code (Trevor's machine) · **Repo HEAD:** verify with `git rev-parse HEAD` before starting.

> **STATUS (2026-07-24): SHIPPED (Items 1–3).** Item 1 FMV validated (standard `fmv-recalc`, no rewrite) + cold-tail policy set (best-offer as a separate column, never FMV). Item 2 `candy_pack_ev_model` view shipped (Typical-Pull-led, Rainbow flagged 2/25 unpriced). Item 3 `candy_secondary_board` view + gated `/insights/candy-mlb` page/route shipped, `noindex`, anon/authenticated-revoked, walled in `proxy.ts`. `candy_mlb` still `is_active=false`. **Item 4 (full collection-tab go-live) remains OUT OF SCOPE / Trevor's call** — the 5-touch flip: delete the `proxy.ts` candy line + add sitemap slug + hub card + OG + drop `noindex` (and, separately, the 28-shared-RPC candy-arm fix before flipping `is_active`).

## Context

Candy's secondary market opened ~2026-07-23 (Magic Eden) and RPC is already indexing it live — `candy-sales-indexer` (→ shared `sales`, `marketplace='magic_eden'`, `source='solana_das'`), `candy-offers-indexer` (→ `candy_offers` / `candy_best_offers`), `candy-editions-ingest` (daily). **The FMV pipeline auto-picked up Candy** the moment sales landed: 46/125 editions now priced. Trevor greenlit making Candy RPC's **first visible chain-two product**. This handoff covers the three workstreams he approved (FMV maturation, Drop 3 pack-EV, first public board).

**Nothing here is shipped by Cowork** — all three are pricing-logic (FMV/pack-EV, off-limits for autonomous ship per `fmv-pipeline-patch-restraint`) and route/`.tsx` (no Cowork git). `candy_mlb` stays `is_active=false`; this is a **standalone gated insights board, NOT the full collection-tab go-live** (Item 4).

**Precedent to mirror throughout — Panini** (same shape: non-Flow chain, gated pre-launch insights board, verified to exist on disk 2026-07-24):
- Page: `app/insights/panini-squeeze/` (server page + client board, noindex, gated).
- API: `app/api/public/insights/panini-squeeze/route.ts`.
- Views: `panini_squeeze_board`, `panini_pack_ev_model`, `panini_deal_board` (all `security_invoker`).
- Gating: `proxy.ts` `isPublicPath` returns false for `/insights/panini*`; not in sitemap/hub; go-live = delete the proxy line + add sitemap slug + hub card + OG + drop `noindex` (the "5-touch flip").

Build Candy the same way, file-for-file.

**Candy code that already exists** (verified on disk): `lib/chains/solana/{das,normalize}.ts`; `app/api/candy-sales-indexer/route.ts`; `app/api/ingest/candy-editions/route.ts`; `app/api/ingest/candy-offers/route.ts`; `app/api/wallet-backfill-candy/route.ts`.

### Verified live data (2026-07-24, Supabase `bxcqstmqfzmuolpuynti`, collection_id `209ade70-32c5-4470-bc7c-4793d660f713`)

| Fact | Value |
|---|---|
| Editions | 125 — 100 COMMON (/250), 25 LEGENDARY Rainbow (/15) |
| On-chain assets | 27,876 (full pre-mint pool; drops release tranches, so this stays flat) |
| Holder wallets | 247 (rising as packs open) |
| Secondary (first ~48h, all Magic Eden) | 54 sales, $734.60 vol, 46 editions traded, median $3.00, range $0.01–$300.59 |
| FMV coverage | 46/125 priced, **all confidence=LOW**; refreshing daily in `fmv_snapshots` |
| Cold-tail (unpriced) | 79 editions — 56 COMMON + 23 LEGENDARY; only 18 have a best-offer; **23 of 25 Rainbows unpriced** |
| Offers | 50 active across 26 editions, 3 distinct bidders, top $29.94 (in `candy_best_offers`) |
| Drops | D1 07-17 (500) · D2 07-22 (500, sold ~90s) · **D3 Wed 07-29 (1,500)** |

Drop pack rule (from Candy): $10, **10 ICONs + a 15% Rainbow-variant chance**.

---

## Item 1 — Candy FMV: validate + set cold-tail policy (foundation) — pricing logic, your call

**Root state.** FMV auto-populated for exactly the 46 traded editions, all LOW confidence, and the values are sane/slightly-conservative vs actual sales (spot-checked: Caminero Rainbow FMV $255.50 vs $300.59 last sale; Ohtani common $84.67 vs $99.61; commons within ~$1–3 of last sale). **No rewrite needed** — the collection-agnostic FMV path is working on Candy.

**What to do:**
1. Confirm which pipeline computes Candy FMV (likely the collection-agnostic `app/api/fmv-recalc` path picking up `sales` rows — verify by inspection; don't assume) and that it keeps up as Drop 3 volume lands.
2. **Cold-tail policy for the 79 zero-sale editions.** Recommended: leave genuinely-signal-less editions `NO_DATA` (honest), and surface an explicit **"best offer $X"** column where `candy_best_offers` has a row (18 editions) — labelled as an offer-derived floor, **never as FMV**. **Binding constraint: `candy_best_offers` is a best-offer signal; never fold it into `fmv_snapshots`.**
3. Let confidence mature; the ≥30-day Candy-history chain-two trigger clocks from ~07-22.

**Revert:** validation + policy only; if a cold-tail estimator view is added, revert = drop it (inverse migration).

---

## Item 2 — Candy pack-EV for Drop 3 (Wed 07-29) — pricing logic, your call, TIME-BOXED

Mirror `panini_pack_ev_model` → new `candy_pack_ev_model` (view/RPC) + a board, supply-weighted, reporting **Actual EV (mean, chase-inclusive)** and **Typical Pull (median)** — RPC's existing Actual-vs-Typical discipline.

**EV inputs (live):** COMMON /250 — 100 editions, median FMV **$2.55**, mean **$6.06** (mean inflated by star/#1 commons: Ohtani $84.67, Merrill #1 $77.32), max $84.67. LEGENDARY Rainbow /15 — 25 editions, **only 2 priced**, avg **$170**.

**CRITICAL HONESTY REQUIREMENT — do not ship the board without it.** On current data a pack nets nominally **~$40–65 of pull value on a $10 cost (~4–6×)**. That number is a **mirage**, for four reasons:
1. Secondary is ultra-thin (54 sales in 48h) — you cannot liquidate 10 ICONs at FMV.
2. FMVs are LOW-confidence off 1–2 sales each.
3. 23 of 25 Rainbows — the actual EV driver — are unpriced.
4. Drop 3 dumps ~15,000 more commons + ~225 Rainbows into that thin market → the floor will fall.

So the board must **lead with Typical Pull**, carry a bold **illiquidity + forward-supply caveat**, and mark the Rainbow leg **"largely unpriced (2/25)."** This is the same class as RPC's pool-completeness guard (only price where the signal is complete). A single "4× EV!" hero number would be dishonest and off-brand.

**Revert:** drop the view/RPC + `git revert` the board commit.

---

## Item 3 — First public Candy board (the visible chain-two surface) — routes/.tsx, you

Mirror Panini file-for-file.

1. **Backing view** `candy_secondary_board` (per-edition: player, tier, circulation, latest FMV + confidence, sale counts 24h/7d/all, last sale, and **best-offer as its own column, not FMV**). `security_invoker`. **Per the 07-19 security lesson:** `REVOKE SELECT … FROM anon, authenticated` until launch and verify with `has_table_privilege('anon', 'candy_secondary_board'::regclass, 'SELECT')` — a route gate is not a data gate. Expose only a clean rollup; never surface raw `candy_offers`.
2. **API** `app/api/public/insights/candy-mlb/route.ts` (mirror `.../panini-squeeze/route.ts`), with `meta.coverage` disclosure baked in (46/125 priced, thin) like Panini's "floor, not a census" banner.
3. **Page** `app/insights/candy-mlb/` (server page + client board, RPC brand tokens). **Gated + noindex pre-launch:** confirm `proxy.ts` `isPublicPath` already returns false for `/insights/candy*` (it should, per the 07-17 un-gate that walls Panini/Candy — verify); keep it out of sitemap/hub. Smoke-verify it redirects like `/dashboard` (anon-walled) while a public board (e.g. `/insights/squeeze`) still renders.
4. **Go-live flip (separate, Trevor's explicit call):** delete the proxy line + add sitemap slug + hub card + OG + drop `noindex` — the same 5-touch flip as Panini.

**Revert:** `git revert` the page/API commit + drop the view(s).

---

## Item 4 — NOT in scope now (later): full collection-tab go-live

Flipping `candy_mlb.is_active=true` surfaces Candy through the shared plane (`editions_unified`, `public_read_*`, the `[collection]` tabs) and **requires the 28-shared-RPC candy-arm fix** — the slug-normalization `CASE` in ~28 analytics RPCs has no `candy_mlb` arm and no `ELSE`, so Candy rows drop to NULL (queued in the ledger). **Do NOT flip `is_active` for the board above** — the standalone insights board reads Candy directly and needs neither the flip nor the 28-RPC fix. Sequence the full go-live only after FMV history + coverage justify it.

---

## Guardrails (repeat every handoff)

- **Direct to `main`. No branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify push: `git rev-list --count origin/main..HEAD` (expect 0).
- **`curl` fails silently in Git Bash** for Vercel REST — use PowerShell `Invoke-WebRequest`. Vercel rebuild = `POST https://api.vercel.com/v13/deployments` (an empty or docs-only commit will NOT force a rebuild — `ignoreCommand` skips it).
- Vercel Pro `maxDuration` hard cap is **800s** — higher sends the deploy to ERROR invisibly.
- **CRLF:** don't string-replace-patch on Windows; use full-file writes or `findIndex` on split lines.
- **Log every main/prod change to `docs/overnight/ledger.md`** (date · what shipped · revert path), newest-at-top, re-read from disk immediately before writing.
- Migrations via `apply_migration`; new public views need explicit `REVOKE … FROM anon, authenticated` + `has_table_privilege` verification (route-gating ≠ data-gating).
- Verify pages by **rendered DOM, not HTTP 200** (streaming shells always return 200).
- No `docs/FREEZE.md` needed — this is additive + gated, no live-prod refactor. Nothing here collides with the last 24–48h of commits (Candy work to date is ingest-only, 07-17/19).

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.** (In particular, confirm the exact `proxy.ts` `isPublicPath` Candy handling and the FMV-recalc collection dispatch before relying on my description.)

## Expected end state

FMV validated + cold-tail policy set (Item 1); `candy_pack_ev_model` + board live, Typical-Pull-led and illiquidity-caveated (Item 2); gated `/insights/candy-mlb` deployed READY and smoke-verified anon-walled (Item 3); `candy_mlb` still `is_active=false`; ready for Trevor's go-live flip. Each main/prod change logged to the ledger with its revert path. `npx tsc --noEmit` clean and the Vercel deploy READY before considering any item done.
