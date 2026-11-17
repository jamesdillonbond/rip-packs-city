# Daytime monitor — pg_net HTTP 403 "PERMISSION_DENIED" (Firestore-shaped) cluster, plus two low-priority notes

**Run:** daytime health monitor, 2026-10-04 ~00:05Z (2026-10-03 ~5:05 PM PT). Read-only. Platform HEALTHY overall (security clean, trust 37/37 ok 0 breaches, stalled [], pg_cron 0 fails/24h, sentinel 0, all production deploys READY, boards 0 empty / 0 slow, FMV + cross-collection fresh). These are harvest items for the night pass, not a breakage.

## Candidate 1 (primary) — attribute the pg_net_http_403 "PERMISSION_DENIED" cluster
- **Title:** `pg_net_http_403` arm reports 40 calls/2h returning HTTP 403 with a **Firestore-shaped** body (`{"error":{"code":403,"message":"Missing or insufficient permissions.","status":"PERMISSION_DENIED"}}`) — arm severity "critical", but un-attributable by design (net._http_response has no url column).
- **Source:** `rpc_ops_snapshot().pipeline_alerts` → `pg_net_http_403` (2026-10-04T00:03Z sweep). Not attributable to the Atlas editions walk, Atlas market feed, or pack-pull hydrator (those join by request_id and report separately).
- **Why it stands out:** unlike the sibling 400/404 arms (Flow "Invalid Flow argument" / "no known transaction" = self-inflicted Flow-script probes, by-design) and the 429 arm (rate-limit burst), this body is a **Google/Firestore permission denial**, not a Flow error. It was **not** in the 2026-10-03 ~3:58 PM PT metrics-latest pipeline_alerts list (that run listed pg_net_429 only), so the 403 signature is new to the alert set this window.
- **Leading hypothesis (for the night pass to confirm, NOT a conclusion):** most plausibly the **already-muted `sync-nba-projections` Firestore/Google upstream** (`all_upstreams_failed`, 8 fails/24h, 403 — muted to 2026-10-28 per focus #8, fails safe). If so, the pg_net_403 arm is double-counting an already-dispositioned lane and the row is benign. The alternative reading is a distinct mis-permissioned endpoint (stale `?key=` gate / rotated secret on some Firestore-backed call).
- **Risk read:** LOW. No freshness/trust impact observed (all collections fresh, 0 boards empty/slow). The arm is explicitly non-attributable; this is a sensing item.
- **Suggested action (night pass):** attribute the 403 source via `net.http_request_queue` (URL lives there pre-drain) joined on the response ids, or correlate counts with `sync-nba-projections` run cadence. If it is the muted projections upstream, annotate the arm note so it stops reading as "critical" for a dispositioned lane; if it is a distinct endpoint, treat as the real finding. Do not chase as an outage — freshness is intact.

## Candidate 2 (low) — confirm topshot-pack-supply-atlas "1 request(s) failed" is Atlas-Cloudflare-403 base rate
- **Title:** `topshot-pack-supply-atlas` logged `ok=false "1 request(s) failed"` ~7× in 24h (7 of the last 6h clustered 22:54–23:35Z), single-request partials, lane NOT stalled.
- **Source:** `pipeline_runs` ok=false scan + `rpc_ops_snapshot().pipeline_fails_24h` (topshot-pack-supply-atlas: 7, upstream 0).
- **Risk read:** LOW. Single request out of each batch, re-walked next tick; consistent with the documented Atlas-egress Cloudflare 403 base rate (`atlas-editions-upstream-403` / `atlas-market-upstream-403` both INFO, 0 sets stalled). Not previously filed by this pipeline name.
- **Suggested action (night pass):** confirm the failing request is the Cloudflare-challenge base rate on the Atlas pack-supply egress (by-design, re-walked) vs a distinct endpoint fault; if by-design, add it to the known-partial set so it is not re-harvested.

## Note (informational, no action) — active Cowork artifact estate not enumerable from this monitor session
- The only artifact-list tool available this run (`list_legacy_live_artifacts`) returns the **stale legacy store** (11 entries, newest updatedAt 2026-08-16), which does **not** include the current active estate (rpc-offers-intelligence, rpc-cross-collection, rpc-trophy-ladder, rtr-pack-finder, candy-chain-two-onboarding-status, etc.). So per-artifact payload-query validation (Section 1b) could not be performed this run.
- **Coverage used instead:** snapshot board-health as proxy — `public_board_empty_count`=0, `public_board_slow_count`=0, `cross_collection_mat_staleness`=[], all FMV collections fresh → no schema change has broken a dashboard-backing view this window.
- This is a monitor-tooling visibility gap, not a broken dashboard; flagged so the night pass knows daytime artifact validation is currently proxy-only from the cloud monitor.

---

## ✅ RESOLVED — disposition (overnight pass ~1:15 AM PT 10-04; re-verified by Claude Code, Windows box, ~7:20 AM PT 10-04)

- **Candidate 1:** the leading hypothesis did not fit. `sync-nba-projections` runs every 3 h at :07 and did not run in the 3:03–5:03 PM PT window. The Firestore-shaped 403s were the Flowty Firestore-index verification backfill (scratch pg_cron 689/690 reading `flowty-prod` Firestore), which ran 3–5 PM PT 10-03 and is finished and unscheduled. **Re-checked ~7:20 AM PT:** 0 rows in `net._http_response` with a 403 `PERMISSION_DENIED` body across the whole retained window (oldest row 1:15 AM PT). No production endpoint was involved, so no arm annotation is needed.
- **Candidate 2:** `topshot-pack-supply-atlas` "1 request(s) failed" is the single-request Cloudflare 403 base rate on Atlas; the request is re-walked next tick. By design.
- **Note (artifact estate):** monitor tooling gap (it only has the legacy artifact store), not a dashboard fault.

This filing was found on the box sitting untracked in `inbox/archive/`. It belongs here: the inbox is append-only (`__tests__/inbox-is-append-only-since-the-rule.test.ts`).
