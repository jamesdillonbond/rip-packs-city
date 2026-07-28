# Handoff — 2026-07-28 · health-check + audit follow-ups

## Context

Cowork ran a full health check and audit today. **Two things are already shipped and need nothing from you:**

- **`package-lock.json` repaired — committed locally as `91236782` on `main`, NOT yet pushed.** Your first job is to push it. Details in item 0.
- **`pipeline_cadence_watchlist` row for `panini-ingest` activated** (DB-only; `is_active=true`, `max_silent_minutes=360`, severity stays `info`). Verified `detect_stalled_pipelines()` still returns `[]` after the change, so it did not introduce a false positive. Revert SQL is stored verbatim in that row's `notes` column.

Everything below is route/`.tsx`/config code that Cowork cannot push.

**HEAD at handoff time: `91236782`** (parent `34bb8375`). Working tree clean apart from an untracked `_to_delete/git-stale-locks-20260728/` folder — see item 5.

---

## 0. PUSH THE LOCKFILE FIX FIRST (already committed, not pushed)

**File:** `package-lock.json`
**Commit:** `91236782`

`npm ci` has been failing on `main` with `EUSAGE … Missing: @noble/hashes@2.2.0 from lock file`. Carried as an open item since 2026-07-28 and previously mis-recorded as a sandbox / Node-22-vs-24 quirk. It is neither.

**Root cause (verified, not inferred):** `@exodus/bytes` — a transitive dep under `jsdom`, `data-urls` and `html-encoding-sniffer` — declares `peerDependencies: { "@noble/hashes": "^1.8.0 || ^2.0.0" }`. The root `@noble/hashes` is pinned at **1.7.0**, which does not satisfy that range, so npm must place a nested copy for each of the three consumers and resolves it to **2.2.0** — and the lock had no entry for any of them. Because this is npm's *pre-install* sync check, it is Node-version-independent: any CI job running `npm ci` was failing **before** install, not during it.

**How it was verified:**

- Reproduced: `npm ci --dry-run` → `EUSAGE … Missing: @noble/hashes@2.2.0` (×2).
- Regenerated with `npm install --package-lock-only`.
- Re-ran: `npm ci --dry-run` → resolves **1,106 packages** cleanly.
- Diffed the lock entry-by-entry across all 1,110 pre-existing entries: **3 added, 0 removed, 0 version changes.** `git diff --stat` = 45 insertions, 0 deletions.

The three added entries are all marked `"dev": true, "optional": true, "peer": true` — jsdom test-toolchain only — so the production bundle is untouched.

```powershell
git rev-parse --abbrev-ref HEAD          # expect: main
git log --oneline -1                     # expect: 91236782
git push origin main
git rev-list --count origin/main..HEAD   # expect: 0
npm ci                                   # expect: clean install, no EUSAGE
```

**Revert:** `git revert 91236782`. (Workaround if you ever need it again: `npm install --package-lock=false`.)

---

## 1. `PANINI_PUBLIC` is a dead constant — the Panini go-live is NOT a one-line flip

**Files:** `lib/launch-flags.ts`, `proxy.ts`, `lib/sitemap-data.ts`, `app/insights/page.tsx`, `app/insights/panini-squeeze/layout.tsx`, `app/api/smoke-test/route.ts`

This is the highest-value item in the handoff, because it is a trap rather than a bug: **flipping `PANINI_PUBLIC = true` today would change nothing at all, silently.** The board would stay gated and you would believe you had launched.

**Verified by grep** across `lib/`, `app/`, `proxy.ts` and `__tests__/`: `PANINI_PUBLIC` has **zero consumers**. The only three hits are its own declaration in `lib/launch-flags.ts:53`, a doc-comment reference on line 47, and two `vi.doMock` lines in `__tests__/candy-launch-flag-contract.test.ts` that merely *supply* it to satisfy the mock's shape. By contrast `CANDY_MLB_PUBLIC` has **five** real consumers, which is exactly what makes the Candy flip atomic.

Panini's gate today is a hardcoded regex with no flag behind it — `proxy.ts:128`:

```ts
if (/^\/(?:insights|api\/public\/insights|api\/og\/insights)\/panini/.test(pathname)) return false
```

**What is missing, per consumer** (each verified by grepping for `panini` in the named file):

| Consumer | Candy has it | Panini has it | What to add |
|---|---|---|---|
| `proxy.ts` gate | yes, flag-driven (line 136) | **regex only, no flag** (line 128) | `!PANINI_PUBLIC && /…\/panini/` |
| `lib/sitemap-data.ts` | yes (line 505) | **no `panini` reference at all** | `...(PANINI_PUBLIC ? ['panini-squeeze'] : [])` |
| `app/insights/page.tsx` hub card | yes (line 324) | **no `panini` reference at all** | conditional hub card |
| `layout.tsx` `robots` | flag-gated (line 60) | **hardcoded `index: false`** | `...(PANINI_PUBLIC ? {} : { robots: … })` |
| `app/api/smoke-test/route.ts` | yes (line 845) | **no `panini` reference at all** | `...(PANINI_PUBLIC ? ["/insights/panini-squeeze"] : [])` |

