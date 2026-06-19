# Handoff 2026-06-19 — roadmap refresh + ledger close + one optional code item

Plain text (iPhone-pasteable, no code fences). Mostly doc edits. One optional route change. Two parked references — do NOT action them.

## Context

This Cowork session (2026-06-18/19) shipped live: two DB migrations (audit_20260618_pinnacle_editions_fix_double_encoded_mojibake, audit_20260618_allday_floor_ask_carry_listing_ids), a cron reschedule (job 7776255 -> 4,34), and a go-live test alert sub. All of that is ALREADY ledger-logged by your prior commit 45c18ce (prevention + ledger do-now ship). This handoff adds only: (1) a roadmap refresh that 45c18ce's wave made stale, (2) one ledger close from a 06-19 finding, (3) one OPTIONAL route change, (4) two parked references. No new migrations/DB work here. HEAD at handoff time: 45c18ce.

Re-read each target file before editing — exact wording may have shifted since this was written; your direct file inspection wins over this doc and over project_knowledge_search on any disagreement. Adapt to the actual file shape.

## Item 1 (do now, doc only) — refresh docs/roadmap-2026-06.md

Why: the 06-18/19 wave shipped several things the roadmap still lists as "do now" or "open." Update these sections (find the current text, replace with the corrected status). Keep the existing house style.

"Where we are" — add one line to the 06-18/19 status: alerts went live end-to-end via the go-live test (1 sub, 31/31 delivered on all 3 channels); the public profile was made public + dedup-fixed (the ~4x moment/cost-basis inflation and fake -79% P/L); the AllDay deal-board leg + native "Buy on All Day" buy-links shipped; Pinnacle franchise/set mojibake fixed board-wide.

§Now item 1 (currently "topshot-buyer-backfill duration-creep ... Lever: lower batch 200->150") — replace with: SHIPPED — batch lowered 200->100 and maxDuration raised 600->800 (commit 7a70a31), and the cron was slowed to 4,34 (every 30 min, off-rush) which ended the overlapping-run contention. Runs now measure ~540-680s but sit safely under the 800s cap with no overlap. Residual = the OPTIONAL cap-rows-per-invocation defense (Item 3 of this handoff), low priority.

§Now item 2 (currently "Finish alerts-dispatch deal-leg optimization before promoting alerts") — replace with: SHIPPED — dispatch_due_deal_alerts got a 0-active-sub early-exit + statement_timeout 45->90s + route maxDuration 60->120, plus the AllDay deal-board leg (commit dd7e2bf + migrations). Alerts then went LIVE via Trevor's go-live test (1 sub, instant cadence, 31/31 delivered email+telegram+discord, 0 failed). Deal-leg timeouts stopped. Remaining = the cache-the-boards scale-path, which only matters as subscriber count grows.

§Now item 4 (cosmetic/hygiene) — mark mojibake FIXED (migration audit_20260618_pinnacle_editions_fix_double_encoded_mojibake + the normalize_pinnacle_edition de-double-encode trigger hardening; board-wide count 0), focus.md refreshed, and SERIAL-FMV-MULT-CRON reclassified (weekly pg_cron by design, not escalating). The only cosmetic left is pruning the ~12 fired one-off scheduled tasks.

§Open decisions item 2 ("Buyer-backfill batch size") — mark RESOLVED (batch 100 + maxDuration 800 + 30-min cron all shipped).

§Open decisions item 1 ("Turn alerts on for the allow-list?") — update: alerts are already LIVE with the go-live test sub and the deal-leg is optimized and 1-sub-proven, so the live decision is now "open alerts to the broader allow-list (25 users)?" rather than "turn the feature on."

Revert: git revert the roadmap commit. Verify: doc only — no tsc/deploy; just confirm it reads cleanly.

## Item 2 (do now, doc only) — close OFFER-SANITY-VIEW-REFINEMENT in docs/overnight/ledger.md

Why: investigated 2026-06-19. The v_rpc_trust_health leg offer_edition_gap_max_usd ALREADY filters WHERE has_sub_serial = false (confirmed via pg_get_viewdef), so the queued "optional WHERE NOT has_sub_serial" refinement is already implemented — there is nothing to ship. The 06-19 $300 breach was a REAL but transient edition-grain offer gap (not a sub-serial false-positive); the healthy offers-sweep surfaced and cleared it within its normal ~20-min cycle (the leg is back to 0/ok and the whole trust board is 9/9 green).

Action: move OFFER-SANITY-VIEW-REFINEMENT to Closed / already-implemented; do NOT re-queue it. Add a one-line monitor note: a transient offer_edition_gap_max_usd breach that self-clears while offers-sweep is healthy is EXPECTED (a fresh edition offer can sit unsurfaced for up to ~20 min until the next sweep) and should NOT be treated as an incident. No code/DB change. Revert: doc only.

## Item 3 (OPTIONAL, low priority) — buyer-backfill self-bounding cap

File: app/api/admin/backfill-topshot-buyers/route.ts (verified present; pipeline topshot-buyer-backfill).

Why: even at BATCH=100 (7a70a31) the 06-19 runs measured 540-680s — the bottleneck is per-row on-chain decode latency, not batch count. The 30-min cron (4,34) already removed the overlap and keeps runs under the 800s cap, so this is defense-in-depth only. Optional: inside the after() drain, add a wall-clock or rows-processed self-bound so a single invocation stops enqueuing new decodes past ~N rows or ~X seconds elapsed, regardless of cadence — so it can never approach the cap even if the cron is later sped up. Throughput is unaffected (the ~270/day new-null inflow is far below capacity). Detail: docs/handoff-2026-06-18-buyer-backfill-maxduration.md. Revert: git revert. Verify: npx tsc --noEmit clean, deploy READY, topshot-buyer-backfill keeps ok=true and logs a duration under the cap.

## Item 4 — PARKED, reference only — do NOT action

Rotation: docs/handoff-2026-06-19-ingest-token-rotation.md. Trevor deferred the INGEST_SECRET_TOKEN rotation. When he says go, the CC part is the transitional dual-accept validator change (accept old OR new token, then retire old). Do not start it unprompted.

AllDay floor-serial backfill: docs/handoff-2026-06-19-allday-serial-backfill-proxy-routing.md. The edge function is CORRECT — its consumer-GQL request is byte-identical to the proven allday-unmapped-resolver. It is blocked by the EXTERNAL AllDay consumer-GQL Cloudflare 1009 (datacenter-IP/region WAF ban), not by code. Do NOT keep editing the function (the "User-Agent fix" hypothesis in that doc is superseded). Fold it into the open allday-consumer-gql-403 infra item (region-resilient / residential egress fixes the resolver too); leave its cron running for opportunistic fills (ok=false on blocked runs writes nothing and is harmless).

## Guardrails

Work directly on main — no branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first. Commit via PowerShell git on Windows (Git Bash git commit can silently no-op); re-verify the push with git rev-list --count origin/main..HEAD (expect 0). curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest. Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly. CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines. Don't echo any Bearer/token/secret values (per the new secret-safety rule 45c18ce added to CLAUDE.md).

## Expected end state

Items 1-2: roadmap-2026-06.md reflects the 06-18/19 reality and OFFER-SANITY-VIEW-REFINEMENT is closed in the ledger — two doc commits on main, no deploy needed. Item 3 (if done): one route commit on main, deploy READY, topshot-buyer-backfill self-bounds under the cap. No migration/DB work in this handoff.
