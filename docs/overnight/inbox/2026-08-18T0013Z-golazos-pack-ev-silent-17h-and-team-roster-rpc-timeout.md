# Daytime monitor: `compute-golazos-pack-ev` silent 17.5h + `get_team_players` 45s timeout on team pages

Filed by `rpc-daytime-monitor` 2026-08-17 17:1x PT / 2026-08-18 00:1xZ. READ-ONLY sweep. Platform is broadly healthy (security 4/4 clean, FMV writing fresh — newest snapshot 2.5 min ago, DB 13,157 MB, 0 Vercel ERROR deploys). These are the only two items not already documented in the ledger or in today's inbox. **Both are plausibly disk-IO-saturation collateral (focus.md #3: one root cause), so the disposition below is confirm-vs-chase, NOT raise-a-timeout.**

## 1. `compute-golazos-pack-ev` cron-silent 17.5h (MED)

- **Source:** `detect_stalled_pipelines()` — last run 2026-08-17T06:37:31Z, silent 1049 min vs `max_silent_minutes` 800. Not in ledger, not in today's inbox.
- **Why it matters:** this is the pipeline that actually covers the `laliga_golazos` pack-EV board. Its sibling `compute-laliga-pack-ev` is the KNOWN-broken-but-not-user-facing one (ledger ~16026: dies daily at route.ts:186 on a `pack_ev_history` schema mismatch; explicitly noted that "`compute-golazos-pack-ev` covers the collection"). So a silence of the *healthy* one is the user-facing risk, not the noisy sibling.
- **Blast radius so far: not yet breaching.** Trust arm `pack_ev_board_max_stale_days` = 1.27 (breach_at 2) — the golazos board is stale but under threshold. If the silence persists another ~day it will breach.
- **Likely cause:** saturation. Peers `compute-allday-pack-ev` (34% fail, `get_fmv_for_editions: upstream request timeout`) and `compute-topshot-pack-ev` (72 fails/24h) are timing out on the same get_fmv path; a golazos tick that times out logs no row and reads as silence (the log-on-completion-only class).
- **Suggested action (night pass):** confirm whether the golazos cron is timing out (Vercel runtime error on its route) vs genuinely unscheduled, and whether the board is going stale to users. Lever is cutting work / page size per focus.md #3 — do NOT raise the route timeout. Low-risk; do not auto-ship a pack-EV route change (off-limits class).

## 2. `get_team_players` timed out after 45,000ms — team roster pages (MED, user-facing)

> ✅ **ITEM 2's HONESTY CHECK ANSWERED 2026-08-18 (Claude Code) — NO DEFECT. Do not re-investigate.** The
> monitor asked to *"verify the page renders an HONEST degraded state on this timeout, not a false
> 'roster unavailable'/empty-roster that reads as a fact about the team."* **It does, by design, and the
> design is test-pinned.** Chain traced end to end:
> 1. `app/(collections)/[collection]/team/[slug]/page.tsx:84` fetches the roster via
>    `sectionRows<PlayerTile>("team roster", "get_team_players", …, { structural: true })`.
> 2. `lib/entity-section-rpc.ts` retries through `rpcWithRetry`, then **THROWS** for a structural section:
>    `throw new Error(\`${tag} unavailable: ${error.message}\`)`. **The Sentry string the monitor quoted —
>    "team roster unavailable: rpc get_team_players timed out after 45000ms" — IS that throw.** The alert is
>    the policy working, not evidence of a lie.
> 3. It reaches `app/global-error.tsx` (no nearer `error.tsx`; only 2 boundaries exist app-wide), which
>    renders *"Something went wrong / An unexpected error occurred. Our team has been notified."* plus a
>    **Try Again** button, and re-captures to Sentry.
>
> **At no point is an empty roster rendered.** ⚠ The helper's header records that this is exactly the
> defect it was built to close on 2026-07-26 — the prior shape was `if (error) return []`, which *"renders a
> PLAUSIBLE EMPTY STATE — a Miami Heat page with an empty roster looks exactly like a team we have no data
> for."*
>
> **Pinned:** `__tests__/entity-section-rpc.test.ts`, **13/13 passing**, including *"THROWS for a structural
> section once retries are exhausted"* and — the three-state distinction the canon requires — *"an empty
> result is NOT an error — a genuinely empty section stays empty"*.
>
> ⚠ **So the residual is PURELY performance**: `get_team_players` hitting the 45 s client ceiling under
> saturation. The monitor's own guidance stands — **shrink the RPC's work, do not raise the ceiling** — and
> that is an owner call. ⚠ **Item 1 (golazos pack-EV) is NOT covered by this note and remains open.**

- **Source:** Sentry `JAVASCRIPT-NEXTJS-2J` — "team roster unavailable: rpc get_team_players timed out after 45000ms with no response", culprit `GET /[collection]/team/[slug]`. First seen ~10h ago, last seen ~2h ago, 2 events / 1 user.
- **Why it matters:** a real user hit a team roster page that could not render. Saturation-class RPC timeout (`get_team_players` at the 45s client ceiling). Not in ledger/inbox.
- **Honesty check for the night pass (the higher-value angle):** verify the page renders an HONEST degraded state on this timeout, not a false "roster unavailable"/empty-roster that reads as a *fact* about the team. Per the honesty canon a failed read must not render as an answer — the fix, if any, is the degradation branch, not the timeout value.
- **Suggested action (night pass):** (a) confirm the team page's timeout path degrades honestly; (b) if `get_team_players` is a heavy RPC, the lever is shrinking its work, not raising the 45s ceiling. Low-risk to investigate; any route change is a judgment call for Trevor.

## NOT re-logged (already documented today — measurement-discipline note)
- `public_board_empty_count` = 999 and `public_board_slow_count` = 999 are the **`budget_exhausted` saturation sentinel** from `rpc_thp_leg_board_liveness` (ledger line ~212, filed today) — NOT 999-boards-empty, NOT the exception sentinel. Known.
- `trust_precompute_max_age_hours` = 17.3h (breach_at 13): the 8-way precompute leg oscillating stale under saturation; night pass cleared it at 10.4h at 08:11Z, re-crept since. Known-class.
- 7 pg_cron `REFRESH MATERIALIZED VIEW … statement timeout` failures (allday-pack-realized, topshot-pack-sales-agg, thp-leg-impossible-parallel, attribute-pack-rips, misattrib-candidates, new-collectors, thin-sale-ask-disclosure): the documented cron_heavy saturation cluster (ledger ~542). All saturation-class, none post-date a same-day fix. Known.
- `candy-editions-ingest` (3806m silent, 08-04 timeout incident, handed off), `allday-pack-opens-backfill` (191m, finite spork walk), `panini_sale_price_capture_dry_days` (20, crying-wolf per focus.md), `unmapped_resolution_backlog_max` (284, AllDay permanent floor), Sentry smoke-check-could-not-run (honest degradation working). All known — do not re-raise.