Mirror the Candy pattern exactly — `docs/candy-go-live-flip-2026-07-25.md` is the reference. Add a `__tests__/panini-launch-flag-contract.test.ts` modelled on the Candy one, asserting **both** directions (flag false ⇒ gated + noindex + absent from sitemap/hub/smoke; flag true ⇒ all five activate). The Candy test is what makes a half-ship impossible; Panini deserves the same.

**Leave `PANINI_PUBLIC = false`.** This item wires the switch; it does not throw it. Throwing it is Trevor's call.

**Revert:** revert the wiring commit. The flag stays `false` throughout, so no public surface changes either way.

---

## 2. Recent Sales panel is ~60% empty because three fields are hardcoded `null`

**File:** `app/api/recent-sales/route.ts` (single file, ~80 lines)

Carried as open item 2 from the 2026-07-28 session close, described there as "an API hydration gap." It is narrower and cheaper than that: the route **never attempts** to populate them. Lines 69–71 of the response map are literals:

```ts
editionKey: row.editions?.external_id ?? null,
playerName: null,
setName: null,
fmv: null,
```

That is why `Player`, the set sub-label and `vs FMV` render `—` on all 15 rows of every collection.

**The data is fully available — verified, not assumed.** For the 15 most recent Top Shot sales, joining `editions` and taking `DISTINCT ON (edition_id) … ORDER BY edition_id, computed_at DESC` from `fmv_snapshots`:

| field | rows populated |
|---|---|
| `editions.player_name` | **15 / 15** |
| `editions.set_name` | **15 / 15** |
| latest `fmv_snapshots.fmv_usd` | **15 / 15** |

**The fix:**

- `player_name` and `set_name` are **denormalized columns on `editions`** — just widen the existing embed from `editions(external_id)` to `editions(external_id, player_name, set_name)`. No extra round-trip, no new join, and the embed is already a LEFT embed over the ≤50 returned rows (the comment block above the query explains why it must stay that way — do not turn it back into an `editions!inner` filter, that was the 22-second regression).
- `fmv` needs one extra query: collect the ≤50 `edition_id`s from the result and do a single `DISTINCT ON (edition_id)` lookup against `fmv_snapshots` ordered `edition_id, computed_at DESC`. Note `fmv_snapshots` is **partitioned and has no source column**, and daily duplicates are intentional history — `DISTINCT ON` is the canonical latest-per-edition pattern, do not `max()` it.

Pinnacle is **not** served by this route's FMV shape (Pinnacle FMV is render-keyed on `pinnacle_catalog.fmv_*`, not in `fmv_snapshots`), so if this route is ever pointed at Pinnacle the FMV leg needs a separate branch. Today `collectionId` defaults to `nba-top-shot`.

**Verification:** `npx tsc --noEmit` clean, deploy READY, then confirm on a collection page that `Player`, the set sub-label and `vs FMV` are populated rather than `—`. Assert with a `document.querySelector` DOM query, **not** an accessibility-tree read — infinite scroll pushes this panel past the tree's truncation limit and it will read as absent when it is present (this cost real time on 2026-07-27).

**Revert:** revert the commit; the panel returns to `—`.

---

## 3. `sales-ingest-dune` is hard-failing every 2 hours on a blown Dune quota

**Files:** `vercel.json` (cron entry), `app/api/cron/sync-sales-ingest-dune/route.ts`

**36 runs, 0 successes — not once, ever, in the full retained `pipeline_runs` window.** Every single one throws:

```
threw: execute HTTP 402 (2021-12-30..2022-01-01): {"error":"This api request would exceed your
configured datapoint limit per billing cycle. Please visit your subscription settings on dune.com
and adjust your limits to perform this request."}
```

The cursor in `sales_ingest_state` is frozen at `cursor_end = 2022-01-01` (last advanced 2026-07-25 17:29Z) against `floor_date = 2019-01-01` with `window_days = 2` — **roughly 548 windows still to walk, and it cannot walk one.** `vercel.json` fires it at `11 */2 * * *`, so it is burning 12 invocations/day for a guaranteed 402.

This is the concrete evidence behind the 2026-07-26 roadmap's "retire Dune to audit-only" call, and it upgrades that call from a preference to a fact: the ingest leg is not degraded, it is **structurally dead until the billing cycle resets or the limit is raised.**

**Important distinction — do not disable the wrong one.** The sibling `sales-seller-recovery-dune` (hourly, `47 * * * *`) is **healthy**: its last 8 runs are all `ok=true` with no error. Its query is small enough to fit under the remaining cap. Leave it alone.

