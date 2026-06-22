# Handoff — Cowork asset audit follow-ups (2026-06-22)

## Context

A Cowork session audited RPC's **skills, scheduled tasks, and Cowork artifacts** (read-only first, then executed every Cowork-native fix). HEAD at handoff: `bc3b01c`. This doc is the remainder that needs git / route / dependency work CC must ship.

**Already done live by Cowork (no CC action needed):**
- Retired 2 ephemeral artifacts to on-brand tombstones (`pack-drops-ev-check`, `rpc-ts-data-mission`) — artifacts live on OneDrive, not in the repo.
- Fixed the `rpc-flow-ecosystem-watch` scheduled-task prompt (the Pinnacle REST URL was abbreviated → `web_fetch` provenance rejected it → an IPFS-resolver tripwire couldn't run; now full/verbatim).
- Verified `seed_topshot_sales_history_targets()` is already `service_role`-only (anon/auth EXECUTE = false; `check_secdef_anon_execute_violations()` = `[]`) — the dependency-digest flag is already remediated, **no migration**.
- Edited the two skill **sources** in the working tree (Item 1) and presented the rebuilt installable `.skill` files for Trevor to install.

**NOT a CC item:** the `rpc-qa-scorecard` artifact footer still says "incl. ~2.6 GB flowty_archive keep" (that archive was dropped 2026-05-24). It's an artifact (not in the repo) and editing it means reproducing a ~250-line live HTML for one cosmetic word — deliberately deferred to the next `rpc-surface-qa` run, which owns artifact-footer upkeep. Do not attempt from CC.

---

## Item 1 — Commit the skill-source changes + rebuild the `.skill` packages (highest priority, trivial)

Cowork edited the version-controlled skill sources but its sandboxed `zip` is blocked from finalizing archives, so the in-repo `.skill` packages were not rebuilt.

**Files (already in the working tree — `git status` shows them):**
- `docs/cowork-skills/rpc-data/SKILL.md` — **MODIFIED.** The canonical-edition predicate was changed from `external_id ~ '^[0-9]+:[0-9]+$'` to `external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`. *Why:* the old predicate silently excludes the ~1,775 Stage-B `::subID` SubEdition parallels — ≈16% of canonical TS editions (verified live: base `^[0-9]+:[0-9]+$` = 9,137 vs base+`::` = 10,888). Any analytics query using the skill verbatim was undercounting TS.
- `docs/cowork-skills/rpc-artifact-ops/SKILL.md` — **NEW.** A skill encoding the RPC Cowork-artifact build/brand/retire conventions (dark `#0c0c0e` theme, `--rpc-red #E03A2F` accent, uppercase display headings, mono numbers, the `callMcpTool` + `extractRows` data pattern, allowed CDN libs, durable-vs-ephemeral discipline). Added because building artifacts is a recurring task with hard-won conventions and there was no skill for it (the 2026-06-20 light-mode drift on two artifacts is the cost of its absence).

**Rebuild the installable packages** (each `.skill` is just `SKILL.md` zipped at the archive root — match the existing `rpc-handoff.skill` shape):
```
cd docs/cowork-skills/rpc-data && rm -f ../rpc-data.skill && zip -X ../rpc-data.skill SKILL.md && cd -
cd docs/cowork-skills/rpc-artifact-ops && zip -X ../rpc-artifact-ops.skill SKILL.md && cd -
unzip -l docs/cowork-skills/rpc-data.skill          # expect: SKILL.md (1 file, at root)
unzip -l docs/cowork-skills/rpc-artifact-ops.skill  # expect: SKILL.md (1 file, at root)
```
(The current in-repo `rpc-data.skill` is the stale 2026-05-30 build; `rpc-artifact-ops.skill` does not exist — Cowork removed the 0-byte stub its failed zip left behind.)

**Then commit + push to `main`.**

**Optional same-commit hygiene** (Cowork noticed, low priority): `rpc-cron-ops/` is an installed skill with **no** `rpc-cron-ops.skill` package in the repo; `rpc-fmv-audit/` is a source with no package that isn't installed. Build the missing `rpc-cron-ops.skill` and decide whether to keep or drop `rpc-fmv-audit`.

**Revert:** `git revert <commit>` (or restore the prior `rpc-data/SKILL.md` predicate and delete `rpc-artifact-ops/`).

**Verify:** `git rev-list --count origin/main..HEAD` → 0. Trevor separately installs the two presented `.skill` files via the **Save skill** button so the *installed* skills pick up the changes — this commit is repo version-control sync only.

---

## Item 2 — Fix the `refresh-special-serial-owners-mv` ok-flag false-negative

**File:** `app/api/cron/refresh-special-serial-owners-mv/route.ts` (exists, 2,598 bytes).

**Symptom:** the daily `ts-backfill-drain-serial-fmv-watch` scheduled task reports **red every day** ("MV-CRON-STALE fired all_ok=false") even though the MV refreshes fine — the watch's 06-21 run measured the refresh completing in ~125s with 6,778 current rows, then the route logging `ok=false`. It's a false-negative → daily alert fatigue, not a data problem.

**Likely root cause (let CC confirm against the actual file):** this is the carried `REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT` item. The route `maxDuration` is 120s but the `REFRESH MATERIALIZED VIEW CONCURRENTLY` runs ~125–135s, so the `after()` lambda is killed before it can `log_pipeline_run(ok=true)` — leaving the prior `ok=false`/no-log. Fix is likely: raise `maxDuration` (~200, ≤800 cap) so the refresh + log complete, and align the function `statement_timeout`; and/or correct the ok derivation so a completed refresh logs `ok=true`. (Prior partial attempts on 06-20 set the fn `statement_timeout` to 180–200s; confirm the route side matches.)

**Verify:** next scheduled run logs `ok=true` in `pipeline_runs` for `refresh-special-serial-owners-mv`; `detect_stalled_pipelines()` stays `[]`; the `ts-backfill-drain-serial-fmv-watch` task stops flagging it.

**Revert:** `git revert <commit>`.

---

## Item 3 — `next` 16.1.6 → 16.2.9 security bump (standing dependency-digest HIGH)

**Files:** `package.json` + `package-lock.json` (currently `"next": "16.1.6"`).

**Why:** clears 3 HIGH `next` CVEs including the App-Router **middleware/proxy-bypass** class that bears directly on RPC's `proxy.ts` site-lockdown auth gate, plus transitive postcss XSS. In the same PR pick up the transitive HIGH fixes (`defu`, `fast-uri`) and fixable moderates (`ws`, `viem`, `brace-expansion`) via `npm audit fix` where non-breaking. The 6 `@onflow/*` moderates have no fix upstream — monitor only.

**Verify:** `npx tsc --noEmit` clean + Vercel deploy READY + smoke; exercise the `proxy.ts` auth path specifically (login redirect + allow-list gate) since the CVEs touch middleware. Non-major bump, but it's a test-required change so it's CC/human, not autonomous.

**Revert:** `git revert` the bump commit.

---

## Item 4 — Log the audit (CLAUDE.md + ledger)

Cowork can't push and shouldn't edit `docs/overnight/ledger.md` from here (truncation hazard). Add a CLAUDE.md "Recent sessions" entry + a ledger line. Ready-to-paste:

> ### June 22, 2026 (Cowork) — asset audit: skills/scheduled-tasks/artifacts swept; 2 artifacts retired, flow-ecosystem prompt fixed, 2 skills updated
> Read-only audit of all Cowork assets, then executed every Cowork-native fix. **Artifacts:** 16 enumerated, 14 healthy/on-brand; retired `pack-drops-ev-check` + `rpc-ts-data-mission` to tombstones (both one-off snapshots whose missions closed — pack-drops POC superseded by `/insights/pack-sniper`; ts-data-mission's conflation de-blend closed 06-21). **Scheduled tasks:** 13 enabled all firing + producing real output (none broken/spent); `candy-solana-launch-watch` kept (verified 0 candy editions/sales — market not yet indexable); fixed the `rpc-flow-ecosystem-watch` prompt (abbreviated Pinnacle REST URL → verbatim, restoring an IPFS-resolver tripwire). **Skills:** fixed `rpc-data` canonical-edition predicate to include `::subID` parallels (`^[0-9]+:[0-9]+(::[0-9]+)?$`; old form dropped ~1,775 / ~16% of canonical TS editions); authored new `rpc-artifact-ops` skill. Verified `seed_topshot_sales_history_targets()` already service_role-only (no migration). CC handoff `docs/handoff-2026-06-22-cowork-asset-audit.md`: commit the 2 skill sources + rebuild `.skill` packages (Item 1), fix the `refresh-special-serial-owners-mv` ok-flag false-negative that reds the daily watch (Item 2), ship the standing `next` 16.2.9 security bump (Item 3).

---

## Guardrails (repeat every handoff)
- Direct-to-`main`, **no branches, no PRs.** If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via PowerShell `git` on Windows (Git Bash `git commit` can silently no-op). Re-verify: `git rev-list --count origin/main..HEAD` → 0.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s** (Item 2) — higher sends the deploy to ERROR invisibly.
- CRLF: full-file writes, not string-replace patches.
- **Your direct file inspection wins over this doc** on any disagreement — adapt to the actual file shape (e.g. the exact ok-flag logic in the MV route).

## Expected end state
2 skill sources committed + `.skill` packages rebuilt (Item 1); `refresh-special-serial-owners-mv` logs `ok=true` and the daily watch goes quiet (Item 2); `next` on 16.2.9 with the auth path smoke-verified (Item 3); audit logged (Item 4). Trevor installs the 2 presented `.skill` files via Save skill. After that, nothing from this audit remains open.
