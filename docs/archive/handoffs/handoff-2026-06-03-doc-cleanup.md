# Handoff — 2026-06-03 doc cleanup (full archive sweep)

Plain text, iPhone-pasteable. Docs-only — no source/code/SQL changes. Goal: declutter the repo of dated, shipped, point-in-time docs WITHOUT leaving any dangling links, and fix known doc drift. Companion to docs/handoff-2026-06-03-audit-followups.md (that one is the code follow-ups; this is purely housekeeping).

CONTEXT
The repo root and docs/ have accumulated ~100 dated point-in-time docs: 14 root *.md (7 are dated snapshots), 48 docs/handoff-*.md, 38 docs/audits/*.md. Most describe work that already shipped (cross-check docs/overnight/ledger.md). The repo already has a docs/sessions/ archive convention to extend. Two Cowork scheduled tasks were just updated to expect the new layout: rpc-weekly-health-report now writes PROJECT_HEALTH_<date>.md into docs/health/ (not the root), and rpc-weekly-health-check now also runs SELECT * FROM v_fmv_sanity_flags. Nothing else about the tasks changed.

GUARDRAILS
- Direct to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Use git mv (not delete+recreate) so history follows the files.
- Commit via PowerShell git on Windows. Re-verify the push with: git rev-list --count origin/main..HEAD (expect 0).
- This is markdown-only; npx tsc --noEmit and the build are unaffected, but confirm the Vercel deploy still reaches READY.
- Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file list (it drifts as the night pass adds handoffs).

HARD RULE — do NOT move these (active globs depend on them):
- docs/handoff-2026-06-03-audit-followups.md and docs/handoff-2026-06-03-doc-cleanup.md (this file) — active.
- Any docs/handoff-*-overnight-pass.md dated within the last 7 days — the rpc-weekly-health-check task globs these (docs/handoff-*-overnight-pass.md, last 7 days) to review autonomous changes. Keep the last 7 days of overnight-pass handoffs in docs/.
- docs/overnight/** (ledger.md, inbox/, metrics-latest.json, focus.md) — live night-pass state.
- The living reference docs in docs/ that are NOT dated snapshots: TOKEN_ROTATION.md, cadence-testing.md, code-todos.md, roadmap-2026-05.md, mcp-tool-mapping.md, nba-pipelines.md, cleanup-decisions-2026-06-01.md, and the docs/strategy / docs/migrations / docs/operations subtrees.
- Root: CLAUDE.md, README.md, README_flow.md, RPC_DESIGN_SYSTEM.md.

STEP 1 — create the archive tree
mkdir docs/archive/handoffs, docs/archive/audits, docs/health (git tracks files, so add a .gitkeep if empty).

STEP 2 — root declutter (definite, low-risk)
- git mv the 4 root health snapshots into docs/health/: PROJECT_HEALTH_2026-05-22.md, PROJECT_HEALTH_2026-05-25.md, PROJECT_HEALTH_2026-05-30.md, PROJECT_HEALTH_2026-06-01.md
- git mv the 4 root dated audits into docs/archive/audits/: AUDIT_2026-05-19_EV_PIPELINE.md, MOMENT_PAGES_AUDIT_2026-05-22.md, PACK_PAGES_AUDIT_2026-05-22.md, SET_PAGES_AUDIT_2026-05-22.md

STEP 3 — reconcile the duplicate cron doc
Root CRON_SCHEDULE.md vs docs/operations/cron-schedule.md. The docs/operations/ one was verified current (lists offers-sweep + evm). Diff them; keep docs/operations/cron-schedule.md as canonical. If root CRON_SCHEDULE.md is a stale duplicate, git rm it; if it has any unique content, fold that into docs/operations/cron-schedule.md first, then git rm the root copy.

STEP 4 — archive the shipped dated handoffs + audits
Cutoff for safety: archive everything dated 2026-05-26 or earlier (older than ~8 days, safely past the night-pass 7-day review window and any active work); leave 2026-05-28+ in place for now (the next cleanup can roll the cutoff forward).
- git mv docs/handoff-*.md dated <= 2026-05-26 into docs/archive/handoffs/ (this is the bulk: the 05-18 / 05-24 / 05-26 handoffs). Leave 05-28+ handoffs in docs/.
- git mv docs/audits/*.md that are dated point-in-time snapshots <= 2026-05-26 into docs/archive/audits/. KEEP the still-referenced/active ones in docs/audits/: full-platform-audit-2026-06-03.md, audit-2026-06-01-full-platform-pass.md, platform-audit-2026-06-02.md, fmv-livetoken-accuracy-2026-06-02.md, flowty-teardown-plan-2026-05.md (still the teardown reference), chain-aware-reads-2026-05-30.md + chain-aware-reads-db-2026-05-30.md (linked from CLAUDE.md chain strategy), refactor-plan-monolith-pages-2026-05.md (active plan). Use judgment: a doc whose work fully shipped and that nothing active links to = archive; a doc still referenced by CLAUDE.md or an open plan = keep.

STEP 5 — repoint links (this is the part that prevents dangling references)
After the moves, grep the repo for links to every moved file and repoint them to the new path:
- grep -rl on CLAUDE.md, README*.md, docs/**/*.md (excluding docs/archive) for the moved filenames; rewrite docs/X.md -> docs/archive/handoffs/X.md (or audits/ or health/) as appropriate.
- CLAUDE.md specifically references PROJECT_HEALTH_2026-05-22.md (known-issues intro) and the three *_PAGES_AUDIT_2026-05-22.md files (known-issue #17) — repoint those to docs/health/ and docs/archive/audits/.
- Do NOT rewrite links inside docs/archive/** or docs/sessions/** (frozen history — leave them as-is).

STEP 6 — fix doc drift (CLAUDE.md, same commit or a follow-up)
- Known-issue #15 (livetoken-portfolio* fixtures): mark RESOLVED — git ls-files shows none tracked (verified 2026-06-01). 
- Rookies view name: replace "topshot_rookies_board" with the live name "topshot_2025_rookie_index" in any ACTIVE doc (CLAUDE.md, cleanup-decisions, etc.). Leave frozen archive/ledger history alone.
- Known-issue #14 sniper/page.tsx line count: verify actual wc -l of app/(collections)/[collection]/sniper/page.tsx and correct the number if stale (~2,070 expected).
- Add a one-line note under CLAUDE.md's "Older sessions" / archive convention pointing at docs/archive/ (handoffs + audits) and docs/health/ (weekly reports), so the layout is discoverable.

VERIFY
- git status shows only renames + the link/drift edits; npx tsc --noEmit unaffected; deploy READY.
- A repo-wide grep for the moved filenames returns no remaining links pointing at the OLD paths (outside docs/archive and docs/sessions).
- Repo root no longer holds dated PROJECT_HEALTH_* / *_AUDIT_* files.

LEDGER ENTRY (paste into docs/overnight/ledger.md)
2026-06-03 (Cowork audit follow-up, doc cleanup handoff). Full archive sweep: moved root dated snapshots to docs/health/ + docs/archive/audits/, archived shipped handoffs/audits <= 05-26 into docs/archive/, reconciled root CRON_SCHEDULE.md against docs/operations/cron-schedule.md, fixed CLAUDE.md drift (#15 fixtures resolved, rookies view name, #14 sniper count), repointed links. Scheduled tasks updated same day: rpc-weekly-health-report now writes to docs/health/; rpc-weekly-health-check now runs v_fmv_sanity_flags (0 rows). Revert: git revert <sha> (renames reverse cleanly).

EXPECTED END STATE
Repo root holds only CLAUDE.md, README.md, README_flow.md, RPC_DESIGN_SYSTEM.md (+ config). docs/ holds active/reference docs + the last ~week of handoffs; docs/archive/{handoffs,audits}/ holds the shipped backlog; docs/health/ holds the weekly reports. No dangling links. One commit (or two: moves, then drift fixes), deploy READY.