**Recommended action:** remove *only* the `/api/cron/sync-sales-ingest-dune` entry from `vercel.json`. Keep the route and `sales_ingest_state` intact so the lane is revivable — this mirrors how `drain-base-parallel-probe` was retired on 2026-07-26. Add a line to `docs/operations/cron-schedule.md` recording the retirement and the 402 reason.

The route is already written to be inert without config (`skipped: 'dune_not_configured'` unless `DUNE_PROXY_URL` + `DUNE_PROXY_SECRET` + `DUNE_SALES_INGEST_QUERY_ID` are all set), so unsetting one env var in Vercel is an equally valid operator-side kill switch if Trevor prefers that to a code change.

**Revert:** re-add the `{"path": "/api/cron/sync-sales-ingest-dune", "schedule": "11 */2 * * *"}` entry to `vercel.json`.

---

## 4. `panini_squeeze_board.real_sales` contradicts its own FMV confidence on 22% of rows

**File:** the view `public.panini_squeeze_board` (DB — Cowork *can* ship this, but it is a **product/editorial call**, so it is listed here for Trevor's decision rather than applied)

On the board that `/insights/panini-squeeze` renders, **827 of 3,753 editions (22%) show `fmv_confidence = HIGH` next to `real_sales = 0`** — average FMV $270.59, maximum **$48,927.70**. A reader sees "high confidence, zero sales" and correctly concludes something is broken.

**Nothing is broken. The instrument is.** Traced to `lib/chains/panini/ingest-normalize.ts:53–55`:

```ts
if (txns > 0 && Number.isFinite(+ms.recent_sale)) {
  fmv = +ms.avg_sale || +ms.recent_sale;
  confidence = txns >= 3 ? "HIGH" : txns === 2 ? "MEDIUM" : "LOW";
}
```

Confidence comes from `ms.txns` — a **transaction count from the upstream marketplace stats feed**. But `real_sales` on the view is a completely different and far sparser quantity:

```sql
(SELECT count(*) FROM panini_card_serials cs
  WHERE cs.edition_external_id = e.external_id AND cs.last_sale_usd IS NOT NULL) AS real_sales
```

Only **5,052 of 29,222** ingested serials (17.3%) carry a `last_sale_usd` at all. Of the 827 contradictory editions, 819 *do* have serial rows ingested — the price column is simply empty on every one. So the FMV is genuinely sales-backed; `real_sales` is measuring serial-level price coverage and being read as market activity.

This is squarely the measurement-lies class the project tracks, and it is **live on a launch surface**. Options, cheapest first: rename the column to something honest (`serials_with_recorded_price`), or source it from the same `ms.txns` the confidence uses, or drop it from the public board. Recommend deciding before Panini goes public, not after.

**Also noted while in there, not launch-blocking:** `panini_fmv_snapshots.serial_fmv` is **NULL on all 13,089 rows** — never once written — and `panini_serial_premium` has **3 rows** while `panini_pack_ev_board` has **2**. Those two boards are effectively empty. They are not the launch surface (`panini_squeeze_board` is), so they do not block, but do not link to them either.

---

## 5. Housekeeping: stale git lock files were moved, not deleted

Committing `91236782` through the Cowork device bridge left three zero-byte lock files behind (`.git/HEAD.lock`, `.git/index.lock`, `.git/objects/maintenance.lock`) because the bridge cannot unlink. A stale `HEAD.lock` blocks any future operation that updates HEAD, so they were moved to:

```
_to_delete/git-stale-locks-20260728/
```

Verified afterwards that `git status`, `git log` and `git commit` all work. **Please `rm -rf _to_delete/` — it is untracked and will otherwise show up in your next `git status`.**

Two pre-existing, unrelated conditions were observed and deliberately left alone: `git fsck` reports a stale commit-graph referencing two unreadable commits (`42f4aff3`, `847f8339`) — harmless, fixable with `git commit-graph write --reachable` if it ever annoys you — and there are orphaned `.git/objects/**/tmp_obj_*` files from earlier sessions, which git ignores.

---

## Guardrails

- **Direct-to-`main`. No branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git checkout main` first.
- **Commit via PowerShell `git` on Windows** — Git Bash `git commit` can silently no-op. Re-verify every push with `git rev-list --count origin/main..HEAD` (expect `0`).
- **`curl` fails silently in Git Bash for Vercel REST** — use PowerShell `Invoke-WebRequest`.
- **Vercel Pro `maxDuration` hard cap is 800s** — anything higher sends the deploy to ERROR invisibly.
- **CRLF:** do not string-replace-patch on Windows; use full-file writes or `findIndex` on split lines.
- Assert any UI presence with `document.querySelector`, never an accessibility-tree read.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

---

## Expected end state

`91236782` pushed and `npm ci` green on `main`; `PANINI_PUBLIC` wired into all five consumers with a both-directions contract test while staying `false`; the Recent Sales panel rendering player, set and vs-FMV instead of `—`; the dead `sales-ingest-dune` cron retired from `vercel.json` with its route preserved; `_to_delete/` gone; `npx tsc --noEmit` clean and the deploy READY.
