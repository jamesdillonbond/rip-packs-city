# Handoff — 2026-06-22 (Cowork audit, session 2 follow-ups)

Continuation of [handoff-2026-06-21-platform-audit.md](handoff-2026-06-21-platform-audit.md). That handoff's code/operator items (E/F/G/H/B/C/D) were drained by Claude Code (`ed66a5b` + 3 migrations + `cde413b`). This session then **resolved the rest from Cowork** — including the one item the first handoff had marked operator-gated (the 106 thumbnails), whose root cause turned out to be different than assumed.

Platform state: **GREEN.** Security 0/0/0/0, trust-health 9/9, Sentry **0 unresolved**, Vercel 0 ERROR, GHA all scheduled workflows firing.

## Shipped live this session (Cowork, all on `main`, all verified live — post-ship watch only, do NOT re-flag)

Full detail + revert paths in [docs/overnight/ledger.md](overnight/ledger.md) (top of the Shipped section).

1. **`f6ee7d47` — CONCIERGE RESTORED (critical).** Retired-model migration `claude-sonnet-4-20250514` → `claude-sonnet-4-6`. The concierge had been erroring for all users since Anthropic's 06-15 retirement. Verified live.
2. **`f27bb70f` — pack-reality intro median** (hardcoded `$0.00` → dynamic; was contradicting the KPI). Verified live.
3. **`0e251ab5` — concierge FMV version** label 1.5.0 → 1.7.0.
4. **`1e47c295` — `check_pgcron_recent_failures()` wired into `focus.md`** health-sweep (read every run by the monitor + night pass), with stale-pre-fix discipline.
5. **`7fe106d3` — CSP allow `ipfs.dapperlabs.com` (proxy.ts img-src + media-src).** This was the **actual root cause of the 106 "broken" Series-1 thumbnails** — not a dead gateway. The Dapper gateway is healthy (verified: serves a 2880px PNG at top-level); the CSP whitelist simply omitted the host, so the browser blocked them. Verified live: base-set dapper-ipfs images **0 fail (was 46/46)**, auth intact. CSP-header-only — no auth logic touched.

## Residual follow-ups for Claude Code — all LOW / nice-to-have (nothing is broken)

### 1. [LOW] Migrate the 106 Dapper-IPFS editions to the `assets.nbatopshot.com` CDN
They **render fine now** (the CSP fix unblocked them), but they load from the slower Dapper IPFS gateway instead of the fast CDN the other 9,061 TS editions use. Optional optimization for perceived load speed + resilience (if Dapper ever sinks the gateway). Find them: `SELECT id, external_id FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND thumbnail_url ILIKE '%ipfs.dapperlabs.com%'` (≈106). Refresh `thumbnail_url`/`video_url` from TS GQL `searchEditions` media (the `assets.nbatopshot.com/editions/<setid>_<slug>_<tier>/<uuid>/...` form) via topshot-proxy, keyed by `set.flowId`/`play.flowID` (+`parallelID` for the `::` rows); capture old values in an `audit_` table first (reversible). Needs the proxy secret (token-gated — why it can't be done from Cowork). If GQL returns no media for a retired play, leave the (now-working) Dapper URL as-is.

### 2. [LOW] Add a model-retirement guard to the concierge — the lesson from this session
The concierge silently died for ~7 days because a retired Anthropic model surfaced only as the generic "Something went wrong" fallback. Make this loud next time: in `app/api/support-chat/route.ts` `classifyAnthropicError`, special-case the model-not-found / model-retired error class (HTTP 404 / `not_found_error` naming the model) into a **distinct Sentry tag or `pipeline_runs` row** (e.g. `concierge-model-error`) so the next retirement pages immediately instead of hiding in the generic catch. Optionally also add the concierge model id to a periodic check. Low effort, high leverage.

### 3. [LOW / operator] Permanent SKILL.md paste of the pg_cron check
`focus.md` already wires `check_pgcron_recent_failures()` into the running monitor + night-pass sweeps (commit `1e47c295`). For permanence, paste the same bullet into the health-sweep section of the two scheduled-task `SKILL.md` files (`rpc-daytime-monitor`, `rpc-weekly-health-check` — they live in `OneDrive\Documents\Claude\Scheduled\`, outside the repo + the Cowork sandbox). Exact bullet is in `focus.md` under "STANDING (added 2026-06-22)".

## Post-ship verify (the night pass / next session should confirm these hold)

- Concierge answers a live FMV question (not the fallback error). ✓ verified this session.
- `/insights/pack-reality` lede median == the MEDIAN KPI. ✓ verified ($1.69).
- `/nba-top-shot/set/base-set`: dapper-ipfs images load (0 fail). ✓ verified; confirm they fully populate on a calm load.
- `check_pgcron_recent_failures()`: the two stale pre-fix entries (`rpc-remap-misattributed-sales`, `rpc-refresh-special-serial-owners-mv`) clear after their next ticks (**MV 16:13Z**, **remap 18:23Z**). If either still fails after that, it's real.
- Auth/lockdown still gates (the CSP change must not have affected it). ✓ verified the authed page renders + login redirect unaffected.

---

## RESOLUTION — 2026-06-22 (Claude Code, session 3)

All actionable follow-ups drained. Detail + revert paths in [docs/overnight/ledger.md](overnight/ledger.md) (top Shipped entry).

- **#2 — SHIPPED.** `app/api/support-chat/route.ts`: new `"model_error"` mode (Anthropic 404 / `not_found_error` / model-naming msg), distinct `concierge_model_error` category, and `reportConciergeModelError()` writing a `concierge-model-error` `pipeline_runs` row (ok=false) from both catch sites so a retirement pages immediately. Also extracted `CONCIERGE_MODEL` as the single source of truth (next bump = one line). tsc clean. The `classifyAnthropicError` lesson is now codified.
- **#1 — NOT ACTIONABLE (premise overturned).** It's 185 editions (137 `::` parallels + 48 base), not 106. **Zero `::` parallels platform-wide have CDN art** (1,638 NULL / 137 ipfs / 0 CDN) — ipfs is the canonical/only art source for parallels; migrating = regress to NULL. The 48 base are special-set editions (23 under a synthesized `auto_` set id; the rest Anthology/Fit Check/Holo Icon/NBA Cup/Base Set) — a read-only `searchEditions` probe returned **NOT_IN_SET for all 48** (the marketplace GQL doesn't surface them), so there's no CDN `assetPathPrefix` to migrate to. They fell to ipfs precisely because GQL/CDN has nothing; the CSP fix (`7fe106d3`) already makes all 185 render. **→ Trevor: move "106 dead thumbnails" to "Declined — do not re-suggest."**
- **#3 — operator-only**, unchanged (SKILL.md files live outside the repo; `focus.md` already wires the check in via `1e47c295`).
- **pg_cron post-ship verify — both confirmed real-fixed.** MV fn carries `enable_nestloop='off'`; remap fixes landed 13:46Z (after the 12:23Z fail). Ran the exact cron command manually: remap = 81 sales re-keyed in 25.8s, detector = 27 rows in 3.4s, both well under the 120s caps. 16:13Z (MV) + 18:23Z (remap) ticks will go green.
