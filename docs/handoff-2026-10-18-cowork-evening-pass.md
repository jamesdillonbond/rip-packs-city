# Handoff — 2026-10-18 Cowork evening pass (~4:53 → ~10:30 PM PT)

Trevor: "clean things up, work through the roadmaps and the known issues list … work autonomously for the next 4 hours". The same prompt went to a Claude Code cloud session at ~5:00 PM PT (session_01LS7PmY7M2BJn8KwzCDgH55); read its session entry beside this one. Every item below is in `docs/overnight/ledger.md` with its revert.

## Shipped

| what | commit / migration | verified |
|---|---|---|
| #195 follow-up: `-heartbeat` markers (grail MV + nine `thp-leg-*`) log NULL `rows_*` | `20261019000941` (+ file in `b972981`) | real cron ticks 5:23 / 6:48 / 6:52 PM PT; 0 non-NULL markers across 43 pipelines |
| #196 third row: wallet-analytics loan rows get a disclosure button | `b972981` | tests + planted defect; the page is auth-walled, so no anon axe run can see it |
| Dead imports out of 26 test files; ESLint ratchet 663 → 632 | `ac0ef63` | CI green |
| Concierge: FMV coverage from the registry (Candy + Panini were unmeasured); empty top-sales window names the last indexed sale; request time in the per-request prompt block | `512eb30`, fixed in `834867b` | live signed-in QA in Trevor's Chrome found all three |
| Signed-out visitor with a pasted wallet: no more guaranteed-401 warm-ups (WarmupContext, WalletHydrator) | `ffeb260` | tests; the Collection-tab half shipped from the other session (`fdbe455`) |
| Pack Net P&L: packs with no buy row count against spend coverage; Collection-tab Packs view gated | `57e945a` | Trevor's wallet published +$45,491 with up to $18,061 of drop spend missing |
| The 7 empty UFC `sets` rows deleted (Trevor approved at 8:16 PM) | one-off pg_cron job, 8:19 PM PT | `DELETE 7`; 0 of the 7 ids remain; job unscheduled; backup rows kept |
| Concierge deal tools carry `market_activity` (0 indexed sales in 7 days) so a frozen market is never called fast-moving | see ledger | tests + planted defect |
| **FMV confidence made internal (Trevor 8:35 PM: nothing user-facing shows our confidence in pricing)** — concierge, methodology/API docs/blog, shared components, collection pages, insights boards + OG cards, sniper toggle, Underpriced Serials, Pack Sniper; plus a ban-at-zero guard | `b30073c`, `d5751eb`, `a34d7d5`, `84729ce`, `098da79` | preflight 7/7 each code slice; CI green through `84729ce`; live DOM of 9 pages read clean |
| Orphaned confidence helpers removed; ESLint ratchet 632 → 629 | see ledger ("remove orphaned confidence-display helpers") | 158 tests, tsc, CI green |
| **Parked SQL applied** (Trevor 9:53 PM: "look for the sql updates"): All Day venue row → V2; #189 snapshot +247; re-walk dispatched | pg_cron one-offs 752–754 at 10:06 PM; GitHub run 39203673094 at 10:16 PM | `INSERT 0 247`, `UPDATE 1` ×2, view reads V2; re-walk `inserted` 1–2 per call by 10:24 PM |
| Scheduled tasks (Cowork-only, laptop linked): nightly pass git route + session-entry target fixed; strategy review 100-WAU gate + roadmap; Panini routine verified current | `docs/scheduled-tasks/*.prompt.md` | nightly read back byte-identical (24,018 chars); both re-signed by Claude Desktop |
| Roadmap §2 (M3 anonymous half), §5 Golazos/UFC rows; pack-ev feature line | docs | — |

## ⚠ `main` was red 6:19 → 7:47 PM PT, my fault

`512eb30` put the concierge time line between the `cacheable` and `dynamic` literals; `concierge-2026-09-02-ship-guards` slices that span textually. Eight red CI runs (six of them the other session's commits on top). Fixed `834867b` (7:41 PM); a second red of mine (a moved comment naming Flow's `/v1/events` tripped the event-reader guard) fixed `ccf187f` (7:47 PM). If a later CI run is still red, read its job log before assuming it is this.

## Measured, no change

- Production sweeps from the cloud sandbox: 390 px (317 pages) and 320 px (230 pages incl. every collection's app tabs). 0 non-200, 0 overflow, 0 broken images, 0 stuck loaders; every `$0` / "Unknown" read in place and legitimate. One transient "Panini premiums" partial (190 ms warm on re-read).
- Dashboard (signed in): Moments and FMV totals reconcile with the per-collection tiles.
- Supabase security advisors: only known/intentional items.

## Left for Trevor / later

- #114 (Cowork-desktop artifact store) — not reachable from a cloud session.
- Trophy-case LOW prices: settled by the confidence rule — Trevor chose "show it plain" (no label, price kept).
- Confidence calls I made under the rule (reverse any if wrong): sniper toggle → "Sale-priced FMV only"; Underpriced Serials tight/coarse display removed (internal ordering kept); overview "Priced from Sales" tile KEPT as a basis fact; Analytics-tab FMV Health card and Portfolio Clarity Score REMOVED (both were confidence splits); Deals "Strict" and Parallel Premiums confidence toggles removed (the API still accepts the params). Rule + guard: `docs/reference/key-files-and-honesty.md` (end), CLAUDE.md concierge rule 3.

## For the next pass

- Read the conclusion of GitHub run 39203673094 (#189 missing-fill re-walk, ~2.5 h from 10:16 PM PT) and `extra.inserted` on `backfill-topshot-missing-fill-offers` before calling #189 better or worse.
- "Rpc autonomous pass" (`trig_01NXLc5syVPm5iN1Sgo4ijVs`) has no schedule and no device binding although its prompt says it is device-bound; it only runs when fired by hand. Left as is — Trevor's call whether to delete it.

- Read the CI conclusion of `ccf187f` (and the commits after it) first.
- With two sessions on one prompt, re-fetch `origin/main` and grep its subjects immediately before each item.
