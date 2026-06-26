# Claude Code prompt — remaining RPC items (updated 2026-06-25, end of thread)

> **SUPERSEDED 2026-06-25 — CC executed all 4 items.** Item #2 (dead-media) → 0/0; item #1 driven to the public-infra ceiling (correction: the spork-proxy is a REAL worker, 401-gated, NOT a stub as written below — recoverable floor is mainnet17 / 2022-04-06, pre-2022-04 permanently gone; worker extension shipped deploy-ready); item #3 declined on measurement; item #4 repo-synced. **The only true remainder is 3 creds-gated operator steps (`wrangler deploy` spork-proxy + 2 Vercel secret puts) + 1 off-limits sales-route change — both in `focus.md` + the ledger.** Treat the body below as historical; the "non-functional stub" claim in item #1 was a mismeasurement (probed only unauthenticated paths).

Paste the block below to Claude Code. Everything substantive from the long Cowork thread is shipped and verified; this is the short tail. Full detail: `docs/handoff-2026-06-24-open-cc-items.md`, `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`, `docs/overnight/focus.md`.

---

You're picking up the small tail of a long, mostly-finished RPC effort. Read the "Already done" list first so you don't redo or undo anything, then the 4 remaining items (all LOW/optional/infra — there is no HIGH-priority work left).

Guardrails: work directly on `main` (no branches, no PRs); PowerShell `git`, re-verify push with `git rev-list --count origin/main..HEAD` → 0; `npx tsc --noEmit` clean before deploy; Vercel Pro `maxDuration` cap 800s; confirm deploy READY + smoke. After any DB migration confirm `check_public_security_invariants()` = [] and `check_secdef_anon_execute_violations()` = [].

## Already done — do NOT redo or undo
- **TS-Flowty unmapped backlog — RESOLVED** by the `topshot-flowty-unmapped-drain` cron (`9,29,49 * * * *`): resolves via wmc → `nft_edition_map` → on-chain `getMintedMoment`, promotes real sales into `sales`, net-shrinking (~165/hr drain vs ~67/hr inflow); trust breach self-clears under 100 in ~1–2 days. **The earlier "99.9% unresolvable → skip-at-capture" plan was WRONG** — that measurement tested only the wmc (tracked-holder) path; the moments ARE resolvable holder-independently via `getMintedMoment` (46/46 verified). **Do NOT add skip-at-capture, do NOT retire the backlog, do NOT raise the trust threshold** — focus.md carries the "do not undo" note. (One care: transient rate-limit nulls from the proxy must never be treated as definitive not-found.)
- **UFC studio deep-history** — resolver + drain route + watchlist (90 min) all shipped + verified (16,745 sales first tick, back to UFC's 2022 launch, perfect dedup, 0 unmapped spill).
- **Studio deep-history (AllDay/Golazos/Pinnacle)** — live + draining (~124K sales), watchlisted.
- **Media recovery** — TS/AllDay/Golazos/UFC thumbs+videos; the TS dead-media tail is down from 803/823 to **11/11** (two per-moment recovery passes).
- **Security** (anon-grant default hardening) + **FMV ASK_ONLY parity** (AllDay/Pinnacle) — shipped. AllDay FMV is repricing organically off the new studio sales (now-priced 90→166; the NO_DATA residual all have stale pre-backfill snapshots = pending fmv-recalc sweep, no bug).

## 1. [LOW / infra — needs Trevor's Cloudflare creds] pre-2023 + Flowty-venue deep tail
studio-platform's AllDay marketplace history **floors at ~2023** — RE-VERIFIED 2026-06-25 against heavily-traded star 2021 Genesis QBs (Josh Allen/Burrow/Herbert/Henry all return `totalCount 0`; Brady 1, a 2024 sale), so it is not under-sampling — studio genuinely lacks pre-2023 AllDay. So AllDay/Golazos 2021–2023 launch history + the Flowty-venue TS/AllDay tail are reachable only on-chain. **The deployed `spork-proxy` worker is a NON-FUNCTIONAL STUB** (`spork-proxy.tdillonbond.workers.dev` returns `{"ok":true,"worker":"spork-proxy"}` to every path). To pursue: write + `wrangler deploy` the real worker (full spork node list mainnet1–27 + the generic `/v1/` passthrough), set `SPORK_PROXY_URL`/`SPORK_PROXY_SECRET` in Vercel, then extend the backfills to walk below the spork floor (137,390,146). Lowest value (early thin-liquidity era); defer unless prioritized.

## 2. [LOW] 11 residual dead-media TS editions
After two Cowork per-moment recovery passes (792 of 803 — wmc rep moment, then `moments.nft_id`), **11** TS thumbs + 11 videos remain on the dead `assets.nbatopshot.com/editions/` path. They're 2024/2025 WNBA Rookie Ultimates with **no moment in wmc / moments / sales anywhere** → no nft_id to build a `media/<nft_id>/image|video` URL from. Need on-chain mint discovery (resolve one representative minted nft_id via the proxy `getMintedMoment`/`searchMintedMoments`, or `TopShotIPFSResolver.getCIDs`), then repoint `thumbnail_url`/`video_url` to `https://assets.nbatopshot.com/media/<nft_id>/image?width=400` / `/video` (the proven per-moment form, backup-table pattern). Niche/lowest priority.

## 3. [MED, optional] UFC backfill set_id efficiency
The live `ufc-studio-sales-history-backfill` resolver-walks ~860K rows unfiltered (working). Optionally, on first encounter of each studio `UFCSet.id`, store the set_id→edition mapping (a dedicated column — NOT `set_id_onchain` unless you confirm studio's set id == the Flow on-chain set id) so later runs filter per-set. Marginal (thinnest market); only worth it if the unfiltered walk's cost becomes a concern.

## 4. [bookkeeping] Repo-sync 1 migration
One live-only migration from the final Cowork pass still needs a parity copy under `supabase/migrations/` + ledger entry: `audit_20260625_recover_ts_dead_media_via_moments_nft_id` (4 Heroes-of-the-Game editions repointed to the per-moment media form via `moments.nft_id`; backup table `audit_20260625_ts_wnba_media_recovery`, extended). All earlier thread migrations are already synced.

---
